/**
 * orderSync — relay mirror for Lana Online Shop orders (SPEC §9.4 heartbeat).
 *
 * Every heartbeat tick it pulls, with since-cursors, the four kinds the
 * merchant's "Orders" button needs:
 *
 *   36520 Lana Shop Order            (buyer-signed; stored only for OUR units)
 *   36521 Lana Shop Order Fulfillment(merchant/staff-signed; stored only when
 *                                     the signer is the unit's owner or staff)
 *   36522 Lana Shop Delivery Details (buyer-signed NIP-44 CIPHERTEXT — stored
 *                                     as the raw event, never decrypted here)
 *   30933 Purchase                   (ONLY authors ∈ KIND 38888 trusted_signers;
 *                                     the ONLY money truth)
 *
 * then runs the normative resolver (orderResolver.ts — copied verbatim from
 * SPEC.md) per order and persists payment_state / effective_status / pending.
 * The expected amount is recomputed from the MERCHANT-SIGNED listing (fetched
 * by address), never from the buyer's order.
 *
 * Dev-only overrides (inert when NODE_ENV === 'production'):
 *   LANA_RELAYS_OVERRIDE          comma-separated relay URLs
 *   LANA_TRUSTED_SIGNERS_OVERRIDE comma-separated hex pubkeys
 */

import type Database from 'better-sqlite3';
import WebSocket from 'ws';
import { verifyEvent } from 'nostr-tools/pure';
import { queryEvents, type SignedEvent } from './dm.js';
import { getLanaRelays, broadcastEvent, verifyNostrEvent } from './nostr.js';
import { ordersSchemaOk } from '../db/schema.js';
import { SIMPLE_UNIT_SQL } from './unitOrigin.js';
import {
  resolveOrder, ORDER_ID_RE, orderIdMatchesPubkey, toCents, bindingString, usableListingPrice, listingSaleStatus, purchaseVersionWins,
  type ResolverOrder, type ResolverPurchase, type ResolverFulfillment, type ResolverUnit, type SettledPurchase,
} from './orderResolver.js';

export const KIND_ORDER = 36520;
export const KIND_FULFILLMENT = 36521;
export const KIND_DELIVERY = 36522;
export const KIND_PURCHASE = 30933;

/** SPEC §3 — monotonic chain; rejected/refunded from any non-completed state. */
export const FULFILLMENT_RANK: Record<string, number> = {
  received: 1, confirmed: 2, packed: 3, shipped: 4, delivered: 5, completed: 6,
};
export const FULFILLMENT_STATUSES = new Set([...Object.keys(FULFILLMENT_RANK), 'rejected', 'refunded']);

/** KIND 38888 trusted_signers groups whose members may sign a 30933 we believe. */
const TRUSTED_GROUPS = ['LanaPaysUs', 'LanaPays', 'Processor', 'Brain'];

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const DAY = 86_400;

const isProduction = () => process.env.NODE_ENV === 'production';
const nowUnix = () => Math.floor(Date.now() / 1000);

function tag(ev: { tags: string[][] }, name: string): string | undefined {
  return ev.tags.find(t => Array.isArray(t) && t[0] === name)?.[1];
}
function tagRow(ev: { tags: string[][] }, name: string): string[] | undefined {
  return ev.tags.find(t => Array.isArray(t) && t[0] === name);
}

// ─── Config readers (relays + trusted signers) ──────────────────────────

/** Relays for shop-order REQs: dev override → heartbeat's 38888 list → stored 38888 → built-in. */
export function readRelays(db: Database.Database, fromHeartbeat?: string[]): string[] {
  const override = process.env.LANA_RELAYS_OVERRIDE;
  if (!isProduction() && override) {
    const list = override.split(',').map(s => s.trim()).filter(Boolean);
    if (list.length) return list;
  }
  if (fromHeartbeat && fromHeartbeat.length) return fromHeartbeat;
  try {
    const row = db.prepare('SELECT relays FROM kind_38888 ORDER BY id DESC LIMIT 1').get() as any;
    const list = row ? JSON.parse(row.relays || '[]') : [];
    if (Array.isArray(list) && list.length) return list.filter((r: unknown) => typeof r === 'string');
  } catch { /* fall through */ }
  return getLanaRelays();
}

/**
 * Pubkeys allowed to sign a 30933 we treat as money: KIND 38888 content
 * `trusted_signers` → LanaPaysUs | LanaPays | Processor | Brain. Parsed from
 * the stored raw_event (there is no trusted_signers column). Empty set ⇒ no
 * purchase is ever believed (fail-closed).
 */
export function readTrustedSigners(db: Database.Database): Set<string> {
  const override = process.env.LANA_TRUSTED_SIGNERS_OVERRIDE;
  if (!isProduction() && override) {
    return new Set(override.split(',').map(s => s.trim().toLowerCase()).filter(s => HEX64.test(s)));
  }
  const out = new Set<string>();
  try {
    const row = db.prepare('SELECT raw_event FROM kind_38888 ORDER BY id DESC LIMIT 1').get() as any;
    if (!row?.raw_event) return out;
    const ev = JSON.parse(row.raw_event);
    const content = typeof ev?.content === 'string' && ev.content.trim().startsWith('{') ? JSON.parse(ev.content) : {};
    const groups = content?.trusted_signers;
    if (!groups || typeof groups !== 'object') return out;
    for (const g of TRUSTED_GROUPS) {
      const v = groups[g];
      const list: unknown[] = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
      for (const hex of list) {
        if (typeof hex === 'string' && HEX64.test(hex.toLowerCase())) out.add(hex.toLowerCase());
      }
    }
  } catch { /* empty = fail-closed */ }
  return out;
}

// ─── Unit lookup (OUR units only — never simple.lanapays.us) ───────────

export interface UnitRow {
  unit_id: string; name: string; owner_hex: string; pubkey: string;
  authorized_hex: string; currency: string; raw_event: string | null;
}

export function unitRow(db: Database.Database, unitId: string): UnitRow | null {
  if (!HEX32.test(unitId || '')) return null;
  return (db.prepare(`
    SELECT unit_id, name, owner_hex, pubkey, authorized_hex, currency, raw_event
    FROM business_units WHERE unit_id = ? AND NOT ${SIMPLE_UNIT_SQL}
  `).get(unitId) as UnitRow | undefined) || null;
}

/** Owner + every staff `p` + the 30901 signer — the hexes allowed to fulfil. */
export function unitSigners(u: UnitRow): string[] {
  const set = new Set<string>([u.owner_hex, u.pubkey].filter(Boolean));
  try { for (const h of JSON.parse(u.authorized_hex || '[]')) if (typeof h === 'string') set.add(h); } catch { /* ignore */ }
  return [...set];
}

/**
 * The unit as a MONEY and ACCESS input for one order, or null.
 *
 * Its stored KIND 30901 (business_units.raw_event — where the shipping fee,
 * free-shipping threshold and pickup that judge the order are read, and the
 * owner and staff who may act on it) must be a signature-verified kind-30901
 * event whose `d` is this unit id, signed by the key the order's own `a` tag
 * names (`30901:<that key>:<unit id>`), and the row's pubkey must be that
 * key. heartbeat.ts syncBusinessUnits already refuses other authors; this
 * holds the order path to the same rule whatever filled the row (log-only
 * mode KIND_30901_AUTHOR_PIN=0, or a row written before the pin existed).
 *
 * NOT "author == owner_hex": owner_hex is a tag, written by whoever signs.
 *
 * A caller that gets null SKIPS the order — it does not judge it with a blank
 * or foreign unit: a verdict other than 'paid' clears settled_order_event_id,
 * the step-5a pin of an order that was honestly paid.
 */
export function moneyUnit(u: UnitRow | null, orderOwnerHex: string | null | undefined): UnitRow | null {
  if (!u || !HEX64.test(orderOwnerHex || '')) return null;
  let ev: any = null;
  try { ev = u.raw_event ? JSON.parse(u.raw_event) : null; } catch { return null; }
  if (!verifyNostrEvent(ev, [30901])) return null;
  const d = tag(ev, 'd');
  const unitIdTag = tag(ev, 'unit_id');
  if (d !== u.unit_id || (unitIdTag !== undefined && unitIdTag !== d)) return null;
  if (ev.pubkey !== orderOwnerHex || u.pubkey !== orderOwnerHex) return null;
  return u;
}

/** KIND 30901 v1.2.0 online-shop tags (SPEC §6) → resolver unit. Absent fee == '0.00', absent pickup == not offered. */
export function unitToResolver(u: UnitRow): ResolverUnit {
  let shippingFee = '0.00';
  let freeShippingFrom: string | null = null;
  let pickup = false;
  try {
    const ev = u.raw_event ? JSON.parse(u.raw_event) : null;
    const fee = ev ? tag(ev, 'online_shop_shipping_fee') : undefined;
    const free = ev ? tag(ev, 'online_shop_free_shipping_from') : undefined;
    if (fee && toCents(fee) !== null) shippingFee = fee;
    if (free && toCents(free) !== null) freeShippingFrom = free;
    pickup = !!ev && tag(ev, 'online_shop_pickup') === 'true';
  } catch { /* defaults */ }
  return {
    ownerHex: u.owner_hex,
    staffHexes: unitSigners(u).filter(h => h !== u.owner_hex),
    currency: String(u.currency || '').toUpperCase(),
    shippingFee,
    freeShippingFrom,
    pickup,
  };
}

// ─── Parsers (tag layouts frozen in SPEC §2–§4, §7) ─────────────────────

