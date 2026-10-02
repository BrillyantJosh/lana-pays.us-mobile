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
 *
 * SPEC v1.1.0 §8 step 5a (settled): a 'paid' verdict the caller already
 * reached for exactly this 36520 event is not revoked by a later change of a
 * listing price or of the shop's shipping fee.
 *
 * SPEC v1.1.1 (review 2 Oct 2026) — fail-closed. The buyer holds the key that
 * signs the 36520 and may publish a replacement with the same d at any time,
 * so no number in it is ever money:
 *  - an item whose listing is unknown makes the expected amount
 *    uncomputable, and an uncomputable order is never 'paid' by step 5;
 *    there is no fallback to the buyer-signed unit_price;
 *  - only the NEWEST version of a 30933 (NIP-33: per signer and d = tx id)
 *    counts, so the brain's cancellation republish un-pays the order;
 *  - paid = status 'processing' | 'settled' (SPEC §7), nothing else;
 *  - an unknown unit (the caller passes an empty ownerHex / currency) is
 *    never paid, pinned (step 5a) or not.
 *
 * SPEC v1.1.2 (second review 2 Oct 2026):
 *  - step 5 pays only an order whose OWN numbers are the merchant's: every
 *    item's unit_price is its listing price, shipping (when the caller
 *    passes it) and total are the recomputed ones. A 'paid' order can then
 *    never show the merchant a buyer-made total, line price or refund amount;
 *  - a listing may price an item only when it is usable for this order
 *    (usableListingPrice: price > 0, the shop's currency, the order's shop);
 *  - a pickup order of a shop that does not offer pickup is not computable;
 *  - two versions of a 30933 in the same second: the not-paid one counts
 *    (fail-closed — the brain republishes a cancellation, never a payment);
 *  - the step-5a pin names the PURCHASE (tx id + amount), not one event id:
 *    the brain re-signs a 30933 when it retries a publish, and that newer
 *    copy of the same payment keeps the order settled.
 */

export type PaymentState = 'unpaid' | 'paid' | 'amount_mismatch' | 'expired' | 'cancelled';

