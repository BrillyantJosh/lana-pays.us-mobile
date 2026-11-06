/**
 * Cash amount clamping — client side.
 *
 * The rule (owner, 2026-08-03): a CASH invoice above the effective
 * per-transaction maximum is ADJUSTED down to the maximum and the merchant is
 * merely told about it — never blocked. Adjust at receipt-scan time, and again
 * at submit time even if the merchant retyped a higher figure. The proxy
 * repeats the clamp server-side as the authoritative backstop.
 *
 * LANA is deliberately NOT clamped anywhere: the merchant limit is cash-only,
 * and a LANA amount is baked into the client-signed transaction.
 */

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Parse a human-typed amount. Preserves the existing convention (a single
 * separator is THE decimal separator: '500,5' → 500.5), and additionally
 * handles thousands-grouped input: when both ',' and '.' appear, the LAST one
 * is the decimal separator ('1.000,50' → 1000.5, '1,000.50' → 1000.5).
 */
export function parseAmountInput(raw: string): number {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = lastComma > lastDot ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    return parseFloat(s.split(thou).join('').replace(dec, '.'));
  }
  return parseFloat(s.replace(',', '.'));
}

/**
 * Above the max → the max, flagged; at or below → as given. A max of
 * null/undefined (no limit known) or <= 0 never clamps — zero capacity is a
 * BLOCK handled by the button predicates, not something to charge 0 for.
 */
export function clampCashAmount(
  amount: number,
  maxTx: number | null | undefined,
): { amount: number; adjusted: boolean } {
  if (
    maxTx === null || maxTx === undefined || !Number.isFinite(maxTx) || maxTx <= 0 ||
    !Number.isFinite(amount) || amount <= maxTx
  ) {
    return { amount, adjusted: false };
  }
  return { amount: round2(maxTx), adjusted: true };
}

/** The effective CASH maximum Index.tsx publishes (quota-capped min). */
export function getCashMaxTx(): number | null {
  const v = (window as any).__maxTransactionAmount;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The KIND 30903 fields of the selected unit, as Index.tsx publishes it. */
interface UnitQuota {
  currency?: string;
  quota_currency?: string;
  quota_volume_limit?: number;
  quota_volume_used?: number;
  quota_tx_limit?: number;
  quota_tx_used?: number;
}

/**
 * Why cash cannot be taken at all right now, or null if it can.
 *
 * The month comes first. The maximum Index.tsx publishes reads 0 when the month's
 * volume or count is used up as well as when no investor funds are available, and
 * telling a shop at its monthly limit that there are no investor funds is wrong.
 * A volume in another currency cannot be compared here and says nothing, the same
 * as in effectiveMaxInvoice. The same customer's window is not among these: no
 * customer has been scanned yet, so the server answers for it when the sale is sent.
 */
export function cashBlockReason(
  unit: UnitQuota | null | undefined,
  maxTx: number | null,
): 'month' | 'funds' | null {
  const txLimit = unit?.quota_tx_limit ?? 0;
  if (txLimit > 0 && (unit?.quota_tx_used ?? 0) >= txLimit) return 'month';
  const volLimit = unit?.quota_volume_limit ?? 0;
  if (volLimit > 0 && (unit?.quota_currency || unit?.currency) === unit?.currency
      && round2(Math.max(0, volLimit - (unit?.quota_volume_used ?? 0))) <= 0) return 'month';
  return maxTx !== null && maxTx <= 0 ? 'funds' : null;
}