/** SPEC v1.1.0: different products ONE order may carry (all of one shop). */
export const MAX_ITEMS_PER_ORDER = 30;

/**
 * Kinds a 36520 item may point at: the Lana listing kinds 36500–36516 and the
 * NIP-52 calendar listing 31923 — the set the broker (shop.lanapays.us
 * LISTING_KINDS) takes an order for. Anything else is not a product.
 */
export const ORDER_ITEM_KINDS: ReadonlySet<number> = new Set([
  31923, ...Array.from({ length: 17 }, (_, i) => 36500 + i),
]);

/**
 * A whole, positive quantity exactly as the order route writes it — the
 * portal's rule (lanaeco-shop orderShapeProblem QTY_RE), which the broker's
 * shares: no '1e1', '0x0a', ' 10', '10.0', '010' or '+10'. Number() takes
 * all of those, so a buyer's replacement carrying one was mirrored here but
 * refused by the portal, and the two showed different "paid" orders for one
 * order id (fourth review, x2/p4).
 */
const QTY_RE = /^[1-9]\d{0,8}$/;

export interface ParsedOrder {
  d: string; pubkey: string; eventId: string; createdAt: number;
  unitId: string; unitOwnerHex: string;
  items: Array<{ a: string; kind: number; qty: number; saleUnit: string; unitPrice: string; currency: string }>;
  shipping: string; total: string; currency: string; fulfillment: string; status: string;
  payBy: number; client: string; supersedes: string | null;
}

export function parseOrderEvent(ev: SignedEvent): ParsedOrder | null {
  if (ev.kind !== KIND_ORDER || ev.content !== '') return null;
  const d = tag(ev, 'd') || '';
  if (!orderIdMatchesPubkey(d, ev.pubkey)) return null;
  const a = tag(ev, 'a') || '';
  const [aKind, aOwner, aUnit] = a.split(':');
  const unitId = tag(ev, 'unit_id') || '';
  if (aKind !== '30901' || !HEX64.test(aOwner || '') || !HEX32.test(unitId) || aUnit !== unitId) return null;
  const p = tag(ev, 'p') || '';
  if (p !== aOwner) return null;
  if (tag(ev, 'invoice_number') !== d) return null;

  const items: ParsedOrder['items'] = [];
  for (const t of ev.tags) {
    if (t[0] !== 'item') continue;
    const [, addr, qtyS, saleUnit, unitPrice, cur] = t;
    // `<listing kind>:<owner>:<listing d>` exactly, as the broker takes it.
    const parts = String(addr || '').split(':');
    const [kindS, owner, listingD] = parts;
    if (!QTY_RE.test(String(qtyS ?? ''))) return null;
    const qty = Number(qtyS);
    if (parts.length !== 3 || !/^[1-9]\d*$/.test(kindS || '') || !ORDER_ITEM_KINDS.has(Number(kindS)) || !listingD) return null;
    if (!HEX64.test(owner || '') || !Number.isInteger(qty) || qty <= 0) return null;
    if (toCents(unitPrice) === null || !cur) return null;
    items.push({ a: addr, kind: Number(kindS), qty, saleUnit: saleUnit || '', unitPrice, currency: cur });
  }
  // SPEC v1.1.0 (cart): 1..MAX_ITEMS_PER_ORDER items, every one a listing of
  // the unit owner, each listing once. An order outside that is not a shop
  // order we can show truthfully, so it is dropped as before.
  if (items.length === 0 || items.length > MAX_ITEMS_PER_ORDER) return null;
  const seenItems = new Set<string>();
  for (const it of items) {
    if (it.a.split(':')[1] !== aOwner || seenItems.has(it.a)) return null;
    seenItems.add(it.a);
  }

  const shipping = tagRow(ev, 'shipping');
  const total = tagRow(ev, 'total');
  if (!shipping || toCents(shipping[1]) === null || !total || toCents(total[1]) === null) return null;
  const currency = total[2] || '';
  if (!currency || shipping[2] !== currency || items.some(i => i.currency !== currency)) return null;

  const fulfillment = tag(ev, 'fulfillment') || '';
  if (fulfillment !== 'shipping' && fulfillment !== 'pickup') return null;
  const status = tag(ev, 'status') || '';
  if (status !== 'placed' && status !== 'cancelled') return null;
  const payBy = Number(tag(ev, 'pay_by'));
  if (!Number.isInteger(payBy) || payBy <= 0) return null;
  if (tag(ev, 'v') !== '1') return null;

  return {
    d, pubkey: ev.pubkey, eventId: ev.id, createdAt: ev.created_at,
    unitId, unitOwnerHex: aOwner, items, shipping: shipping[1], total: total[1], currency,
    fulfillment, status, payBy, client: tag(ev, 'client') || '', supersedes: tag(ev, 'supersedes') || null,
  };
}

export interface ParsedFulfillment {
  d: string; pubkey: string; eventId: string; createdAt: number; unitId: string;
  buyerRef: string | null; status: string; paymentRef: string | null;
  carrier: string | null; tracking: string | null;
  shippedAt: string | null; deliveredAt: string | null; eta: string | null; content: string;
}

export function parseFulfillmentEvent(ev: SignedEvent): ParsedFulfillment | null {
  if (ev.kind !== KIND_FULFILLMENT) return null;
  const d = tag(ev, 'd') || '';
  if (!ORDER_ID_RE.test(d)) return null;
  const unitId = tag(ev, 'unit_id') || '';
  if (!HEX32.test(unitId)) return null;
  const status = tag(ev, 'status') || '';
  if (!FULFILLMENT_STATUSES.has(status)) return null;
  if (tag(ev, 'v') !== '1') return null;
  const orderRef = ev.tags.find(t => t[0] === 'a' && String(t[1] || '').startsWith('36520:'))?.[1] || '';
  const [, refBuyer, refD] = orderRef.split(':');
  if (orderRef && (!HEX64.test(refBuyer || '') || refD !== d)) return null;
  return {
    d, pubkey: ev.pubkey, eventId: ev.id, createdAt: ev.created_at, unitId,
    buyerRef: orderRef ? refBuyer : null, status,
    paymentRef: tag(ev, 'payment') || null,
    carrier: tag(ev, 'carrier') || null, tracking: tag(ev, 'tracking') || null,
    shippedAt: tag(ev, 'shipped_at') || null, deliveredAt: tag(ev, 'delivered_at') || null,
    eta: tag(ev, 'eta') || null, content: ev.content || '',
  };
}

export interface ParsedDelivery {
  d: string; orderId: string; recipientHex: string; pubkey: string; eventId: string; createdAt: number; unitId: string;
}

export function parseDeliveryEvent(ev: SignedEvent): ParsedDelivery | null {
  if (ev.kind !== KIND_DELIVERY || !ev.content) return null;
  const d = tag(ev, 'd') || '';
  const sep = d.indexOf('__');
  if (sep < 0) return null;
  const orderId = d.slice(0, sep);
  const recipientHex = d.slice(sep + 2);
  if (!orderIdMatchesPubkey(orderId, ev.pubkey) || !HEX64.test(recipientHex)) return null;
  if (tag(ev, 'p') !== recipientHex) return null;
  if (tag(ev, 'a') !== `36520:${ev.pubkey}:${orderId}`) return null;
  if (tag(ev, 'encryption') !== 'nip44') return null;
  const unitId = tag(ev, 'unit_id') || '';
  if (!HEX32.test(unitId)) return null;
  return { d, orderId, recipientHex, pubkey: ev.pubkey, eventId: ev.id, createdAt: ev.created_at, unitId };
}

export interface ParsedPurchase extends ResolverPurchase {}

export function parsePurchaseEvent(ev: SignedEvent): ParsedPurchase | null {
  if (ev.kind !== KIND_PURCHASE) return null;
  const txId = tag(ev, 'd') || '';
  const unitId = tag(ev, 'unit_id') || '';
  const invoiceNumber = tag(ev, 'invoice_number') || '';
  if (!txId || !HEX32.test(unitId) || !invoiceNumber) return null;
  return {
    pubkey: ev.pubkey, eventId: ev.id, createdAt: ev.created_at, txId, unitId, invoiceNumber,
    receiptDescription: tag(ev, 'receipt_description') || '',
    amount: tag(ev, 'amount') || '',
    currency: tag(ev, 'currency') || '',
    lanaAmount: tag(ev, 'lana_amount') || '',
    paymentType: tag(ev, 'payment_type') || '',
    status: tag(ev, 'status') || '',
    customerHex: tag(ev, 'customer_hex') || tag(ev, 'p') || '',
  };
}

// ─── Ingest (each returns the order_id it touched, or null when dropped) ──

