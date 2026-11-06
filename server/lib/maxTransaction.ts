/**
 * Effective per-transaction maximum for a business unit — one computation,
 * two consumers:
 *
 *  - GET /api/max-transaction (what the client displays), and
 *  - the /api/brain/purchase proxy, which since 2026-08 CLAMPS an over-limit
 *    CASH amount to this maximum instead of letting the client's checks be
 *    the only line of defense.
 *
 * The clamp is CASH-ONLY by design. The merchant limit (KIND 30902
 * max_tx_amount) applies exclusively to fiat: LANA is the uncapped rail, and
 * a LANA amount is baked into the client-signed transaction — rewriting it
 * server-side would desync the signed TX from the recorded purchase.
 */
import type Database from 'better-sqlite3';

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface EffectiveMax {
  maxAmount: number | null;
  source: 'merchant' | 'fund' | 'default' | 'none';
}

/**
 * min(merchant, fund, default) with the same precedence the endpoint has
 * always used: fund 0 is a real 0 (no budget available), null means unknown;
 * default 0 means "not configured".
 */
export function computeEffectiveMax(opts: {
  merchantLimit: number | null;
  fundLimit: number | null;
  defaultLimit: number;
}): EffectiveMax {
  const { merchantLimit, fundLimit, defaultLimit } = opts;

  let maxAmount: number | null = null;
  let source: EffectiveMax['source'] = 'none';

  if (fundLimit !== null && merchantLimit !== null) {
    maxAmount = Math.min(merchantLimit, fundLimit);
    source = maxAmount === merchantLimit ? 'merchant' : 'fund';
  } else if (fundLimit !== null) {
    maxAmount = fundLimit;
    source = 'fund';
  } else if (merchantLimit !== null) {
    maxAmount = merchantLimit;
    source = 'merchant';
  }

  if (defaultLimit > 0 && (maxAmount === null || defaultLimit < maxAmount)) {
    maxAmount = defaultLimit;
    source = 'default';
  }

  return { maxAmount, source };
}

export interface MaxTransactionInfo {
  unit_id: string;
  currency: string;
  max_amount: number | null;
  source: EffectiveMax['source'];
  merchant_limit: number | null;
  fund_limit: number | null;
  default_limit: number | null;
  fund_investors: number;
  fund_updated_at: string | null;
}

/**
 * The full component breakdown /api/max-transaction has always returned —
 * merchant limit from the KIND 30902 mirror, Direct-Fund capacity for the
 * currency, and the app-wide default.
 */
export function getMaxTransaction(
  db: Database.Database,
  unitId: string,
  fallbackCurrency: string,
): MaxTransactionInfo {
  const policy = db.prepare(
    'SELECT max_tx_amount, max_tx_currency FROM fee_policies WHERE unit_id = ?'
  ).get(unitId) as any;

  const merchantLimit = policy?.max_tx_amount ? parseFloat(policy.max_tx_amount) : null;
  const currency = (policy?.max_tx_currency || fallbackCurrency || 'EUR').toUpperCase();

  const capacity = db.prepare(
    'SELECT total_available, max_single_budget, investor_count, blocked_count, fetched_at FROM fund_capacity WHERE currency = ? ORDER BY id DESC LIMIT 1'
  ).get(currency) as any;

  // Max invoice = largest single budget (one invoice goes to one budget).
  // Capacity row with 0 means "no budget available" — a real 0, not null.
  const fundLimit = capacity
    ? (capacity.max_single_budget ?? capacity.total_available ?? 0)
    : null;

  const defaultMaxRow = db.prepare("SELECT value FROM app_settings WHERE key = 'default_max_tx_amount'").get() as any;
  const defaultLimit = defaultMaxRow ? parseFloat(defaultMaxRow.value) : 0;

  const { maxAmount, source } = computeEffectiveMax({ merchantLimit, fundLimit, defaultLimit });

  return {
    unit_id: unitId,
    currency,
    max_amount: maxAmount !== null ? round2(maxAmount) : null,
    source,
    merchant_limit: merchantLimit !== null ? round2(merchantLimit) : null,
    fund_limit: fundLimit !== null ? round2(fundLimit) : null,
    default_limit: defaultLimit > 0 ? defaultLimit : null,
    fund_investors: capacity?.investor_count || 0,
    fund_updated_at: capacity?.fetched_at || null,
  };
}

/**
 * Fold the merchant's remaining monthly CASH volume into the maximum — the
 * server-side twin of the client's effectiveMaxInvoice(). Only when the
 * request currency matches the quota currency; a cross-currency conversion is
 * the brain's job (KIND 38888 rates), same as the existing quota pre-flight.
 */
export function foldQuotaRemaining(
  maxAmount: number | null,
  unitRow: { quota_volume_limit?: number; quota_volume_used?: number; quota_currency?: string; currency?: string } | null | undefined,
  reqCurrency: string,
): number | null {
  if (!unitRow || !(Number(unitRow.quota_volume_limit) > 0)) return maxAmount;
  const quotaCurrency = String(unitRow.quota_currency || unitRow.currency || 'EUR').toUpperCase();
  if (String(reqCurrency || '').toUpperCase() !== quotaCurrency) return maxAmount;
  const remaining = Math.max(0, Number(unitRow.quota_volume_limit) - Number(unitRow.quota_volume_used || 0));
  return maxAmount === null ? remaining : Math.min(maxAmount, remaining);
}

/**
 * Fold the customer's remaining rolling-window allowance into the maximum —
 * sibling of foldQuotaRemaining. `customerRemaining` is limit − what this
 * customer already spent at this unit within the window (computed by the
 * caller from the brain's /customer-window answer). null = the window could
 * not be read (fail-open) → the max is left alone.
 */
export function foldCustomerWindow(
  maxAmount: number | null,
  customerRemaining: number | null,
): number | null {
  if (customerRemaining === null || !Number.isFinite(customerRemaining)) return maxAmount;
  return maxAmount === null ? customerRemaining : Math.min(maxAmount, customerRemaining);
}

/**
 * Admin-set rolling window length in days for the per-customer cash limit.
 * Lenient: a missing or mangled setting degrades to 1 day, never an error.
 */
export function readCustomerWindowDays(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'customer_window_days'").get() as any;
  const n = parseInt(String(row?.value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 90);
}

/**
 * The clamp itself. Above the max → the max, with a flag; at or below → as
 * given. A max of null (unknown/none) or <= 0 never clamps: zero capacity is
 * a BLOCK handled elsewhere — silently charging 0 would be worse than either.
 */
export function clampCashAmount(
  amount: number,
  maxAmount: number | null | undefined,
): { amount: number; adjusted: boolean } {
  if (
    maxAmount === null || maxAmount === undefined || !Number.isFinite(maxAmount) || maxAmount <= 0 ||
    !Number.isFinite(amount) || amount <= maxAmount
  ) {
    return { amount, adjusted: false };
  }
  return { amount: round2(maxAmount), adjusted: true };
}
