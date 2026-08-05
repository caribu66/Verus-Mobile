/* eslint-disable react/prop-types */
/**
 * Buy-side (bid) confirm handler for ordinal 15 makeoffer buyParams.
 *
 * Builds the native currency→identity offer entirely on-device (same pattern as
 * sell listings): commitment output + SIGHASH_SINGLE|ANYONECANPAY partial +
 * opret. Does NOT call makeoffer on public VRPC — light APIs return
 * "Method not found".
 */
import {
  networks, ECPair, smarttxs, TransactionBuilder, address as baddress,
} from '@bitgo/utxo-lib';
import { Identity, IdentityScript } from 'verus-typescript-primitives';
import { requestPrivKey } from '../../../utils/auth/authBox';
import { VRPC } from '../../../utils/constants/intervalConstants';
import { createAlert } from '../../../actions/actions/alert/dispatchers/alert';
import VrpcProvider from '../../../utils/vrpc/vrpcInterface';
import { postMarketplaceCallback } from '../../../utils/marketplace/postMarketplaceCallback';
import { getSpendablePlainUtxos } from '../../../utils/marketplace/spendablePlainUtxos';
import {
  buildCurrencyBidCommitmentScript,
  buildOfferOpret,
  buildOfferOpReturnScript,
  MIN_LISTING_DEPOSIT_SATS,
} from '../../../utils/marketplace/onchainOfferScripts';
import { getMarketplaceActionError } from '../components/MarketplaceActionStatus';

const { getFundedTxBuilder } = smarttxs;

const OFFER_FEE_SATS = 10000;
const DUST_THRESHOLD_SATS = 1000;
const SAPLING_VERSION_GROUP_ID = 0x892f2085;
const SIGHASH_SINGLE_ANYONECANPAY = 131;

export const MAKE_BID_STEPS = [
  'Checking NFT target',
  'Unlocking wallet',
  'Building bid on-chain',
  'Broadcasting offer',
  'Returning to marketplace',
];

/**
 * @param {object} args
 * @param {object} args.buyParams
 * @param {object} args.coinObj
 * @param {object} args.request
 * @param {object} args.response
 * @param {number} args.detailIndex
 * @param {string|null} args.identityName
 * @param {Function} args.next
 * @param {React.MutableRefObject} args.broadcastedRef
 * @param {Function} args.setSubmitting
 * @param {Function} args.setSubmitStep
 * @param {Function} args.setSubmitError
 */
