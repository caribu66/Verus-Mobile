import BN from 'bn.js';
import {
  KeyID,
  OPS,
  OptCCParams,
  TxDestination,
  SmartTransactionScript,
  Identity,
  IdentityScript,
  compile,
  fromBase58Check,
  getDataKey,
} from 'verus-typescript-primitives';
import { hash, hash160 } from 'verus-typescript-primitives/dist/utils/hash.js';

// VDXF offer index-key names (crosschainrpc.h). The daemon indexes an identity
// offer under two keys: what's offered (the identity) and what's wanted (currency).
export const IDENTITY_OFFER_BASE_KEY = getDataKey(
  'vrsc::system.exchange.identityoffer',
).id;
export const OFFER_FOR_CURRENCY_BASE_KEY = getDataKey(
  'vrsc::system.exchange.offerforcurrency',
).id;
export const CURRENCY_OFFER_BASE_KEY = getDataKey(
  'vrsc::system.exchange.currencyoffer',
).id;
export const OFFER_FOR_IDENTITY_BASE_KEY = getDataKey(
  'vrsc::system.exchange.offerforidentity',
).id;

/** crosschainrpc.h MIN_LISTING_DEPOSIT — dual-index currency bids must lock ≥ 1.0. */
export const MIN_LISTING_DEPOSIT_SATS = 100000000;

function hash160FromAddressOrBuffer(value) {
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : fromBase58Check(value).hash;
  if (bytes.length !== 20) {
    throw new Error(`Expected a 20-byte hash160 value, got ${bytes.length} bytes`);
  }
  return bytes;
}

function keyDestination(hash160Value) {
  return new TxDestination(new KeyID(hash160FromAddressOrBuffer(hash160Value)));
}

// GetConditionID(signatureKey, condition) = Hash160(SHA256D(condition || signatureKey)).
export function deriveOfferIndexKey(baseKey, condition) {
  return hash160(hash(hash160FromAddressOrBuffer(condition), hash160FromAddressOrBuffer(baseKey)));
}

/**
 * Native identity-offer output scriptPubKey (byte-identical to the daemon's
 * makeoffer). Master: OptCCParams(v3, EVAL_NONE, m=1, n=3) whose destinations
 * are the two offer index keys; params: the identity's own CC params. Spending
 * the offered identity's outpoint into this output LOCKS the identity into an
 * on-chain offer that `getoffers` indexes natively — no deposit, no OP_RETURN.
 */
export function buildIdentityOfferOutputScript(identityJson, offeredIdentityIAddr, forCurrencyIAddr) {
  const master = new OptCCParams({
    version: new BN(3),
    evalCode: new BN(0), // EVAL_NONE
    m: new BN(1),
    n: new BN(3),
    destinations: [
      keyDestination(deriveOfferIndexKey(OFFER_FOR_CURRENCY_BASE_KEY, forCurrencyIAddr)),
      keyDestination(deriveOfferIndexKey(IDENTITY_OFFER_BASE_KEY, offeredIdentityIAddr)),
    ],
    vData: [],
  });
  const idScript = IdentityScript.fromIdentity(Identity.fromJson(identityJson));
  return new SmartTransactionScript(master, idScript.paramsOptCC).toBuffer();
}

/**
 * Buy-side currency-bid commitment output (daemon makeoffer currency→identity).
 * Master destinations: offer-for-identity(target) + currency-offer(currency).
 * Params: EVAL_IDENTITY_COMMITMENT reclaimable by ownerHash (buyer).
 * Byte-identical to daemon MakeMofNCCScript(CCommitmentHash) + masterKeyDest;
 * validated against VRSCTEST bid tx 3b64cb66… (2026-08-05).
 */
export function buildCurrencyBidCommitmentScript(
  ownerAddressOrHash,
  targetIdentityIAddr,
  offeredCurrencyIAddr,
) {
  const forIdentityKey = deriveOfferIndexKey(OFFER_FOR_IDENTITY_BASE_KEY, targetIdentityIAddr);
  const currencyOfferKey = deriveOfferIndexKey(CURRENCY_OFFER_BASE_KEY, offeredCurrencyIAddr);
  const ownerHash = hash160FromAddressOrBuffer(ownerAddressOrHash);

  // Keep the proven deposit layout (same as verus-typescript-primitives
  // buildListingDepositScript) — OptCCParams encoding of EVAL_IDENTITY_COMMITMENT
  // with a zero CCommitmentHash is brittle across SDK versions.
  return Buffer.concat([
    Buffer.from('2f0403000202', 'hex'),
    Buffer.from([0x14]),
    forIdentityKey,
    Buffer.from([0x14]),
    currencyOfferKey,
    Buffer.from([0xcc]),
    Buffer.from('3b0403110101', 'hex'),
    Buffer.from([0x14]),
    ownerHash,
    Buffer.from([0x20]),
    Buffer.alloc(32),
    Buffer.from([0x75]),
  ]);
}

// Serialized offer object stored in the opret tx's OP_RETURN so `getoffers`
// reports the price + takeable partial. Header is 17 bytes (matches daemon
// GetOpRetChainOffer envelope); length is Bitcoin compact-size so identity
// bid partials (>252 bytes) fit.
const OFFER_OPRET_HEADER = Buffer.from('0500000003000201000000000100000000', 'hex');
const OFFER_OPRET_SUFFIX = Buffer.from('00000000', 'hex');

function compactSize(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 0xfe;
  b.writeUInt32LE(n, 1);
  return b;
}

export function buildOfferOpret(signedPartialHex) {
  const partial = Buffer.from(signedPartialHex, 'hex');
  return Buffer.concat([
    OFFER_OPRET_HEADER,
    compactSize(partial.length),
    partial,
    OFFER_OPRET_SUFFIX,
  ]);
}

export function buildOfferOpReturnScript(dataBuffer) {
  return compile([OPS.OP_RETURN, Buffer.from(dataBuffer)]);
}
