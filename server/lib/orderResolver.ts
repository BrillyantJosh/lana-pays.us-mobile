/**
 * Lana Online Shop — NORMATIVE order resolver (SPEC.md §8).
 *
 * Pure function, no I/O. This file is copied VERBATIM into mobile.lanapays.us
 * and every LanaRetail portal. Do NOT fork it — change SPEC.md first.
 *
 * Money truth is ONLY a brain-signed KIND 30933 that matches the order on
 * (unit_id, invoice_number), the buyer-pubkey prefix, the receipt_description
 * binding string, currency and the RECOMPUTED expected amount.
 *
 * SPEC v1.1.0 (cart): an order may carry several items of ONE shop. Each
 * item is priced by ITS OWN current listing (ResolverItem.listingPrice);
 * the v1.0 top-level listingPrice still works, for one-item orders only.
 */

export type PaymentState = 'unpaid' | 'paid' | 'amount_mismatch' | 'expired' | 'cancelled';

export interface ResolverItem {
  a: string;
  qty: number;
  unitPrice: string;
  currency: string;
  /**
   * Current merchant-signed price of THIS item's listing; null when the
   * listing is unknown. Left out (undefined) by v1.0 callers, which pass the
   * single top-level `listingPrice` instead.
   */
  listingPrice?: string | null;
  /** created_at of THIS item's current listing event; null when unknown. */
  listingCreatedAt?: number | null;
}

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
  /**
   * from ['item', addr, qty, saleUnit, unitPrice, cur] — SPEC v1.1: 1..30
   * lines of ONE shop, each listing at most once (v1.0: exactly one).
   */
  items: ResolverItem[];
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
  /**
   * v1.0 (single item): current merchant-signed listing price, null when
   * unknown. Honoured ONLY for a one-item order whose item carries no
   * listingPrice of its own — never applied to the items of a multi-item
   * order (each item has its own price).
   */
  listingPrice?: string | null;
  /** v1.0 (single item): created_at of the current listing event, null when unknown. Same rule. */
  listingCreatedAt?: number | null;
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

/**
 * The current listing price that counts for one item: its own when the
 * caller supplied one (null = listing unknown), else — only for a one-item
 * order — the v1.0 top-level price.
 */
function itemListingPrice(order: ResolverOrder, it: ResolverItem, legacyPrice: string | null | undefined): string | null {
  if (it.listingPrice !== undefined) return it.listingPrice;
  return order.items.length === 1 ? legacyPrice ?? null : null;
}

function itemListingCreatedAt(order: ResolverOrder, it: ResolverItem, legacyCreatedAt: number | null | undefined): number | null {
  if (it.listingCreatedAt !== undefined) return it.listingCreatedAt;
  return order.items.length === 1 ? legacyCreatedAt ?? null : null;
}

/**
 * expected = Σ(qty_i × unitPrice_i) + shipping(fee, free-from on the WHOLE
 * subtotal), where unitPrice_i is item i's own current listing price, or its
 * signed unit_price when that listing is unknown. Returns cents or null when
 * un-computable.
 */
export function expectedCents(
  order: ResolverOrder,
  unit: ResolverUnit,
  listingPrice: string | null = null,
): number | null {
  if (!order.items.length) return null;
  let sum = 0;
  for (const it of order.items) {
    const price = toCents(itemListingPrice(order, it, listingPrice) ?? it.unitPrice);
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

  const expCents = expectedCents(order, unit, listingPrice ?? null);
  const expected = expCents === null ? order.total : centsToString(expCents);
  const priceChanged = order.items.some((it) => {
    const at = itemListingCreatedAt(order, it, listingCreatedAt);
    return at !== null && at > order.createdAt;
  });

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
