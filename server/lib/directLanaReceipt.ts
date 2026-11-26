/**
 * The receipt photo of a direct sale or a payment link (Brilly, 26 Nov 2026:
 * "the same procedure as LANA through the brain, only the money goes to the
 * shop's wallet"): the till takes the photo first, /api/receipt/upload keeps
 * it and answers where it is and the hash of its bytes, and the till sends
 * both with the sale. The same photo is never paid twice in one shop
 * (lib/directLanaStore.ts receiptTaken). It is the seller's evidence of the
 * purchase: it never goes into the signed plan nor the public KIND 9350 record.
 */
import { DirectLanaError } from './directLanaCore.js';

export interface DirectReceipt {
  url: string;
  /** SHA-256 of the photo's bytes, as the upload answered; null when the till had none. */
  hash: string | null;
}

/** The longest receipt address taken. */
export const MAX_RECEIPT_URL = 500;
const URL_SHAPE = /^https?:\/\/[^\s<>"'`\\]+$/;
const HASH_SHAPE = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/;

/**
 * What a request body says of its receipt: null when it names none, or the
 * receipt; RECEIPT_INVALID when what it names does not read (a hash without a
 * photo is not a receipt).
 */
export function receiptOfBody(body: { receipt_url?: unknown; receipt_hash?: unknown } | null | undefined): DirectReceipt | null {
  const url = body?.receipt_url;
  const hash = body?.receipt_hash;
  const none = (v: unknown) => v === undefined || v === null || v === '';
  if (none(url)) {
    if (!none(hash)) throw new DirectLanaError('RECEIPT_INVALID');
    return null;
  }
  if (typeof url !== 'string') throw new DirectLanaError('RECEIPT_INVALID');
  const u = url.trim();
  if (!u || u.length > MAX_RECEIPT_URL || CONTROL.test(u) || !URL_SHAPE.test(u)) throw new DirectLanaError('RECEIPT_INVALID');
  if (none(hash)) return { url: u, hash: null };
  if (typeof hash !== 'string' || !HASH_SHAPE.test(hash)) throw new DirectLanaError('RECEIPT_INVALID');
  return { url: u, hash };
}
