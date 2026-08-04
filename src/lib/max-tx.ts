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