export function ingestOrder(db: Database.Database, ev: SignedEvent): string | null {
  const o = parseOrderEvent(ev);
  if (!o) return null;
  // Not our unit (or a simple.lanapays.us one) — or a unit row that is not a
  // verified 30901 signed by the key this order's `a` names (moneyUnit): the
  // order must point at the identity that signed the shop it is judged by.
  const unit = moneyUnit(unitRow(db, o.unitId), o.unitOwnerHex);
  if (!unit) return null;

  const existing = db.prepare('SELECT buyer_pubkey, created_at, event_id FROM shop_orders WHERE order_id = ?').get(o.d) as any;
  if (existing) {
    if (existing.buyer_pubkey !== o.pubkey) return null;          // NIP-33 replace is per (pubkey, d)
    if (o.createdAt <= existing.created_at) return null;          // NIP-33 newest wins (same event = no-op)
  }
  // A replacement is a NEW order event: the verdict of the old one (paid,
  // pending, paid_*) must not show beside the new lines until resolveOrders
  // has judged it — the view, the pending count and the fulfillment gate read
  // these columns. So the row goes back to "never resolved"; the merchant's
  // own fulfillment columns stay, and resolveOrders (same sync tick) re-judges.
  db.prepare(`
    INSERT INTO shop_orders (
      order_id, event_id, buyer_pubkey, created_at, unit_id, unit_owner_hex, items_json,
      shipping, total, currency, fulfillment, order_status, pay_by, client, supersedes, raw_event, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(order_id) DO UPDATE SET
      event_id = excluded.event_id, created_at = excluded.created_at,
      unit_owner_hex = excluded.unit_owner_hex, items_json = excluded.items_json,
      shipping = excluded.shipping, total = excluded.total, currency = excluded.currency,
      fulfillment = excluded.fulfillment, order_status = excluded.order_status, pay_by = excluded.pay_by,
      client = excluded.client, supersedes = excluded.supersedes, raw_event = excluded.raw_event,
      payment_state = 'unpaid', expected_total = NULL, price_changed = 0, effective_status = 'unpaid', pending = 0,
      paid_signer_hex = NULL, paid_tx_id = NULL, paid_event_id = NULL, paid_customer_hex = NULL,
      paid_amount = NULL, paid_lana_amount = NULL, paid_at = NULL, paid_order_event_id = NULL,
      settled_order_event_id = NULL, resolved_at = NULL,
      updated_at = datetime('now')
  `).run(
    o.d, o.eventId, o.pubkey, o.createdAt, o.unitId, o.unitOwnerHex, JSON.stringify(o.items),
    o.shipping, o.total, o.currency, o.fulfillment, o.status, o.payBy, o.client, o.supersedes, JSON.stringify(ev),
  );
  return o.d;
}

/**
 * 36521 is stored ONLY when its signer is the unit's owner or a staff `p` of
 * the unit named in its own unit_id tag. A stranger's "shipped" never lands.
 */
export function ingestFulfillment(db: Database.Database, ev: SignedEvent): string | null {
  const f = parseFulfillmentEvent(ev);
  if (!f) return null;
  const order = db.prepare('SELECT unit_id, buyer_pubkey, unit_owner_hex FROM shop_orders WHERE order_id = ?').get(f.d) as any;
  if (order && order.unit_id !== f.unitId) return null;
  // Owner and staff come from a unit row this app may believe (moneyUnit):
  // for a stored order, signed by the key its `a` names; before the order is
  // stored, at least a verified 30901 of its own signer.
  const row = unitRow(db, f.unitId);
  const unit = moneyUnit(row, order ? order.unit_owner_hex : row?.pubkey);
  if (!unit || !unitSigners(unit).includes(f.pubkey)) return null;
  if (order && f.buyerRef && order.buyer_pubkey !== f.buyerRef) return null;

  const existing = db.prepare('SELECT event_id, created_at, published FROM shop_order_fulfillments WHERE order_id = ?').get(f.d) as any;
  if (existing) {
    if (existing.event_id === f.eventId) {
      if (existing.published === 0) {
        // Our own signed event came back from a relay — it is published now.
        db.prepare('UPDATE shop_order_fulfillments SET published = 1 WHERE order_id = ?').run(f.d);
        db.prepare('UPDATE shop_orders SET fulfillment_published = 1 WHERE order_id = ? AND fulfillment_event_id = ?').run(f.d, f.eventId);
        return f.d;
      }
      return null;
    }
    if (f.createdAt <= existing.created_at) return null; // NIP-33 newest wins
  }
  upsertFulfillmentRow(db, f, ev, 1);
  return f.d;
}

export function upsertFulfillmentRow(db: Database.Database, f: ParsedFulfillment, ev: SignedEvent, published: 0 | 1): void {
  db.prepare(`
    INSERT INTO shop_order_fulfillments (
      order_id, event_id, pubkey, created_at, status, payment_ref, carrier, tracking,
      shipped_at, delivered_at, eta, content, raw_event, published, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(order_id) DO UPDATE SET
      event_id = excluded.event_id, pubkey = excluded.pubkey, created_at = excluded.created_at,
      status = excluded.status, payment_ref = excluded.payment_ref, carrier = excluded.carrier,
      tracking = excluded.tracking, shipped_at = excluded.shipped_at, delivered_at = excluded.delivered_at,
      eta = excluded.eta, content = excluded.content, raw_event = excluded.raw_event,
      published = excluded.published, updated_at = datetime('now')
  `).run(
    f.d, f.eventId, f.pubkey, f.createdAt, f.status, f.paymentRef, f.carrier, f.tracking,
    f.shippedAt, f.deliveredAt, f.eta, f.content, JSON.stringify(ev), published,
  );
}

export function ingestDelivery(db: Database.Database, ev: SignedEvent): string | null {
  const dl = parseDeliveryEvent(ev);
  if (!dl) return null;
  if (!unitRow(db, dl.unitId)) return null;
  const existing = db.prepare('SELECT created_at, buyer_pubkey FROM shop_order_delivery WHERE d = ?').get(dl.d) as any;
  if (existing && (existing.buyer_pubkey !== dl.pubkey || dl.createdAt <= existing.created_at)) return null;
  db.prepare(`
    INSERT INTO shop_order_delivery (d, order_id, recipient_hex, buyer_pubkey, unit_id, event_id, created_at, raw_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(d) DO UPDATE SET event_id = excluded.event_id, created_at = excluded.created_at, raw_event = excluded.raw_event
  `).run(dl.d, dl.orderId, dl.recipientHex, dl.pubkey, dl.unitId, dl.eventId, dl.createdAt, JSON.stringify(ev));
  return dl.orderId;
}

/** 30933 from a NON-trusted signer is dropped here, whatever the REQ returned. */
export function ingestPurchase(db: Database.Database, ev: SignedEvent, trusted: Set<string>): string | null {
  if (!trusted.has(ev.pubkey)) return null;
  const p = parsePurchaseEvent(ev);
  if (!p) return null;
  if (!ORDER_ID_RE.test(p.invoiceNumber)) return null; // a till purchase, not a shop order
  if (!unitRow(db, p.unitId)) return null;
  // One row per (signer, tx id): the incoming version replaces the stored one
  // only when the resolver's version rule says it counts over it — newer
  // wins; in the same second the NOT-paid one, then the lowest id. "Newer
  // only" kept the first copy seen, so a cancellation signed in the same
  // second as the payment never landed and the order stayed paid.
  const existing = db.prepare('SELECT created_at, status, event_id FROM shop_order_payments WHERE pubkey = ? AND tx_id = ?').get(p.pubkey, p.txId) as any;
  if (existing && !purchaseVersionWins(
    { createdAt: p.createdAt, status: p.status, eventId: p.eventId },
    { createdAt: existing.created_at, status: existing.status || '', eventId: existing.event_id },
  )) return null;
  db.prepare(`
    INSERT INTO shop_order_payments (
      pubkey, tx_id, event_id, created_at, unit_id, invoice_number, receipt_description,
      amount, currency, lana_amount, payment_type, status, customer_hex, raw_event
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pubkey, tx_id) DO UPDATE SET
      event_id = excluded.event_id, created_at = excluded.created_at, unit_id = excluded.unit_id,
      invoice_number = excluded.invoice_number, receipt_description = excluded.receipt_description,
      amount = excluded.amount, currency = excluded.currency, lana_amount = excluded.lana_amount,
      payment_type = excluded.payment_type, status = excluded.status, customer_hex = excluded.customer_hex,
      raw_event = excluded.raw_event
  `).run(
    p.pubkey, p.txId, p.eventId, p.createdAt, p.unitId, p.invoiceNumber, p.receiptDescription,
    p.amount, p.currency, p.lanaAmount, p.paymentType, p.status, p.customerHex, JSON.stringify(ev),
  );
  return p.invoiceNumber;
}

/** Signature-verify then route one relay event. Returns the touched order_id. */
export function ingestEvent(db: Database.Database, ev: SignedEvent, trusted: Set<string>): string | null {
  let ok = false;
  try { ok = verifyEvent(ev as any); } catch { ok = false; }
  if (!ok) return null;
  switch (ev.kind) {
    case KIND_ORDER: return ingestOrder(db, ev);
    case KIND_FULFILLMENT: return ingestFulfillment(db, ev);
    case KIND_DELIVERY: return ingestDelivery(db, ev);
    case KIND_PURCHASE: return ingestPurchase(db, ev, trusted);
    default: return null;
  }
}

// ─── Listing price (merchant-signed) by address ─────────────────────────

export interface ListingInfo {
  /**
   * Money fields — the ONLY ones the resolver's caller reads: price, the
   * currency the price is signed in, the listing's `a` tag (which shop it
   * belongs to), its sale status (listingSaleStatus: only 'active' is on
   * sale — both read by usableListingPrice) and createdAt.
   */
  price: string | null; currency: string; status: string; createdAt: number; unitRef?: string;
  /**
   * Display only (the merchant's order screen): read from the same
   * signature-verified, author-matched event. Never passed to resolveOrder.
   */
  eventId?: string; title?: string; sku?: string; weight?: string; unit?: string;
}
export type ListingFetcher = (address: string) => Promise<ListingInfo | null>;