export interface ResolverItem {
  a: string;
  qty: number;
  unitPrice: string;
  currency: string;
  /**
   * Current merchant-signed price of THIS item's listing; null when the
   * listing is unknown or not usable for this order (usableListingPrice) —
   * then the order's expected amount cannot be computed and step 5 never
   * says 'paid' (the buyer-signed unitPrice is NEVER used as money). A
   * caller may pass instead the last merchant-signed price it saw for this
   * listing while judging this very 36520 event (SPEC §8 step 2), and one
   * that already checked this line against the listing (the broker, at
   * order time) passes that checked price. Left out (undefined) by v1.0
   * callers, which pass the single top-level `listingPrice` instead.
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
  /** from ['shipping', fee, cur]; when given, step 5 also requires it to be the recomputed fee */
  shipping?: string;
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

/**
 * The shop the order's `a` tag names. A caller that cannot find it passes
 * ownerHex '' and currency '' — nothing is then paid, pinned or not.
 */
export interface ResolverUnit {
  ownerHex: string;
  staffHexes: string[];
  currency: string;
  /** decimal string, '0.00' when absent */
  shippingFee: string;
  /** optional free-shipping threshold, decimal string */
  freeShippingFrom?: string | null;
  /**
   * 30901 `online_shop_pickup` === 'true'. A pickup order is computable only
   * when this is true (absent = not offered, SPEC §6 — fail-closed).
   */
  pickup?: boolean;
}

/**
 * SPEC §8 step 5a — the purchase a caller already judged 'paid' for EXACTLY
 * this 36520 event: the 30933 `d` (brain tx id) and the amount it carried.
 */
export interface SettledPurchase {
  txId: string;
  amount: string;
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
  /**
   * SPEC §8 step 5a — the purchase this caller already judged 'paid' for
   * EXACTLY this 36520 event (tx id + amount). The caller stores the order's
   * event id with that verdict and passes null as soon as the stored order
   * event is a different one (the buyer may replace a 36520 at will, and a
   * replaced order is judged afresh). While the newest version of that same
   * purchase is still the candidate — paid status, same amount — the order
   * stays 'paid' even if a listing price, the shipping fee or the pickup
   * offer has changed since: the buyer paid what was asked when the order
   * was placed. A cancelled or failed version, another amount or another
   * purchase is judged afresh, and an unknown unit is never paid. The pin
   * does hold when a listing is unknown later: step 5 only pays an order
   * whose every listing is known.
   */
  settledPurchase?: SettledPurchase | null;
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
  /** expected fiat amount, 2-decimal string; '' when it cannot be computed (a listing is unknown) */
  expected: string;
  priceChanged: boolean;
  /** latest valid fulfillment status, else paymentState */
  effectiveStatus: string;
  /** paid AND not yet shipped/delivered/completed/rejected/refunded */
  pending: boolean;
}

const TERMINAL_FULFILLMENT = new Set(['shipped', 'delivered', 'completed', 'rejected', 'refunded']);
/** SPEC §7: the only 30933 statuses that are money. The brain publishes 'processing' and, on a cancel, 'cancelled'. */
const PAID_STATUS = new Set(['processing', 'settled']);

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

/** A merchant-signed listing as a caller found it (SPEC §8 step 2). */
export interface ListingPriceSource {
  price: string | null | undefined;
  /** currency of the listing's price */
  currency: string | null | undefined;
  /** the listing's `a` tag: '30901:<owner>:<unit_id>' (absent = names no shop) */
  unitRef?: string | null;
}

/**
 * SPEC §8 step 2 — the price a merchant-signed listing may give an item of
 * THIS order, or null (= unknown): its price must be a positive 2-decimal
 * amount in the shop's currency, and its `a` tag must name the order's own
 * shop (`orderUnitRef` = the 36520 `a`, '30901:<owner>:<unit_id>'). The order
 * route refuses every other listing, so an order that names one never passed
 * it — it is the buyer's own replacement.
 */
export function usableListingPrice(listing: ListingPriceSource | null | undefined, unitCurrency: string, orderUnitRef: string): string | null {
  if (!listing) return null;
  const price = String(listing.price ?? '').trim();
  const cents = toCents(price);
  if (cents === null || cents <= 0) return null;
  const cur = String(unitCurrency || '').toUpperCase();
  if (!cur || String(listing.currency || '').toUpperCase() !== cur) return null;
  if (!orderUnitRef || listing.unitRef !== orderUnitRef) return null;
  return price;
}

/**
 * The current listing price that counts for one item: its own when the
 * caller supplied one (null = listing unknown), else — only for a one-item
 * order — the v1.0 top-level price. null = unknown: the caller has no
 * merchant-signed price for this line.
 */
function itemListingPrice(order: ResolverOrder, it: ResolverItem, legacyPrice: string | null | undefined): string | null {
  if (it.listingPrice !== undefined) return it.listingPrice;
  return order.items.length === 1 ? legacyPrice ?? null : null;
}

function itemListingCreatedAt(order: ResolverOrder, it: ResolverItem, legacyCreatedAt: number | null | undefined): number | null {
  if (it.listingCreatedAt !== undefined) return it.listingCreatedAt;
  return order.items.length === 1 ? legacyCreatedAt ?? null : null;
}

/** The recomputed money of an order, in cents. */
interface ExpectedMoney {
  total: number;
  shipping: number;
  /** each item's listing price, in item order */
  prices: number[];
}

/**
 * expected = Σ(qty_i × unitPrice_i) + shipping(fee, free-from on the WHOLE
 * subtotal), where unitPrice_i is item i's own current listing price. null
 * when un-computable: no items, ANY item's listing unknown or priced ≤ 0
 * (the buyer-signed unit_price is never money — the buyer can re-sign the
 * order with any price at any time), a fulfillment other than shipping /
 * pickup, or pickup at a shop that does not offer it.
 */
function expectedMoney(order: ResolverOrder, unit: ResolverUnit, legacyPrice: string | null): ExpectedMoney | null {
  if (!order.items.length) return null;
  if (order.fulfillment !== 'shipping' && order.fulfillment !== 'pickup') return null;
  if (order.fulfillment === 'pickup' && unit.pickup !== true) return null;
  let sum = 0;
  const prices: number[] = [];
  for (const it of order.items) {
    const price = toCents(itemListingPrice(order, it, legacyPrice));
    if (price === null || price <= 0 || !Number.isInteger(it.qty) || it.qty <= 0) return null;
    prices.push(price);
    sum += price * it.qty;
  }
  let shipping = 0;
  if (order.fulfillment === 'shipping') {
    const fee = toCents(unit.shippingFee || '0.00') ?? 0;
    const freeFrom = toCents(unit.freeShippingFrom ?? null);
    if (!(freeFrom !== null && sum >= freeFrom)) shipping = fee;
  }
  return { total: sum + shipping, shipping, prices };
}

/** Expected amount in cents, or null when un-computable (see expectedMoney). */
export function expectedCents(
  order: ResolverOrder,
  unit: ResolverUnit,
  listingPrice: string | null = null,
): number | null {
  return expectedMoney(order, unit, listingPrice)?.total ?? null;
}

/**
 * Step 5: the order's OWN numbers are the merchant's — each item's
 * unit_price is its listing price and in the order's currency, shipping
 * (when given) and total are the recomputed ones.
 */
function orderNumbersAreMerchants(order: ResolverOrder, x: ExpectedMoney): boolean {
  if (toCents(order.total) !== x.total) return false;
  if (order.shipping !== undefined && toCents(order.shipping) !== x.shipping) return false;
  return order.items.every((it, i) => toCents(it.unitPrice) === x.prices[i] && it.currency === order.currency);
}

/**
 * NIP-33 order of two versions of ONE purchase (same signer, d = tx id): does
 * `cand` count over `cur`? The newer created_at wins. In the same second a
 * not-paid version wins over a paid one (fail-closed: the brain republishes
 * a cancellation, never a payment), then the lowest event id (NIP-01). The
 * same event never wins over itself. Mirrors that keep one row per purchase
 * use this to decide whether an incoming version replaces the stored one.
 */
export function purchaseVersionWins(
  cand: { createdAt: number; status: string; eventId: string },
  cur: { createdAt: number; status: string; eventId: string },
): boolean {
  if (cand.createdAt !== cur.createdAt) return cand.createdAt > cur.createdAt;
  const candPaid = PAID_STATUS.has(cand.status);
  const curPaid = PAID_STATUS.has(cur.status);
  if (candPaid !== curPaid) return !candPaid;
  return cand.eventId < cur.eventId;
}

/**
 * NIP-33: a 30933 is replaceable per (signer, d = tx id); only the version
 * purchaseVersionWins keeps is the purchase. Taken BEFORE any status filter,
 * so a newer 'cancelled' version retires the older 'processing' one even when
 * a caller still holds both.
 */
export function latestPurchaseVersions(purchases: ResolverPurchase[]): ResolverPurchase[] {
  const newest = new Map<string, ResolverPurchase>();
  for (const p of purchases) {
    const k = JSON.stringify([p.pubkey, p.txId]);
    const cur = newest.get(k);
    if (!cur || purchaseVersionWins(p, cur)) newest.set(k, p);
  }
  return [...newest.values()];
}

export function resolveOrder(input: ResolverInput): ResolverResult {
  const { order, purchases, fulfillment, unit, listingPrice, listingCreatedAt, trustedSigners, now, settledPurchase } = input;
  const bind = bindingString(order.pubkey, order.d);
  const prefixOk = orderIdMatchesPubkey(order.d, order.pubkey);

  const money = expectedMoney(order, unit, listingPrice ?? null);
  let expected = money === null ? '' : centsToString(money.total);
  const unitKnown = !!unit.ownerHex && !!unit.currency;
  const priceChanged = order.items.some((it) => {
    const at = itemListingCreatedAt(order, it, listingCreatedAt);
    return at !== null && at > order.createdAt;
  });

  // Candidate 30933: newest that satisfies every identity/binding rule, among
  // the newest version of each purchase.
  const candidates = latestPurchaseVersions(purchases).filter((e) =>
    trustedSigners.has(e.pubkey) &&
    PAID_STATUS.has(e.status) &&
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
    const amountOk = money !== null && amtCents !== null && amtCents === money.total;
    const currencyOk = e.currency === unit.currency && order.currency === unit.currency;
    const numbersOk = money !== null && orderNumbersAreMerchants(order, money);
    paidBy = { txId: e.txId, eventId: e.eventId, customerHex: e.customerHex, amount: e.amount, lanaAmount: e.lanaAmount, txHash: e.txHash };
    // Step 5a: this very purchase already settled this very 36520 event — of
    // a shop we still know, for an order that still names what was bought.
    const settled = !!settledPurchase && !!e.txId && settledPurchase.txId === e.txId
      && amtCents !== null && toCents(settledPurchase.amount) === amtCents
      && unitKnown && order.items.length > 0
      && !!e.currency && e.currency === order.currency;
    if (unitKnown && amountOk && currencyOk && numbersOk) {
      paymentState = 'paid';
    } else if (settled) {
      paymentState = 'paid';
      expected = centsToString(amtCents as number);
    } else {
      paymentState = 'amount_mismatch';
    }
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
