/**
 * Is a brain 409 DUPLICATE_* really OUR earlier attempt? — fail-closed.
 *
 * Why this exists. When a pay call is retried after a lost answer (process
 * died mid-pay, network dropped the response, the watchdog reopened a stuck
 * row), the brain refuses the retry with 409 DUPLICATE_INVOICE /
 * DUPLICATE_RECEIPT_IMAGE because the first attempt already went through. The
 * old code read every such 409 as "already paid" and marked the order paid.
 *
 * But the brain's duplicate rule matches only on unit + invoice number OR the
 * receipt photo hash — it never compares the amount. A DIFFERENT earlier sale
 * that merely carries the same number (a reused order number, a misread
 * receipt) gets the same 409, and the order was marked paid while no money
 * arrived for it (25 Oct 2026, Brilly: "Popravi").
 *
 * Since brain a4d6582 the 409 describes the purchase it collided with
 * (`original`). This module believes the 409 ONLY when that original is
 * provably this order's own earlier attempt:
 *
 *   - the 409 carries `original` (an older brain without it → not paid);
 *   - same unit_id, same currency;
 *   - same amount, within 0.01 in that currency;
 *   - a live status (created/processing/settled/partial — never failed or
 *     cancelled), and a payment_status the brain itself does not treat as
 *     "not done" (PaymentFailed, BroadcastUnverified);
 *   - the same invoice number this attempt sent (for POS and the gateway that
 *     is the merchant's order id; for payment links the seller's document
 *     number — a receipt-photo hit under ANOTHER number is another sale);
 *   - created no earlier than this order row itself (2 min clock allowance —
 *     brain and this app run on the same host): an earlier attempt of an
 *     order cannot predate the order.
 *
 * Anything else — including any field missing or malformed — is NOT paid. The
 * caller then leaves the order unpaid and tells the payer/seller why, exactly
 * like any other brain refusal. A wrong "not paid" is recoverable (the money
 * is on the brain, findable by the original id); a wrong "paid" hands over
 * goods for nothing.
 *
 * The same file lives in lana-pays-pos, lana-pays-gateway,
 * lana-pays.us-mobile and lanafund-me. Keep them identical.
 */

/** What the brain's 409 says about the purchase it collided with. */
export interface BrainDuplicateOriginal {
  id: string;
  unit_id: string;
  amount: number;
  currency: string;
  payment_type: string;
  status: string;
  payment_status: string | null;
  invoice_number: string | null;
  created_at: string;
  settled_at: string | null;
}

/** This order, as THIS attempt presented it to the brain. */
export interface DuplicateCheckOrder {
  unitId: string;
  currency: string;
  /** The amount this attempt sent to the brain. */
  amount: number;
  /** The invoice number this attempt sent to the brain. */
  invoiceNumber: string;
  /** The order row's created_at (SQLite datetime('now'), UTC). */
  createdAt: string;
}

export type DuplicateMismatch =
  | 'NO_ORIGINAL'
  | 'UNIT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'STATUS_NOT_LIVE'
  | 'PAYMENT_NOT_CONFIRMED'
  | 'INVOICE_MISMATCH'
  | 'ORIGINAL_PREDATES_ORDER';

/**
 * A flat shape on purpose (not a discriminated union): some of the four repos
 * compile without strictNullChecks, where `!verdict.paid` does not narrow.
 */
export interface DuplicateVerdict {
  paid: boolean;
  /** Why the 409 is NOT this order's own attempt; null when `paid`. */
  reason: DuplicateMismatch | null;
  /** The original as the 409 described it; null when it was missing or malformed. */
  original: BrainDuplicateOriginal | null;
}

export const DUPLICATE_CODES = ['DUPLICATE_INVOICE', 'DUPLICATE_RECEIPT_IMAGE'];

/** Brain statuses that only a persisted, not-abandoned purchase has. */
const LIVE_STATUSES = new Set(['created', 'processing', 'settled', 'partial']);
/** payment_status values the brain itself treats as "the money did not (provably) move". */
const NOT_DONE_PAYMENT = new Set(['PaymentFailed', 'BroadcastUnverified']);
/** Amount tolerance, in the currency's units. */
const AMOUNT_TOLERANCE = 0.01;
/** Clock allowance between this app's and the brain's datetime('now'). */
const CLOCK_ALLOWANCE_MS = 2 * 60 * 1000;

