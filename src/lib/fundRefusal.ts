/**
 * The brain's two refusals about the investors' money (lana-brain
 * lib/errors.ts, 24 Nov 2026):
 *
 *   409 NO_INVESTOR_BUDGET  no investor can fund this sale in its currency
 *                           (the body names the currency);
 *   503 FUND_UNREACHABLE    the investors' money could not be checked,
 *                           because Direct.Fund did not answer.
 *
 * Until then both came back as "Purchase processing failed", and a seller could
 * not tell an empty fund from a fault (GBP, 23 Nov 2026). The brain refuses
 * both at the allocation, on the sale and on the LANA preview, before anything
 * is recorded or sent.
 *
 * Nothing here decides a sale. It only picks the seller's words, from texts the
 * till already has in all 12 languages; the brain's own `error` is English.
 */

export const NO_INVESTOR_BUDGET = 'NO_INVESTOR_BUDGET';
export const FUND_UNREACHABLE = 'FUND_UNREACHABLE';

/**
 * The i18n key for one of these refusals, or null when the answer is something
 * else. The brain puts the code in `code` and English words in `error`, so only
 * `code` is read.
 */
export function fundRefusalKey(data: any): string | null {
  const code = typeof data?.code === 'string' ? data.code : null;
  if (code === NO_INVESTOR_BUDGET) return 'cash.noFunds';
  if (code === FUND_UNREACHABLE) return 'cash.purchaseFailed';
  return null;
}