export async function confirmMarketplaceBuyOffer(args) {
  const {
    buyParams,
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

  if (!buyParams) return;
  setSubmitting(true);
  setSubmitError(null);

  const reportBid = async (payload) => {
    const responseURIs = (request && request.responseURIs) || [];
    if (responseURIs.length === 0) {
      throw new Error('Request has no response URI to return the offer to');
    }
    setSubmitStep(4);
    await postMarketplaceCallback(responseURIs[0].getUriString(), payload);
  };

  try {
    if (broadcastedRef.current) {
      await reportBid(broadcastedRef.current);
      createAlert(
        'Bid Submitted',
        `Your bid is on-chain.\n\nNFT: ${identityName || buyParams.targetIdentityId}\nAmount: ${buyParams.offeredAmountSats.toNumber() / 1e8} ${coinObj.id}`,
      );
      next(response, [detailIndex]);
      return;
    }

    const amountSats = buyParams.offeredAmountSats.toNumber();
    if (amountSats < MIN_LISTING_DEPOSIT_SATS) {
      throw new Error(
        `Bid must be at least ${MIN_LISTING_DEPOSIT_SATS / 1e8} ${coinObj.id} (on-chain listing deposit).`,
      );
    }

    setSubmitStep(0);
    const endpoint = VrpcProvider.getEndpoint(coinObj.system_id);
    const network = networks.verus;

    const idRes = await endpoint.getIdentity(buyParams.targetIdentityId);
    if (!idRes || !idRes.result || !idRes.result.identity) {
      throw new Error('Could not resolve target NFT identity');
    }
    const identityJson = idRes.result.identity;
    const targetIdentityIAddr = identityJson.identityaddress || buyParams.targetIdentityId;

    const infoRes = await endpoint.getInfo();
    const curHeight = infoRes && infoRes.result
      ? infoRes.result.longestchain || infoRes.result.blocks
      : 0;
    const expiryHeight = buyParams.expiryHeight.toNumber();
    if (expiryHeight <= curHeight) {
      throw new Error('This bid request has expired. Please create a new one.');
    }

    setSubmitStep(1);
    const spendingKey = await requestPrivKey(coinObj.id, VRPC);
    const keyPair = ECPair.fromWIF(spendingKey, network);
    const buyerAddress = keyPair.getAddress();

    const changeAddress = buyParams.changeDestination
      ? buyParams.changeDestination.getAddressString()
      : buyerAddress;

    const { utxos: spendable, hasPendingSpends } = await getSpendablePlainUtxos(
      endpoint,
      buyerAddress,
    );
    // Commitment (bid) + two fees (offer tx + opret) + dust for change.
    const needed = amountSats + (OFFER_FEE_SATS * 2) + DUST_THRESHOLD_SATS;
    const picked = [];
    let fundTotal = 0;
    for (let i = 0; i < spendable.length; i += 1) {
      picked.push(spendable[i]);
      fundTotal += spendable[i].satoshis;
      if (fundTotal >= needed) break;
    }
    if (fundTotal < needed) {
      throw new Error(
        `Insufficient ${coinObj.id} to place this bid; need ${needed / 1e8}, have ${fundTotal / 1e8}.${
          hasPendingSpends ? ' A previous transaction is still confirming — wait and retry.' : ''
        }`,
      );
    }

    setSubmitStep(2);
    const commitmentScript = buildCurrencyBidCommitmentScript(
      buyerAddress,
      targetIdentityIAddr,
      buyParams.offeredCurrencyId,
    );

    const otx = new TransactionBuilder(network);
    otx.setVersion(4);
    otx.setVersionGroupId(SAPLING_VERSION_GROUP_ID);
    otx.setExpiryHeight(expiryHeight);
    for (let i = 0; i < picked.length; i += 1) {
      otx.addInput(picked[i].txid, picked[i].outputIndex, 0xffffffff);
    }
    otx.addOutput(commitmentScript, amountSats);
    const offerChange = fundTotal - amountSats - OFFER_FEE_SATS;
    otx.addOutput(baddress.toOutputScript(changeAddress, network), offerChange);
    const offerPrev = picked.map((u) => Buffer.from(u.script, 'hex'));
    const offerFunded = getFundedTxBuilder(otx.buildIncomplete().toHex(), network, offerPrev);
    for (let i = 0; i < picked.length; i += 1) {
      offerFunded.sign(i, keyPair, null, 1, picked[i].satoshis);
    }
    const offerHex = offerFunded.build().toHex();
    const offerSend = await endpoint.sendRawTransaction(offerHex);
    if (!offerSend || !offerSend.result || typeof offerSend.result !== 'string') {
      throw new Error(
        (offerSend && offerSend.error && offerSend.error.message) || 'Bid commitment broadcast failed',
      );
    }
    const offerTxid = offerSend.result;

    // Takeable partial: spend commitment → identity definition for the buyer.
    // Seller completes by providing the identity input (accept-bid / takeoffer).
    const desiredIdentity = Identity.fromJson({
      ...identityJson,
      primaryaddresses: [buyerAddress],
      minimumsignatures: 1,
      revocationauthority: targetIdentityIAddr,
      recoveryauthority: targetIdentityIAddr,
    });
    const identityOutScript = IdentityScript.fromIdentity(desiredIdentity).toBuffer();

    const ptx = new TransactionBuilder(network);
    ptx.setVersion(4);
    ptx.setVersionGroupId(SAPLING_VERSION_GROUP_ID);
    ptx.setExpiryHeight(expiryHeight);
    ptx.addInput(offerTxid, 0, 0xffffffff);
    ptx.addOutput(identityOutScript, 0);
    const partialFunded = getFundedTxBuilder(
      ptx.buildIncomplete().toHex(),
      network,
      [commitmentScript],
    );
    partialFunded.sign(0, keyPair, null, SIGHASH_SINGLE_ANYONECANPAY, amountSats);
    const partialHex = partialFunded.buildIncomplete().toHex();

    setSubmitStep(3);
    const opret = buildOfferOpret(partialHex);
    const optx = new TransactionBuilder(network);
    optx.setVersion(4);
    optx.setVersionGroupId(SAPLING_VERSION_GROUP_ID);
    optx.setExpiryHeight(expiryHeight);
    optx.addInput(offerTxid, 1, 0xffffffff);
    optx.addOutput(
      baddress.toOutputScript(changeAddress, network),
      offerChange - OFFER_FEE_SATS,
    );
    optx.addOutput(buildOfferOpReturnScript(opret), 0);
    const opretPrev = [baddress.toOutputScript(changeAddress, network)];
    const opretFunded = getFundedTxBuilder(optx.buildIncomplete().toHex(), network, opretPrev);
    opretFunded.sign(0, keyPair, null, 1, offerChange);
    const opretHex = opretFunded.build().toHex();
    const opretSend = await endpoint.sendRawTransaction(opretHex);
    if (!opretSend || !opretSend.result || typeof opretSend.result !== 'string') {
      throw new Error(
        (opretSend && opretSend.error && opretSend.error.message)
          || 'Bid terms (opret) broadcast failed',
      );
    }

    const callbackPayload = {
      offerTxid,
      offerHex,
      opretTxid: opretSend.result,
      opretHex,
    };
    broadcastedRef.current = callbackPayload;

    await reportBid(callbackPayload);

    createAlert(
      'Bid Submitted',
      `Your bid is on-chain.\n\nNFT: ${identityName || buyParams.targetIdentityId}\nAmount: ${amountSats / 1e8} ${coinObj.id}`,
    );
    next(response, [detailIndex]);
  } catch (e) {
    console.error('[MarketplaceMakeOffer] buy confirm error:', e && e.message, e);
    const actionError = getMarketplaceActionError(e, 'Failed to submit marketplace bid');
    setSubmitError(actionError);
    createAlert(actionError.title, actionError.message);
    setSubmitting(false);
  }
}
