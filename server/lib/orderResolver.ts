/**
 * Lana Online Shop — NORMATIVE order resolver (SPEC.md §8).
 *
 * Pure function, no I/O. This file is copied VERBATIM into mobile.lanapays.us
 * and every LanaRetail portal. Do NOT fork it — change SPEC.md first.
 *
 * Money truth is ONLY a brain-signed KIND 30933 that matches the order on
 * (unit_id, invoice_number), the buyer-pubkey prefix, the receipt_description
 * binding string, currency and the RECOMPUTED expected amount.
 */

export type PaymentState = 'unpaid' | 'paid' | 'amount_mismatch' | 'expired' | 'cancelled';

export interface ResolverOrder {
  /** 36520 `d` tag == order id */
  d: string;
  /** 36520 event pubkey (buyer ephemeral key) */
  pubkey: string;
  createdAt: number;
  unitId: string;
  /** 'placed' | 'cancelled' */
  status: string;
  /** 'shipping' | 'pickup' */
  fulfillment: string;
  /** from ['item', addr, qty, saleUnit, unitPrice, cur] — v1 exactly one */
  items: Array<{ a: string; qty: number; unitPrice: string; currency: string }>;
  /** from ['total', amount, cur] */
  total: string;
  currency: string;
  payBy: number;
}

export interface ResolverPurchase {
  /** 30933 event pubkey (must be a trusted signer) */
  pubkey: string;
  eventId: string;
  createdAt: number;
  /** 30933 `d` tag == brain transaction id */
  txId: string;
  unitId: string;
  invoiceNumber: string;
  receiptDescription: string;
  amount: string;
  currency: string;
  lanaAmount: string;
  paymentType: string;
  status: string;
  customerHex: string;
  txHash?: string;
}

export interface ResolverFulfillment {
  pubkey: string;
  createdAt: number;
  status: string;
  paymentRef?: string;
  carrier?: string;
  tracking?: string;
}

export interface ResolverUnit {
  ownerHex: string;
  staffHexes: string[];
  currency: string;
  /** decimal string, '0.00' when absent */
  shippingFee: string;
  /** optional free-shipping threshold, decimal string */
  freeShippingFrom?: string | null;
}

export interface ResolverInput {
  order: ResolverOrder;
  purchases: ResolverPurchase[];
  fulfillment: ResolverFulfillment | null;
  unit: ResolverUnit;
  /** current merchant-signed listing price for the (single) item, null when unknown */
  listingPrice: string | null;
  /** created_at of the current listing event, null when unknown */
  listingCreatedAt: number | null;
  trustedSigners: Set<string>;
  now: number;
}

export interface ResolverResult {
  paymentState: PaymentState;
  paidBy: {
    txId: string;
    eventId: string;
    customerHex: string;
    amount: string;
    lanaAmount: string;
    txHash?: string;
  } | null;
  /** expected fiat amount, 2-decimal string */
  expected: string;
  priceChanged: boolean;
  /** latest valid fulfillment status, else paymentState */
  effectiveStatus: string;
  /** paid AND not yet shipped/delivered/completed/rejected/refunded */
  pending: boolean;
}

const TERMINAL_FULFILLMENT = new Set(['shipped', 'delivered', 'completed', 'rejected', 'refunded']);
const NOT_PAID_STATUS = new Set(['cancelled', 'failed']);

/** Integer-cents parse of a decimal string; NaN-safe (returns null). */
export function toCents(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}

export function centsToString(c: number): string {
  const sign = c < 0 ? '-' : '';
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** The binding string the broker puts into the gateway session description. */
export function bindingString(buyerPubkey: string, orderId: string): string {
  return `36520:${buyerPubkey}:${orderId}`;
}

/** Order id shape: <buyer_pubkey[0:24]>.<32 hex> */
export const ORDER_ID_RE = /^[0-9a-f]{24}\.[0-9a-f]{32}$/;

export function orderIdMatchesPubkey(orderId: string, pubkey: string): boolean {
  return ORDER_ID_RE.test(orderId) && orderId.slice(0, 24) === String(pubkey || '').slice(0, 24);
}

/** expected = Σ(qty × unitPrice) + shipping(fee, free-from). Returns cents or null when un-computable. */
export function expectedCents(
  order: ResolverOrder,
  unit: ResolverUnit,
  listingPrice: string | null,
): number | null {
  if (!order.items.length) return null;
  let sum = 0;
  for (const it of order.items) {
    const price = toCents(listingPrice ?? it.unitPrice);
    if (price === null || !Number.isInteger(it.qty) || it.qty <= 0) return null;
    sum += price * it.qty;
  }
  if (order.fulfillment === 'shipping') {
    const fee = toCents(unit.shippingFee || '0.00') ?? 0;
    const freeFrom = toCents(unit.freeShippingFrom ?? null);
    if (!(freeFrom !== null && sum >= freeFrom)) sum += fee;
  }
  return sum;
}

export function resolveOrder(input: ResolverInput): ResolverResult {
  const { order, purchases, fulfillment, unit, listingPrice, listingCreatedAt, trustedSigners, now } = input;
  const bind = bindingString(order.pubkey, order.d);
  const prefixOk = orderIdMatchesPubkey(order.d, order.pubkey);

  const expCents = expectedCents(order, unit, listingPrice);
  const expected = expCents === null ? order.total : centsToString(expCents);
  const priceChanged = listingCreatedAt !== null && listingCreatedAt > order.createdAt;

  // Candidate 30933: newest that satisfies every identity/binding rule.
  const candidates = purchases.filter((e) =>
    trustedSigners.has(e.pubkey) &&
    !NOT_PAID_STATUS.has(e.status) &&
    e.paymentType === 'lana' &&
    e.unitId === order.unitId &&
    e.invoiceNumber === order.d &&
    prefixOk &&
    (e.receiptDescription || '').includes(bind),
  ).sort((a, b) => b.createdAt - a.createdAt);
  const e = candidates[0] || null;

  let paymentState: PaymentState;
  let paidBy: ResolverResult['paidBy'] = null;
  if (e) {
    const amtCents = toCents(e.amount);
    const amountOk = expCents !== null && amtCents !== null && Math.abs(amtCents - expCents) === 0;
    const currencyOk = e.currency === unit.currency && order.currency === unit.currency;
    paidBy = { txId: e.txId, eventId: e.eventId, customerHex: e.customerHex, amount: e.amount, lanaAmount: e.lanaAmount, txHash: e.txHash };
    paymentState = amountOk && currencyOk ? 'paid' : 'amount_mismatch';
  } else if (order.status === 'cancelled') {
    paymentState = 'cancelled';
  } else {
    paymentState = now > order.payBy ? 'expired' : 'unpaid';
  }

  const signerOk = !!fulfillment && (fulfillment.pubkey === unit.ownerHex || unit.staffHexes.includes(fulfillment.pubkey));
  const effectiveStatus = signerOk && fulfillment ? fulfillment.status : paymentState;
  const pending = paymentState === 'paid' && !TERMINAL_FULFILLMENT.has(effectiveStatus);

  return { paymentState, paidBy, expected, priceChanged, effectiveStatus, pending };
}
