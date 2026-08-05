/* eslint-disable react/prop-types */
/**
 * Seller accept-bid path for ordinal 16 takeoffer with bidOfferTxid.
 *
 * Completes the buyer's on-chain bid partial locally (no takeoffer RPC):
 *   - keep buyer-signed commitment input + identity-to-buyer output
 *   - add the NFT identity input (must be free of any sell listing)
 *   - pay bid amount to seller, fund fee from plain UTXOs
 *   - sign only seller inputs; broadcast; callback
 */
import {
  networks, ECPair, TransactionBuilder, Transaction, address as baddress,
} from '@bitgo/utxo-lib';
import { GetOffersRequest } from 'verus-typescript-primitives';
import { requestPrivKey } from '../../../utils/auth/authBox';
import { VRPC } from '../../../utils/constants/intervalConstants';
import { createAlert } from '../../../actions/actions/alert/dispatchers/alert';
import VrpcProvider from '../../../utils/vrpc/vrpcInterface';
import { postMarketplaceCallback } from '../../../utils/marketplace/postMarketplaceCallback';
import { getSpendablePlainUtxos } from '../../../utils/marketplace/spendablePlainUtxos';
import { getMarketplaceActionError } from '../components/MarketplaceActionStatus';

const TAKEOFFER_FEE_SATS = 10000;
const DUST_THRESHOLD_SATS = 1000;

export const ACCEPT_BID_STEPS = [
  'Checking bid',
  'Unlocking wallet',
  'Building takeoffer',
  'Broadcasting settlement',
  'Returning to marketplace',
];

function findBidPartialHex(offersResult, bidTxid) {
  if (!offersResult || typeof offersResult !== 'object') return null;
  const buckets = Object.values(offersResult);
  for (let i = 0; i < buckets.length; i += 1) {
    const arr = buckets[i];
    if (!Array.isArray(arr)) continue;
    for (let j = 0; j < arr.length; j += 1) {
      const entry = arr[j];
      const offer = (entry && entry.offer) || entry;
      if (!offer) continue;
      if (offer.txid === bidTxid && typeof offer.tx === 'string' && offer.tx.length > 0) {
        return offer.tx;
      }
    }
  }
  return null;
}