/** A display string from a listing tag: trimmed, single-spaced, bounded. */
function displayTag(ev: { tags: string[][] }, name: string, max: number): string | undefined {
  const v = tag(ev, name);
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

/**
 * One REQ carrying `filters` to one relay. The events count only when the
 * relay ends the REQ with EOSE: null when it fails, closes the subscription
 * or times out first — so a caller can tell "read, nothing there" from "not
 * read".
 */
function reqUntilEose(url: string, filters: Record<string, any>[], timeout: number): Promise<SignedEvent[] | null> {
  return new Promise(resolve => {
    const events: SignedEvent[] = [];
    let settled = false;
    let ws: WebSocket | null = null;
    const timer = setTimeout(() => finish(null), timeout);
    function finish(v: SignedEvent[] | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* ignore */ }
      resolve(v);
    }
    const sub = `del_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try { ws = new WebSocket(url); } catch { finish(null); return; }
    ws.on('open', () => { try { ws!.send(JSON.stringify(['REQ', sub, ...filters])); } catch { finish(null); } });
    ws.on('message', (data: Buffer) => {
      try {
        const m = JSON.parse(data.toString());
        if (m[0] === 'EVENT' && m[1] === sub && m[2]) events.push(m[2]);
        else if (m[0] === 'EOSE' && m[1] === sub) finish(events);
        else if (m[0] === 'CLOSED' && m[1] === sub) finish(null);
      } catch { /* ignore */ }
    });
    ws.on('error', () => finish(null));
    ws.on('close', () => finish(null));
  });
}

/**
 * NIP-09, read as the broker reads it (listingsCache.isDeleted) and the
 * portal applies it (liveSync.applyDeletion): a signed KIND 5 by the
 * listing's OWN author that names this version's id (`e`), or the listing's
 * address (`a` = `<kind>:<pubkey>:<d>`) with created_at ≥ this version's — a
 * listing re-published later with the same d is live again. A deletion by
 * anybody else deletes nothing.
 */
export function listingDeletedBy(
  listing: { id: string; pubkey: string; kind: number; d: string; created_at: number },
  deletions: SignedEvent[],
): boolean {
  const address = `${listing.kind}:${listing.pubkey}:${listing.d}`;
  for (const del of deletions) {
    if (!del || del.kind !== 5 || del.pubkey !== listing.pubkey || !Array.isArray(del.tags)) continue;
    let ok = false;
    try { ok = verifyEvent(del as any); } catch { ok = false; }
    if (!ok) continue;
    for (const t of del.tags) {
      if (!Array.isArray(t) || typeof t[1] !== 'string') continue;
      if (t[0] === 'e' && t[1] === listing.id) return true;
      if (t[0] === 'a' && t[1] === address && del.created_at >= listing.created_at) return true;
    }
  }
  return false;
}

/**
 * REQ the listing event `<kind>:<pubkey>:<d>`; newest signed by that pubkey
 * wins — unless its author has deleted it (NIP-09, listingDeletedBy): the
 * KIND 5s naming it are read in a second REQ, and a listing is returned only
 * when at least one relay finished that read (fail-closed: a deletion that
 * could not be read is not taken as "none"). A relay that still serves a
 * deleted listing (it does not apply KIND 5, or someone re-broadcast it) no
 * longer hands this app a live price the portal and the broker refuse
 * (round 3, x3/m3).
 */
export function makeListingFetcher(relays: string[], timeout = 6000): ListingFetcher {
  // The cache lives exactly as long as this fetcher: syncShopOrders makes one
  // per tick (1 min), the fulfillment route one per request. It used to be
  // one module-wide Map with a 10-minute TTL, so a price the merchant changed
  // was still the old one for up to ten ticks of judging money (round 5, F2).
  // It holds the promise, so the prefetch, the per-order read and the item
  // snapshot of one tick share one REQ per address.
  const cache = new Map<string, Promise<ListingInfo | null>>();
  return (address: string) => {
    let p = cache.get(address);
    if (!p) { p = fetchListingOnce(relays, timeout, address); cache.set(address, p); }
    return p;
  };
}

async function fetchListingOnce(relays: string[], timeout: number, address: string): Promise<ListingInfo | null> {
  const [kindS, pubkey, ...rest] = address.split(':');
  const d = rest.join(':');
  const kind = Number(kindS);
  if (!Number.isInteger(kind) || !HEX64.test(pubkey || '') || !d) return null;
  let info: ListingInfo | null = null;
  try {
    const events = await queryEvents(relays, { kinds: [kind], authors: [pubkey], '#d': [d] }, timeout);
    let best: SignedEvent | null = null;
    for (const ev of events) {
      if (ev.pubkey !== pubkey || ev.kind !== kind || tag(ev, 'd') !== d) continue;
      let ok = false;
      try { ok = verifyEvent(ev as any); } catch { ok = false; }
      if (!ok) continue;
      if (!best || ev.created_at > best.created_at) best = ev;
    }
    if (best) {
      const found = best;
      const reads = await Promise.all(relays.map(url => reqUntilEose(url, [
        { kinds: [5], authors: [pubkey], '#a': [`${kind}:${pubkey}:${d}`] },
        { kinds: [5], authors: [pubkey], '#e': [found.id] },
      ], timeout)));
      const finished = reads.filter((r): r is SignedEvent[] => r !== null);
      if (finished.length === 0 || listingDeletedBy({ id: found.id, pubkey, kind, d, created_at: found.created_at }, finished.flat())) best = null;
    }
    if (best) {
      const price = tagRow(best, 'price');
      info = {
        price: price && toCents(price[1]) !== null ? price[1] : null,
        // KIND 36511 (Body Arts) signs its currency in a separate tag — as the broker reads it.
        currency: price?.[2] || (best.kind === 36511 ? tag(best, 'currency') || '' : ''),
        unitRef: tag(best, 'a') || '',
        // as the order route reads it: KIND 31923 signs it in lana-status
        status: listingSaleStatus(best),
        createdAt: best.created_at,
        eventId: best.id,
        title: displayTag(best, 'title', 200),
        sku: displayTag(best, 'sku', 64),
        weight: displayTag(best, 'weight', 40),
        unit: displayTag(best, 'unit', 40),
      };
    }
  } catch { info = null; }
  // Not found (deleted, or the REQ failed) is null — never the last cached
  // price, which outlived a deleted listing for as long as the process ran
  // (review 2 Oct 2026). resolveOrders falls back to the price it saw while
  // judging the same 36520 event (shop_order_listing_prices), nothing else.
  return info;
}

// ─── What was ordered — display only, never read by the resolver ────────
//
// A KIND 36520 v1 item is [address, qty, saleUnit, unitPrice, currency]: no
// title, no šifra. Without this the merchant saw "1 × g · <d-tag>" (Živa
// Center, 30. 9. 2026). The listing fetched for the resolver is the
// merchant-signed source of the product name; it is kept per order item, the
// version closest to the order's created_at winning.

function itemsOf(row: { items_json?: string }): any[] {
  try { const v = JSON.parse(row.items_json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * Is a listing version with created_at `cand` a truer picture of what the
 * buyer saw than the stored one (`stored`)? The version live at order time is
 * the newest with created_at ≤ the order's; failing that, the earliest after.
 */
export function closerToOrderTime(cand: number, stored: number, orderCreatedAt: number): boolean {
  const candLive = cand <= orderCreatedAt;
  const storedLive = stored <= orderCreatedAt;
  if (candLive !== storedLive) return candLive;
  return candLive ? cand > stored : cand < stored;
}

/**
 * Keep the listing's display fields for one order item. Inserts when absent;
 * replaces a receipt-only title, or a version further from order time. Returns
 * true when a row was written.
 */
export function snapshotItem(
  db: Database.Database,
  order: { order_id: string; created_at: number },
  itemA: string,
  listing: ListingInfo | null,
  now = nowUnix(),
): boolean {
  if (!listing || !listing.eventId) return false;
  const existing = db.prepare(
    'SELECT listing_event_id, listing_created_at, source FROM shop_order_item_snapshots WHERE order_id = ? AND item_a = ?'
  ).get(order.order_id, itemA) as any;
  if (existing) {
    if (existing.listing_event_id === listing.eventId) return false;
    if (existing.source === 'listing' && typeof existing.listing_created_at === 'number'
      && !closerToOrderTime(listing.createdAt, existing.listing_created_at, order.created_at)) return false;
  }
  db.prepare(`
    INSERT INTO shop_order_item_snapshots (
      order_id, item_a, listing_event_id, listing_created_at, title, sku, weight, sale_unit, price, currency, source, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'listing', ?)
    ON CONFLICT(order_id, item_a) DO UPDATE SET
      listing_event_id = excluded.listing_event_id, listing_created_at = excluded.listing_created_at,
      title = excluded.title, sku = excluded.sku, weight = excluded.weight, sale_unit = excluded.sale_unit,
      price = excluded.price, currency = excluded.currency, source = 'listing', fetched_at = excluded.fetched_at
  `).run(
    order.order_id, itemA, listing.eventId, listing.createdAt,
    listing.title ?? null, listing.sku ?? null, listing.weight ?? null, listing.unit ?? null,
    listing.price ?? null, listing.currency || null, now,
  );
  return true;
}

/**
 * The product title the broker wrote into the paid 30933 —
 * `<title> ×<qty> · 36520:<buyer>:<order>` (lana-pays-shop buildDescription) —
 * or null when the description is not bound to exactly this order and qty.
 * Display only: it may be truncated and carries no šifra.
 */
export function receiptTitle(desc: string | null | undefined, buyerPubkey: string, orderId: string, qty: number): string | null {
  if (typeof desc !== 'string' || !Number.isInteger(qty) || qty <= 0) return null;
  const suffix = ` ×${qty} · ${bindingString(buyerPubkey, orderId)}`;
  if (!desc.endsWith(suffix)) return null;
  const t = desc.slice(0, desc.length - suffix.length).replace(/\s+/g, ' ').trim();
  if (!t || t === 'Order') return null; // 'Order' = the broker's placeholder for an untitled listing
  return t.slice(0, 200);
}

/** receiptTitle of the 30933 the resolver accepted for this (single-item) order. */
export function paidReceiptTitle(
  db: Database.Database,
  row: { order_id: string; unit_id: string; buyer_pubkey: string; items_json?: string; paid_event_id?: string | null },
): string | null {
  if (!row.paid_event_id) return null;
  const items = itemsOf(row);
  if (items.length !== 1) return null;
  const p = db.prepare(
    'SELECT receipt_description FROM shop_order_payments WHERE event_id = ? AND unit_id = ? AND invoice_number = ?'
  ).get(row.paid_event_id, row.unit_id, row.order_id) as any;
  return receiptTitle(p?.receipt_description, row.buyer_pubkey, row.order_id, Number(items[0]?.qty));
}

/**
 * Snapshot EVERY item of an order from its fetched listing (`listings[i]`
 * belongs to item i). A one-item order with no listing falls back to the paid
 * receipt's title — never over an existing row; a cart order has no such
 * fallback (its receipt names only the first product). Returns true when any
 * row was written.
 */
export function snapshotOrderItems(db: Database.Database, row: any, listings: Array<ListingInfo | null>, now = nowUnix()): boolean {
  const items = itemsOf(row);
  let wrote = false;
  items.forEach((it, i) => {
    const a = it?.a;
    if (typeof a !== 'string' || !a) return;
    const listing = listings[i] ?? null;
    if (listing?.eventId) { if (snapshotItem(db, row, a, listing, now)) wrote = true; return; }
    if (items.length !== 1) return;
    const title = paidReceiptTitle(db, row);
    if (!title) return;
    const r = db.prepare(`
      INSERT INTO shop_order_item_snapshots (order_id, item_a, title, source, fetched_at)
      VALUES (?, ?, ?, 'receipt', ?)
      ON CONFLICT(order_id, item_a) DO NOTHING
    `).run(row.order_id, a, title, now);
    if (r.changes === 1) wrote = true;
  });
  return wrote;
}

/** One-item form, kept for callers of the v1.0 shape. */
export function snapshotOrderItem(db: Database.Database, row: any, listing: ListingInfo | null, now = nowUnix()): boolean {
  return snapshotOrderItems(db, row, [listing], now);
}

/** Fetch the listing of every item of an order (cache hits after the prefetch); null where it fails. */
async function listingsOf(items: Array<{ a?: unknown }>, fetchListing: ListingFetcher): Promise<Array<ListingInfo | null>> {
  return Promise.all(items.map(async it => {
    if (typeof it?.a !== 'string' || !it.a) return null;
    try { return await fetchListing(it.a); } catch { return null; }
  }));
}

const BACKFILL_RETRY_MS = 30 * 60 * 1000;
const backfillTried = new Map<string, number>();

/**
 * Orders with no item snapshot yet — above all the ones the resolver will
 * never look at again (resolved, rejected, shipped…), e.g. every order placed
 * before this table existed. Bounded per tick; an order that found neither a
 * listing nor a receipt is retried after BACKFILL_RETRY_MS (so a few such
 * orders cannot starve the rest). Listing REQs are #d-filtered and go through
 * the same fetcher (one tick's cache) as the resolver's.
 */
export async function backfillItemSnapshots(db: Database.Database, fetchListing: ListingFetcher, limit = 20): Promise<number> {
  const nowMs = Date.now();
  for (const [id, at] of backfillTried) if (nowMs - at > BACKFILL_RETRY_MS) backfillTried.delete(id);
  const rows = (db.prepare(`
    SELECT o.* FROM shop_orders o
    WHERE NOT EXISTS (SELECT 1 FROM shop_order_item_snapshots s WHERE s.order_id = o.order_id)
    ORDER BY o.created_at DESC LIMIT ?
  `).all(Math.max(limit * 10, limit)) as any[]).filter(r => !backfillTried.has(r.order_id)).slice(0, limit);
  if (rows.length === 0) return 0;

  // Same shape as resolveOrders: warm the cache a few at a time so a dead relay
  // set costs one timeout per batch, not one per order.
  const addrs = [...new Set(rows.flatMap(r => itemsOf(r).map(i => i?.a)).filter((a): a is string => typeof a === 'string' && !!a))];
  const CONCURRENCY = 8;
  for (let i = 0; i < addrs.length; i += CONCURRENCY) {
    await Promise.all(addrs.slice(i, i + CONCURRENCY).map(a => fetchListing(a).catch(() => null)));
  }

  let filled = 0;
  for (const row of rows) {
    const listings = await listingsOf(itemsOf(row), fetchListing);
    let wrote = false;
    try { wrote = snapshotOrderItems(db, row, listings); } catch { wrote = false; }
    if (wrote) filled++;
    else backfillTried.set(row.order_id, nowMs);
  }
  return filled;
}

// ─── Resolve (SPEC §8 via orderResolver.ts) ─────────────────────────────

export interface ResolveOptions {
  orderIds?: string[];          // default: every order that can still change
  trusted: Set<string>;
  fetchListing: ListingFetcher;
  now?: number;
  /**
   * Brilly's confirmation of ONE entry of shop_order_settle_review
   * (confirmSettleReview): the purchase the older rules had paid it with is
   * passed as the step-5a pin for exactly that 36520 event — the resolver
   * still requires the NEWEST version of that 30933 to pay that amount.
   */
  confirmed?: { orderId: string; eventId: string; purchase: SettledPurchase };
}

function orderFromRow(r: any): ResolverOrder {
  let items: any[] = [];
  try { items = JSON.parse(r.items_json || '[]'); } catch { items = []; }
  return {
    d: r.order_id, pubkey: r.buyer_pubkey, createdAt: r.created_at, unitId: r.unit_id,
    status: r.order_status, fulfillment: r.fulfillment,
    items: items.map((i: any) => ({ a: String(i.a), qty: Number(i.qty), unitPrice: String(i.unitPrice), currency: String(i.currency) })),
    shipping: r.shipping, total: r.total, currency: r.currency, payBy: r.pay_by,
  };
}

/**
 * Orders whose state can still move: unpaid/expired/amount_mismatch within
 * 7d, anything pending, never resolved. amount_mismatch is here because an
 * order whose listing was not found (a quiet relay) is not computable and so
 * not paid (SPEC v1.1.1) — it must be judged again once the listing answers.
 *
 * Also every 'paid' row that holds a verdict of the OLDER rules (no
 * settled_order_event_id for its current event — see schema.ts), shipped or
 * not, until step 5 has judged it once; and for 7 days an older 'paid' that
 * step 5 did not pay (shop_order_settle_review), so a listing REQ that failed
 * on that first judgement cannot decide it for good.
 */
export function activeOrderIds(db: Database.Database, now = nowUnix()): string[] {
  return (db.prepare(`
    SELECT order_id FROM shop_orders
    WHERE resolved_at IS NULL
       OR pending = 1
       OR (payment_state IN ('unpaid', 'expired', 'amount_mismatch') AND created_at > ?)
       OR (payment_state = 'paid' AND (settled_order_event_id IS NULL OR settled_order_event_id != event_id))
       OR order_id IN (SELECT order_id FROM shop_order_settle_review WHERE cleared_at IS NULL AND listed_at > ?)
  `).all(now - 7 * DAY, now - 7 * DAY) as any[]).map(r => r.order_id);
}

export async function resolveOrders(db: Database.Database, opts: ResolveOptions): Promise<number> {
  const now = opts.now ?? nowUnix();
  const ids = opts.orderIds ?? activeOrderIds(db, now);
  const getOrder = db.prepare('SELECT * FROM shop_orders WHERE order_id = ?');
  const getPurchases = db.prepare('SELECT * FROM shop_order_payments WHERE unit_id = ? AND invoice_number = ?');
  const getFulfillment = db.prepare('SELECT * FROM shop_order_fulfillments WHERE order_id = ?');
  const getSeenPrice = db.prepare('SELECT price, listing_created_at FROM shop_order_listing_prices WHERE order_event_id = ? AND item_a = ?');
  const putSeenPrice = db.prepare(`
    INSERT INTO shop_order_listing_prices (order_event_id, item_a, price, listing_created_at, seen_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(order_event_id, item_a) DO UPDATE SET
      price = excluded.price, listing_created_at = excluded.listing_created_at, seen_at = excluded.seen_at
    WHERE shop_order_listing_prices.price != excluded.price
       OR shop_order_listing_prices.listing_created_at != excluded.listing_created_at
  `);
  const update = db.prepare(`
    UPDATE shop_orders SET
      payment_state = ?, expected_total = ?, price_changed = ?, effective_status = ?, pending = ?,
      paid_signer_hex = ?, paid_tx_id = ?, paid_event_id = ?, paid_customer_hex = ?, paid_amount = ?, paid_lana_amount = ?, paid_at = ?,
      paid_order_event_id = ?, settled_order_event_id = ?,
      fulfillment_status = ?, fulfillment_event_id = ?, fulfillment_pubkey = ?, fulfillment_created_at = ?,
      fulfillment_carrier = ?, fulfillment_tracking = ?, fulfillment_published = ?,
      resolved_at = ?, updated_at = datetime('now')
    WHERE order_id = ?
  `);
  const listForReview = db.prepare(`
    INSERT INTO shop_order_settle_review (order_id, order_event_id, old_paid_tx_id, old_paid_amount, verdict, expected_total, listed_at, cleared_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(order_id) DO UPDATE SET
      order_event_id = excluded.order_event_id, old_paid_tx_id = excluded.old_paid_tx_id,
      old_paid_amount = excluded.old_paid_amount, verdict = excluded.verdict,
      expected_total = excluded.expected_total, listed_at = excluded.listed_at, cleared_at = NULL
  `);
  const clearReview = db.prepare('UPDATE shop_order_settle_review SET cleared_at = ? WHERE order_id = ? AND cleared_at IS NULL');
  // An older 'paid' that step 5 has already judged once and did not pay: its
  // open entry, for exactly the order event that was paid.
  const getOpenReview = db.prepare('SELECT 1 AS open FROM shop_order_settle_review WHERE order_id = ? AND order_event_id = ? AND cleared_at IS NULL');
  // A later judgement of that entry: the verdict moves, the entry (when it was
  // listed, what the older rules had paid) stays — so its 7 days end.
  const rejudgeReview = db.prepare('UPDATE shop_order_settle_review SET verdict = ?, expected_total = ? WHERE order_id = ? AND order_event_id = ? AND cleared_at IS NULL');

  // Warm the listing cache for every distinct address up front, a few at a
  // time. The loop below awaits one fetch per order; with a dead relay set
  // that would serialize a 6s timeout per distinct listing inside a heartbeat
  // whose stuck-lock reset is 120s. Failures are swallowed here — the loop's
  // own fetch (now a cache hit, or null) decides.
  const addresses = new Set<string>();
  for (const id of ids) {
    const row = getOrder.get(id) as any;
    if (!row) continue;
    for (const it of orderFromRow(row).items) if (it.a) addresses.add(it.a);
  }
  const addrList = [...addresses];
  const PREFETCH_CONCURRENCY = 8;
  for (let i = 0; i < addrList.length; i += PREFETCH_CONCURRENCY) {
    await Promise.all(addrList.slice(i, i + PREFETCH_CONCURRENCY).map(a => opts.fetchListing(a).catch(() => null)));
  }

  // The unit each order is judged by, checked once per (unit, owner) per
  // call: a verified 30901 of the shop the order names, or the order is
  // skipped — left exactly as stored, never judged with a foreign or blank
  // unit (moneyUnit).
  const unitsSeen = new Map<string, UnitRow | null>();
  const trustedUnitFor = (unitId: string, ownerHex: string): UnitRow | null => {
    const k = `${unitId}:${ownerHex}`;
    if (!unitsSeen.has(k)) {
      const stored = unitRow(db, unitId);
      const u = moneyUnit(stored, ownerHex);
      if (!u && stored) {
        console.warn(`[orders] unit ${String(unitId).slice(0, 12)}… is not a verified 30901 of the shop its orders name — those orders are not judged`);
      }
      unitsSeen.set(k, u);
    }
    return unitsSeen.get(k)!;
  };

  let resolved = 0;
  for (const id of ids) {
    const row = getOrder.get(id) as any;
    if (!row) continue;
    const unit = trustedUnitFor(row.unit_id, row.unit_owner_hex);
    if (!unit) continue;
    const order = orderFromRow(row);
    const purchases: ResolverPurchase[] = (getPurchases.all(row.unit_id, row.order_id) as any[]).map(p => ({
      pubkey: p.pubkey, eventId: p.event_id, createdAt: p.created_at, txId: p.tx_id, unitId: p.unit_id,
      invoiceNumber: p.invoice_number, receiptDescription: p.receipt_description || '', amount: p.amount || '',
      currency: p.currency || '', lanaAmount: p.lana_amount || '', paymentType: p.payment_type || '',
      status: p.status || '', customerHex: p.customer_hex || '',
    }));
    const fRow = getFulfillment.get(row.order_id) as any;
    const fulfillment: ResolverFulfillment | null = fRow ? {
      pubkey: fRow.pubkey, createdAt: fRow.created_at, status: fRow.status,
      paymentRef: fRow.payment_ref || undefined, carrier: fRow.carrier || undefined, tracking: fRow.tracking || undefined,
    } : null;

    // EVERY item is priced by its own current listing (SPEC v1.1.0): the
    // first item's price applied to all would judge a correctly paid cart
    // amount_mismatch. A listing prices an item only when it is usable for
    // THIS order (SPEC v1.1.2 step 2: on sale, a positive price in the shop's
    // currency, its `a` naming the order's shop). Otherwise the last usable
    // price seen for it while judging this very 36520 event counts (an
    // honest order whose listing was deleted or went off sale, or whose
    // listing REQ failed);
    // else null — the order is then not paid until it is (SPEC v1.1.1): the
    // buyer's own unit_price is never money.
    const resolverUnit = unitToResolver(unit);
    const orderUnitRef = `30901:${row.unit_owner_hex}:${row.unit_id}`;
    const listings = await listingsOf(order.items, opts.fetchListing);
    // A 'paid' the OLDER rules stored (no v1.1.2 pin for this event — see
    // schema.ts) is judged again by step 5 alone, with no pin — priced like
    // every other order. Not by the order-time listing snapshot
    // (shop_order_item_snapshots, display only): it records a price but not
    // the listing's sale status, so it cannot tell an honest order from a
    // buyer's replacement the older rules paid with an off-sale listing at
    // its old price (round 3, x3/m1). An honest order step 5 cannot pay now
    // (repriced, off sale, deleted, other shipping or pickup terms) is listed
    // in shop_order_settle_review, as the portal lists it, and Brilly
    // confirms it (confirmSettleReview).
    //
    // It stays such an order while its entry in shop_order_settle_review is
    // open for this same event, not only while payment_state still says
    // 'paid': the first judgement after deploy writes the new verdict, and a
    // later tick judges it again with no pin and does not list it twice (a
    // step-5 'paid' then pins it and clears the entry). A buyer's
    // replacement is another event: afresh.
    const confirmed = opts.confirmed && opts.confirmed.orderId === row.order_id && opts.confirmed.eventId === row.event_id
      ? opts.confirmed.purchase : null;
    const reviewOpen = !!getOpenReview.get(row.order_id, row.event_id);
    const legacyPaid = !confirmed && row.settled_order_event_id !== row.event_id && (row.payment_state === 'paid' || reviewOpen);
    order.items = order.items.map((it, i) => {
      const l = listings[i];
      const usable = usableListingPrice(l, resolverUnit.currency, orderUnitRef);
      if (usable !== null && l) {
        putSeenPrice.run(row.event_id, it.a, usable, l.createdAt, now);
        return { ...it, listingPrice: usable, listingCreatedAt: l.createdAt };
      }
      const seen = getSeenPrice.get(row.event_id, it.a) as { price: string; listing_created_at: number } | undefined;
      return { ...it, listingPrice: seen ? seen.price : null, listingCreatedAt: seen ? seen.listing_created_at : null };
    });

    // SPEC §8 step 5a: the purchase (tx id + amount) that settled THIS 36520
    // event (same id) keeps it paid through a later price, shipping-fee or
    // pickup change, also when the brain re-signs that 30933; a replaced
    // order is judged afresh. Only a pin this code wrote counts
    // (settled_order_event_id), never paid_order_event_id of an older
    // verdict — or the purchase Brilly confirmed for this very event.
    const settledPurchase: SettledPurchase | null = confirmed ?? (!legacyPaid && row.payment_state === 'paid' && row.paid_tx_id && row.paid_amount
      && row.settled_order_event_id && row.settled_order_event_id === row.event_id
      ? { txId: String(row.paid_tx_id), amount: String(row.paid_amount) } : null);

    const r = resolveOrder({
      order, purchases, fulfillment, unit: resolverUnit,
      trustedSigners: opts.trusted, now,
      settledPurchase,
    });

    const paidPurchase = r.paidBy ? purchases.find(p => p.eventId === r.paidBy!.eventId) || null : null;
    const signerOk = !!fRow && unitSigners(unit).includes(fRow.pubkey);
    const paidNow = r.paymentState === 'paid';
    update.run(
      r.paymentState, r.expected, r.priceChanged ? 1 : 0, r.effectiveStatus, r.pending ? 1 : 0,
      paidPurchase?.pubkey ?? null, r.paidBy?.txId ?? null, r.paidBy?.eventId ?? null, r.paidBy?.customerHex ?? null,
      r.paidBy?.amount ?? null, r.paidBy?.lanaAmount ?? null, paidPurchase?.createdAt ?? null,
      paidNow ? row.event_id : null, paidNow ? row.event_id : null,
      signerOk ? fRow.status : null, signerOk ? fRow.event_id : null, signerOk ? fRow.pubkey : null,
      signerOk ? fRow.created_at : null, signerOk ? fRow.carrier : null, signerOk ? fRow.tracking : null,
      signerOk ? fRow.published : 1,
      now, row.order_id,
    );
    resolved++;
    // An older 'paid' that step 5 does not pay is listed for Brilly, not
    // paid; a later paid verdict clears the entry.
    if (legacyPaid && !paidNow) {
      if (reviewOpen) {
        rejudgeReview.run(r.paymentState, r.expected, row.order_id, row.event_id);
      } else {
        listForReview.run(row.order_id, row.event_id, row.paid_tx_id ?? null, row.paid_amount ?? null, r.paymentState, r.expected, now);
        console.warn(`[orders] order ${String(row.order_id).slice(0, 12)}…: 'paid' under the older rules, ${r.paymentState} under SPEC v1.1.2 — not paid, listed in shop_order_settle_review`);
      }
    } else if (paidNow) {
      clearReview.run(now, row.order_id);
    }

    // What was ordered, for the merchant's screen — from the listing already
    // fetched above (no extra REQ). Display only: after the money row is
    // written, and a failure here never touches it.
    try {
      snapshotOrderItems(db, { ...row, paid_event_id: r.paidBy?.eventId ?? null }, listings, now);
    } catch (e) {
      console.warn(`[orders] item snapshot failed order=${String(row.order_id).slice(0, 12)}…: ${(e as Error)?.message || e}`);
    }
  }
  return resolved;
}

// ─── Brilly's word on an older 'paid' that step 5 does not pay ──────────

export interface SettleReviewEntry {
  order_id: string; order_event_id: string | null; old_paid_tx_id: string | null; old_paid_amount: string | null;
  verdict: string; expected_total: string | null; listed_at: number; cleared_at: number | null; confirmed_at: number | null;
  /** the order as stored now */
  current_event_id: string | null; payment_state: string | null; unit_id: string | null; items_json: string | null;
}

/** Open entries of shop_order_settle_review with the order as stored now, oldest first. */
export function listSettleReview(db: Database.Database): SettleReviewEntry[] {
  return db.prepare(`
    SELECT r.order_id, r.order_event_id, r.old_paid_tx_id, r.old_paid_amount, r.verdict, r.expected_total,
           r.listed_at, r.cleared_at, r.confirmed_at,
           o.event_id AS current_event_id, o.payment_state, o.unit_id, o.items_json
      FROM shop_order_settle_review r LEFT JOIN shop_orders o ON o.order_id = r.order_id
     WHERE r.cleared_at IS NULL
     ORDER BY r.listed_at, r.order_id
  `).all() as SettleReviewEntry[];
}

export type ConfirmSettleReviewResult =
  | { ok: true; paymentState: 'paid'; expected: string }
  | { ok: false; reason: 'no_open_entry' | 'order_replaced' | 'event_mismatch' | 'no_old_payment' | 'unit_unknown' | 'not_paid'; paymentState?: string };

/**
 * Brilly confirms ONE open entry of shop_order_settle_review as honest
 * (round 3, 2 Oct 2026): after checking the order against what the broker
 * took and checked at order time, he names its order id and the 36520 event
 * id he checked. The purchase the older rules had paid it with
 * (old_paid_tx_id, old_paid_amount) becomes the step-5a pin of exactly that
 * event, and the order is judged by the resolver at once — so it is paid
 * only while the NEWEST version of that 30933 still pays that amount for
 * this order (a cancellation un-pays it, as for every pin).
 *
 * Refused — nothing written — when no entry is open for the order, the
 * stored 36520 is no longer the event that was listed (the buyer replaced
 * it since: that is another order), the event id given is not the stored
 * one, the entry holds no old payment, or the shop is unknown. Never called
 * by the app itself.
 */
export async function confirmSettleReview(
  db: Database.Database,
  orderId: string,
  expectEventId: string,
  opts: { trusted: Set<string>; fetchListing?: ListingFetcher; now?: number },
): Promise<ConfirmSettleReviewResult> {
  const now = opts.now ?? nowUnix();
  const entry = db.prepare('SELECT * FROM shop_order_settle_review WHERE order_id = ? AND cleared_at IS NULL').get(orderId) as any;
  if (!entry) return { ok: false, reason: 'no_open_entry' };
  const row = db.prepare('SELECT * FROM shop_orders WHERE order_id = ?').get(orderId) as any;
  if (!row || !entry.order_event_id || entry.order_event_id !== row.event_id) return { ok: false, reason: 'order_replaced' };
  if (expectEventId !== row.event_id) return { ok: false, reason: 'event_mismatch' };
  const cents = toCents(entry.old_paid_amount);
  if (!entry.old_paid_tx_id || cents === null || cents <= 0) return { ok: false, reason: 'no_old_payment' };
  if (!moneyUnit(unitRow(db, row.unit_id), row.unit_owner_hex)) return { ok: false, reason: 'unit_unknown' };
  await resolveOrders(db, {
    orderIds: [orderId], trusted: opts.trusted, now,
    // the pin needs no listing; nothing is fetched for a confirmation
    fetchListing: opts.fetchListing ?? (async () => null),
    confirmed: { orderId, eventId: row.event_id, purchase: { txId: String(entry.old_paid_tx_id), amount: String(entry.old_paid_amount) } },
  });
  const after = db.prepare('SELECT payment_state, expected_total, settled_order_event_id, event_id FROM shop_orders WHERE order_id = ?').get(orderId) as any;
  if (after?.payment_state !== 'paid' || after.settled_order_event_id !== row.event_id) {
    return { ok: false, reason: 'not_paid', paymentState: after?.payment_state };
  }
  db.prepare('UPDATE shop_order_settle_review SET confirmed_at = ? WHERE order_id = ? AND order_event_id = ?').run(now, orderId, row.event_id);
  return { ok: true, paymentState: 'paid', expected: String(after.expected_total ?? '') };
}

// ─── Republish our own fulfillments no relay has accepted yet ───────────

export async function republishUnpublished(db: Database.Database, relays: string[], limit = 20): Promise<number> {
  const rows = db.prepare('SELECT order_id, event_id, raw_event FROM shop_order_fulfillments WHERE published = 0 LIMIT ?').all(limit) as any[];
  let ok = 0;
  for (const r of rows) {
    try {
      const ev = JSON.parse(r.raw_event);
      const res = await broadcastEvent(ev, relays);
      if (res.success.length > 0) {
        db.prepare('UPDATE shop_order_fulfillments SET published = 1 WHERE order_id = ? AND event_id = ?').run(r.order_id, r.event_id);
        db.prepare('UPDATE shop_orders SET fulfillment_published = 1 WHERE order_id = ? AND fulfillment_event_id = ?').run(r.order_id, r.event_id);
        ok++;
      }
    } catch { /* next tick */ }
  }
  return ok;
}

// ─── The heartbeat entry point ──────────────────────────────────────────

const SAFETY_NET_EVERY = 60;         // ticks (≈ hourly at the 1-min heartbeat)
const CURSOR_OVERLAP = 6 * 3600;     // tolerate late-published events + relay clock skew
const PAGE_HINT = 300;               // a relay that returns this many probably capped the REQ
const TX_IDS_PER_REQ = 100;          // #d values per 30933 REQ (each has ≤ 1 version per signer on a relay)
const TERMINAL_RECHECK_EVERY = 5;    // ticks between re-reads of rejected/shipped/delivered orders' 30933
const TERMINAL_RECHECK_DAYS = 60;    // …paid (brain-signed paid_at) at most this long ago
const TERMINAL_RECHECK_LIMIT = 2000; // …newest first, at most this many tx ids per tick
const BY_TX_PARALLEL = 4;            // 30933 by-tx REQ chunks in flight at once (a dead relay costs ≤ ⌈chunks/4⌉ timeouts)

function readState(db: Database.Database, key: string): string | null {
  return (db.prepare('SELECT value FROM shop_order_sync_state WHERE key = ?').get(key) as any)?.value ?? null;
}
function writeState(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO shop_order_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

/**
 * One REQ per relay, paged backwards with `until` when a relay looks capped.
 * De-duped by id. The filter carries an explicit `limit` = PAGE_HINT so a
 * relay that honours NIP-01 `limit` returns exactly PAGE_HINT newest events
 * when there are more — which is what triggers the next page. Without it a
 * relay whose own default cap is below PAGE_HINT would truncate silently.
 */
async function fetchKind(relays: string[], filter: Record<string, any>, timeout: number, maxPages = 5): Promise<SignedEvent[]> {
  const byId = new Map<string, SignedEvent>();
  const base = { ...filter, limit: PAGE_HINT };
  await Promise.all(relays.map(async (url) => {
    let until: number | undefined;
    for (let page = 0; page < maxPages; page++) {
      const f = until ? { ...base, until } : base;
      let events: SignedEvent[] = [];
      try { events = await queryEvents([url], f, timeout); } catch { events = []; }
      let oldest = Infinity;
      for (const ev of events) {
        if (ev && typeof ev.id === 'string' && !byId.has(ev.id)) byId.set(ev.id, ev);
        if (ev && typeof ev.created_at === 'number' && ev.created_at < oldest) oldest = ev.created_at;
      }
      if (events.length < PAGE_HINT || !Number.isFinite(oldest)) break;
      until = oldest - 1;
      if (until <= (filter.since || 0)) break;
    }
  }));
  return [...byId.values()];
}

export interface SyncStats {
  relays: number; trusted: number; fetched: Record<string, number>; touched: number; resolved: number; backfilled: number; republished: number; safetyNet: boolean;
  /** set when nothing was synced because the orders schema check failed (schema.ts assertOrdersSchema) */
  skipped?: 'orders_schema';
}

/**
 * The tx ids whose 30933 step 2b re-reads this tick: every paid order still
 * pending; and, every TERMINAL_RECHECK_EVERY-th tick, the paid orders the
 * merchant may still refund or has handed over — rejected, shipped, delivered
 * (OrderDetailSheet CAN_REFUND) — paid within TERMINAL_RECHECK_DAYS by the
 * brain-signed paid_at (never the buyer's created_at alone), newest first,
 * at most TERMINAL_RECHECK_LIMIT.
 */
export function txIdsToRecheck(db: Database.Database, now: number, withTerminal: boolean): string[] {
  const out = new Set<string>();
  for (const r of db.prepare(`
    SELECT DISTINCT paid_tx_id AS tx FROM shop_orders
    WHERE payment_state = 'paid' AND pending = 1 AND paid_tx_id IS NOT NULL AND paid_tx_id != ''
  `).all() as Array<{ tx: string }>) out.add(r.tx);
  if (withTerminal) {
    for (const r of db.prepare(`
      SELECT paid_tx_id AS tx FROM shop_orders
      WHERE payment_state = 'paid' AND effective_status IN ('rejected', 'shipped', 'delivered')
        AND paid_tx_id IS NOT NULL AND paid_tx_id != ''
        AND COALESCE(paid_at, created_at) > ?
      GROUP BY paid_tx_id
      ORDER BY MAX(COALESCE(paid_at, created_at)) DESC
      LIMIT ?
    `).all(now - TERMINAL_RECHECK_DAYS * DAY, TERMINAL_RECHECK_LIMIT) as Array<{ tx: string }>) out.add(r.tx);
  }
  return [...out];
}

/**
 * Read ONE purchase's 30933 (d = tx id, trusted signers only) from the relays
 * now and ingest whatever version they hold. 'read' when at least one relay
 * finished the REQ (EOSE) — what it served is ingested; 'unreadable' when
 * none did (or there is no relay, tx id or trusted signer): then the caller
 * cannot know whether the brain cancelled it and must not act on money.
 */
export async function refreshPurchaseByTx(
  db: Database.Database, relays: string[], trusted: Set<string>, txId: string, timeout = 6000,
): Promise<'read' | 'unreadable'> {
  if (!txId || trusted.size === 0 || relays.length === 0) return 'unreadable';
  const reads = await Promise.all(relays.map(url => reqUntilEose(url, [
    { kinds: [KIND_PURCHASE], authors: [...trusted], '#d': [txId] },
  ], timeout)));
  const finished = reads.filter((r): r is SignedEvent[] => r !== null);
  if (finished.length === 0) return 'unreadable';
  for (const ev of finished.flat()) {
    if (ev && ev.kind === KIND_PURCHASE && tag(ev, 'd') === txId) ingestEvent(db, ev, trusted);
  }
  return 'read';
}

export async function syncShopOrders(db: Database.Database, relaysFromHeartbeat?: string[]): Promise<SyncStats> {
  if (!ordersSchemaOk(db)) {
    console.error('[orders] sync SKIPPED — the orders schema check failed at startup (see the ERROR line from assertOrdersSchema)');
    return { relays: 0, trusted: 0, fetched: {}, touched: 0, resolved: 0, backfilled: 0, republished: 0, safetyNet: false, skipped: 'orders_schema' };
  }
  const relays = readRelays(db, relaysFromHeartbeat);
  const trusted = readTrustedSigners(db);
  const now = nowUnix();
  const tick = (parseInt(readState(db, 'tick') || '0', 10) || 0) + 1;
  writeState(db, 'tick', String(tick));
  const safetyNet = tick % SAFETY_NET_EVERY === 1;
  const terminalTick = tick % TERMINAL_RECHECK_EVERY === 1;

  const sinceFor = (kind: number): number => {
    const cursor = parseInt(readState(db, `since_${kind}`) || '', 10);
    if (!Number.isFinite(cursor)) return now - 30 * DAY;          // very first run
    if (safetyNet) return Math.min(cursor - CURSOR_OVERLAP, now - 7 * DAY);
    return Math.max(0, cursor - CURSOR_OVERLAP);
  };
  const advanceCursor = (kind: number, events: SignedEvent[]) => {
    const max = events.reduce((m, e) => (typeof e.created_at === 'number' && e.created_at > m ? e.created_at : m), 0);
    const prev = parseInt(readState(db, `since_${kind}`) || '0', 10) || 0;
    if (max > prev) writeState(db, `since_${kind}`, String(Math.min(max, now + 300)));
  };

  const touched = new Set<string>();
  const fetched: Record<string, number> = {};

  // 1) Buyer/merchant kinds (low volume): 36520 first so 36521/36522 can join.
  const [orders, fulfillments, deliveries] = await Promise.all([
    fetchKind(relays, { kinds: [KIND_ORDER], since: sinceFor(KIND_ORDER) }, 15000),
    fetchKind(relays, { kinds: [KIND_FULFILLMENT], since: sinceFor(KIND_FULFILLMENT) }, 15000),
    fetchKind(relays, { kinds: [KIND_DELIVERY], since: sinceFor(KIND_DELIVERY) }, 15000),
  ]);
  fetched['36520'] = orders.length; fetched['36521'] = fulfillments.length; fetched['36522'] = deliveries.length;
  for (const list of [orders, fulfillments, deliveries]) {
    for (const ev of list) { const id = ingestEvent(db, ev, trusted); if (id) touched.add(id); }
  }
  advanceCursor(KIND_ORDER, orders); advanceCursor(KIND_FULFILLMENT, fulfillments); advanceCursor(KIND_DELIVERY, deliveries);

  // 2) 30933 — trusted authors only, and only for the window in which an order
  //    of ours can still be paid (bounded: no open orders ⇒ no window REQ),
  //    plus (2b) the paid orders' own 30933 by tx id.
  fetched['30933'] = 0;
  if (trusted.size > 0) {
    const open = db.prepare(`
      SELECT MIN(created_at) AS oldest FROM shop_orders
      WHERE payment_state IN ('unpaid', 'expired') AND created_at > ?
    `).get(now - 7 * DAY) as any;
    if (open?.oldest) {
      const cursor = parseInt(readState(db, `since_${KIND_PURCHASE}`) || '', 10);
      const since = safetyNet || !Number.isFinite(cursor)
        ? open.oldest - 600
        : Math.max(open.oldest - 600, cursor - CURSOR_OVERLAP);
      const purchases = await fetchKind(relays, { kinds: [KIND_PURCHASE], authors: [...trusted], since }, 15000, 10);
      fetched['30933'] = purchases.length;
      for (const ev of purchases) { const id = ingestEvent(db, ev, trusted); if (id) touched.add(id); }
      advanceCursor(KIND_PURCHASE, purchases);
    }

    // 2b) The 30933 of every PAID order not yet shipped/finished, by its tx id
    //     (= the 30933 d), whether or not any order is open. When the brain
    //     cancels a purchase it republishes that d with status 'cancelled';
    //     the window read above only runs while some order is unpaid, so a
    //     cancellation published while none is would be missed for good and
    //     the merchant could ship a cancelled order. Every 5th tick also the
    //     rejected / shipped / delivered ones (txIdsToRecheck): the merchant
    //     can still refund those, and a refund of a cancelled payment pays
    //     out money that never came in (round 5, F5). Exact #d reads, chunked
    //     (a relay answers ≤ 500 per REQ), a few chunks at a time; the cursor
    //     is not moved by them.
    const paidTx = txIdsToRecheck(db, now, terminalTick);
    const chunks: string[][] = [];
    for (let i = 0; i < paidTx.length; i += TX_IDS_PER_REQ) chunks.push(paidTx.slice(i, i + TX_IDS_PER_REQ));
    let byTx = 0;
    for (let i = 0; i < chunks.length; i += BY_TX_PARALLEL) {
      const lists = await Promise.all(chunks.slice(i, i + BY_TX_PARALLEL).map(ids =>
        fetchKind(relays, { kinds: [KIND_PURCHASE], authors: [...trusted], '#d': ids }, 15000)));
      for (const evs of lists) {
        byTx += evs.length;
        for (const ev of evs) { const id = ingestEvent(db, ev, trusted); if (id) touched.add(id); }
      }
    }
    fetched['30933_by_tx'] = byTx;
    fetched['30933_by_tx_ids'] = paidTx.length;
  } else {
    console.warn('[orders] no trusted signers in KIND 38888 — purchases are NOT synced (fail-closed)');
  }

  // 3) Resolve everything that moved or can still move.
  const ids = new Set<string>([...touched, ...activeOrderIds(db, now)]);
  const fetchListing = makeListingFetcher(relays);
  const resolved = await resolveOrders(db, { orderIds: [...ids], trusted, fetchListing, now });

  // 3b) Item names for orders the resolver no longer visits (display only).
  let backfilled = 0;
  try { backfilled = await backfillItemSnapshots(db, fetchListing); } catch (e) {
    console.warn(`[orders] item backfill failed: ${(e as Error)?.message || e}`);
  }

  // 4) Our own fulfillments that no relay accepted at POST time.
  const republished = await republishUnpublished(db, relays);

  const stats: SyncStats = { relays: relays.length, trusted: trusted.size, fetched, touched: touched.size, resolved, backfilled, republished, safetyNet };
  console.log(`[orders] sync: 36520=${fetched['36520']} 36521=${fetched['36521']} 36522=${fetched['36522']} 30933=${fetched['30933']} 30933_by_tx=${fetched['30933_by_tx'] ?? 0} touched=${touched.size} resolved=${resolved} items_backfilled=${backfilled} republished=${republished}${safetyNet ? ' (safety net)' : ''}`);
  return stats;
}