/** True when a brain answer is a receipt-dedup 409. */
export function isBrainDuplicate(status: number, body: any): boolean {
  return status === 409 && DUPLICATE_CODES.includes(body?.error);
}

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO → epoch ms; NaN when not a date. */
export function parseUtc(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  const s = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) return NaN;
  const iso = s.replace(' ', 'T');
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
}

const isStr = (v: unknown): v is string => typeof v === 'string';

/** The `original` of a 409 body, or null when it is missing or malformed. */
export function readOriginal(body: any): BrainDuplicateOriginal | null {
  const o = body?.original;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (!isStr(o.id) || !o.id.trim()) return null;
  if (!isStr(o.unit_id) || !isStr(o.currency) || !isStr(o.status) || !isStr(o.created_at)) return null;
  if (typeof o.amount !== 'number' || !Number.isFinite(o.amount)) return null;
  if (!isStr(o.payment_status)) return null;
  if (o.invoice_number !== null && !isStr(o.invoice_number)) return null;
  return {
    id: o.id,
    unit_id: o.unit_id,
    amount: o.amount,
    currency: o.currency,
    payment_type: isStr(o.payment_type) ? o.payment_type : '',
    status: o.status,
    payment_status: o.payment_status,
    invoice_number: o.invoice_number,
    created_at: o.created_at,
    settled_at: isStr(o.settled_at) ? o.settled_at : null,
  };
}

/** Decide whether a brain 409 DUPLICATE_* proves THIS order is already paid. */
export function verifyBrainDuplicate(body: any, order: DuplicateCheckOrder): DuplicateVerdict {
  const original = readOriginal(body);
  const no = (reason: DuplicateMismatch): DuplicateVerdict => ({ paid: false, reason, original });
  if (!original) return no('NO_ORIGINAL');

  if (original.unit_id.trim() !== String(order.unitId || '').trim() || !original.unit_id.trim()) {
    return no('UNIT_MISMATCH');
  }
  if (original.currency.trim().toUpperCase() !== String(order.currency || '').trim().toUpperCase()) {
    return no('CURRENCY_MISMATCH');
  }
  const amount = Number(order.amount);
  if (!Number.isFinite(amount) || Math.abs(original.amount - amount) > AMOUNT_TOLERANCE + 1e-9) {
    return no('AMOUNT_MISMATCH');
  }
  if (!LIVE_STATUSES.has(original.status)) return no('STATUS_NOT_LIVE');
  if (NOT_DONE_PAYMENT.has(original.payment_status || '')) return no('PAYMENT_NOT_CONFIRMED');

  const ours = String(order.invoiceNumber || '').trim();
  if (!ours || (original.invoice_number || '').trim() !== ours) return no('INVOICE_MISMATCH');

  const originalAt = parseUtc(original.created_at);
  const orderAt = parseUtc(order.createdAt);
  if (!Number.isFinite(originalAt) || !Number.isFinite(orderAt) || originalAt < orderAt - CLOCK_ALLOWANCE_MS) {
    return no('ORIGINAL_PREDATES_ORDER');
  }
  return { paid: true, reason: null, original };
}

/** Plain words for the seller/payer, per mismatch. Never names the other sale's buyer. */
export function duplicateMismatchMessage(reason: DuplicateMismatch): string {
  const lead = 'The payment service refused this payment as a duplicate of an earlier purchase';
  const tail = 'This attempt was not recorded and moved no money; the order stays unpaid. Check the invoice/order number.';
  switch (reason) {
    case 'NO_ORIGINAL':
      return `${lead}, but did not say which one, so it cannot be confirmed as this order. ${tail}`;
    case 'AMOUNT_MISMATCH':
      return `${lead} with the same number but a different amount. ${tail}`;
    case 'UNIT_MISMATCH':
    case 'CURRENCY_MISMATCH':
    case 'INVOICE_MISMATCH':
      return `${lead} that is not this order. ${tail}`;
    case 'STATUS_NOT_LIVE':
    case 'PAYMENT_NOT_CONFIRMED':
      return `${lead} whose payment is not confirmed. ${tail}`;
    case 'ORIGINAL_PREDATES_ORDER':
      return `${lead} made before this order existed, so it is a different sale. ${tail}`;
  }
}