export async function confirmMarketplaceAcceptBid(args) {
  const {
    takeOfferRequest,
    offerParams,
    coinObj,
    request,
    response,
    detailIndex,
    identityName,
    next,
    broadcastedRef,
    setSubmitting,
    setSubmitStep,
    setSubmitError,
  } = args;

  if (!offerParams || !takeOfferRequest || !takeOfferRequest.containsBidOfferTxid
    || !takeOfferRequest.containsBidOfferTxid()) {
    return;
  }

  const bidTxid = takeOfferRequest.bidOfferTxid;
  setSubmitting(true);
  setSubmitError(null);

  const report = async (payload) => {
    const responseURIs = (request && request.responseURIs) || [];
    if (responseURIs.length === 0) {
      throw new Error('Request has no response URI');
    }
    setSubmitStep(4);
    await postMarketplaceCallback(responseURIs[0].getUriString(), payload);
  };

  try {
    if (broadcastedRef.current) {
      await report(broadcastedRef.current);
      createAlert(
        'Bid Accepted',
        `Settlement broadcast.\n\nNFT: ${identityName || offerParams.offeredIdentityId}\nPrice: ${offerParams.forAmountSats.toNumber() / 1e8} ${coinObj.id}`,
      );
      next(response, [detailIndex]);
      return;
    }

    setSubmitStep(0);
    const endpoint = VrpcProvider.getEndpoint(coinObj.system_id);
    const network = networks.verus;
    const amountSats = offerParams.forAmountSats.toNumber();
    const payoutAddress = offerParams.payoutDestination.getAddressString();

    // Fetch the takeable bid partial from getoffers (withtx).
    const offersRes = await endpoint.request(
      new GetOffersRequest(coinObj.id, offerParams.offeredIdentityId, false, true),
    );
    const offersPayload = (offersRes && offersRes.result) || offersRes;
    const partialHex = findBidPartialHex(offersPayload, bidTxid);
    if (!partialHex) {
      throw new Error(
        'Bid partial not found on-chain yet. Wait for 1 confirmation and retry, or ensure the listing was closed first.',
      );
    }

    const partialTx = Transaction.fromHex(partialHex, network);
    if (partialTx.ins.length !== 1 || partialTx.outs.length !== 1) {
      throw new Error('Malformed bid partial transaction');
    }

    const idRes = await endpoint.getIdentity(offerParams.offeredIdentityId);
    if (!idRes || !idRes.result || !idRes.result.identity) {
      throw new Error('Could not resolve NFT identity for accept');
    }
    const { txid: idTxid, vout: idVout } = idRes.result;
    if (idTxid == null || idVout == null) {
      throw new Error('NFT has no locatable definition output (still listed?)');
    }
    const idTxRes = await endpoint.getRawTransaction(idTxid, 1);
    if (!idTxRes || !idTxRes.result || !idTxRes.result.vout || !idTxRes.result.vout[idVout]) {
      throw new Error('Could not fetch NFT definition transaction');
    }
    const idOutput = idTxRes.result.vout[idVout];
    const idScript = Buffer.from(idOutput.scriptPubKey.hex, 'hex');
    const idValueSats = Math.round((idOutput.value || 0) * 1e8);

    const infoRes = await endpoint.getInfo();
    const curHeight = infoRes && infoRes.result
      ? infoRes.result.longestchain || infoRes.result.blocks
      : 0;
    const expiryHeight = offerParams.expiryHeight.toNumber();
    if (expiryHeight > 0 && expiryHeight <= curHeight) {
      throw new Error('This bid has expired');
    }

    setSubmitStep(1);
    const spendingKey = await requestPrivKey(coinObj.id, VRPC);
    const keyPair = ECPair.fromWIF(spendingKey, network);
    const sellerAddress = keyPair.getAddress();

    // Fee UTXOs — commitment value pays the seller; fee needs separate funds.
    const { utxos, hasPendingSpends } = await getSpendablePlainUtxos(endpoint, sellerAddress);
    const needed = TAKEOFFER_FEE_SATS + DUST_THRESHOLD_SATS;
    const picked = [];
    let fundTotal = 0;
    for (let i = 0; i < utxos.length; i += 1) {
      picked.push(utxos[i]);
      fundTotal += utxos[i].satoshis;
      if (fundTotal >= needed) break;
    }
    if (fundTotal < TAKEOFFER_FEE_SATS) {
      throw new Error(
        hasPendingSpends
          ? 'Insufficient confirmed funds for the accept fee — wait for pending txs to confirm.'
          : `Need ~${TAKEOFFER_FEE_SATS / 1e8} ${coinObj.id} for network fee to accept this bid`,
      );
    }

    setSubmitStep(2);
    // Keep buyer-signed vin[0]/vout[0]; add identity input + seller payout + fee/change.
    const txb = TransactionBuilder.fromTransaction(partialTx, network);
    txb.addInput(idTxid, idVout, 0xffffffff, idScript);
    for (let i = 0; i < picked.length; i += 1) {
      const u = picked[i];
      txb.addInput(u.txid, u.outputIndex, 0xffffffff, Buffer.from(u.script, 'hex'));
    }
    txb.addOutput(baddress.toOutputScript(payoutAddress, network), amountSats);
    const changeSats = fundTotal - TAKEOFFER_FEE_SATS;
    if (changeSats >= DUST_THRESHOLD_SATS) {
      txb.addOutput(baddress.toOutputScript(sellerAddress, network), changeSats);
    }

    setSubmitStep(3);
    // vin[0] is the buyer commitment — leave its scriptSig alone.
    // vin[1] = identity; vin[2..] = fee inputs.
    txb.sign(1, keyPair, null, Transaction.SIGHASH_ALL, idValueSats);
    for (let i = 0; i < picked.length; i += 1) {
      txb.sign(i + 2, keyPair, null, Transaction.SIGHASH_ALL, picked[i].satoshis);
    }

    const completedHex = txb.build().toHex();
    const sendRes = await endpoint.sendRawTransaction(completedHex);
    if (!sendRes || !sendRes.result || typeof sendRes.result !== 'string') {
      throw new Error(
        (sendRes && sendRes.error && sendRes.error.message) || 'Accept-bid broadcast failed',
      );
    }
    const completedTxid = sendRes.result;
    const callbackPayload = { completedTxid, completedHex };
    broadcastedRef.current = callbackPayload;
    await report(callbackPayload);

    createAlert(
      'Bid Accepted',
      `Settlement broadcast.\n\nNFT: ${identityName || offerParams.offeredIdentityId}\nPrice: ${amountSats / 1e8} ${coinObj.id}`,
    );
    next(response, [detailIndex]);
  } catch (e) {
    console.error('[MarketplaceTakeOffer] accept-bid error:', e && e.message, e);
    const actionError = getMarketplaceActionError(e, 'Failed to accept marketplace bid');
    setSubmitError(actionError);
    createAlert(actionError.title, actionError.message);
    setSubmitting(false);
  }
}
