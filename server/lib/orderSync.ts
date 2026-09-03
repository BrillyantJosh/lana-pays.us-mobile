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
import { verifyEvent } from 'nostr-tools/pure';
import { queryEvents, type SignedEvent } from './dm.js';
import { getLanaRelays, broadcastEvent } from './nostr.js';
import { SIMPLE_UNIT_SQL } from './unitOrigin.js';
import {
  resolveOrder, ORDER_ID_RE, orderIdMatchesPubkey, toCents,
  type ResolverOrder, type ResolverPurchase, type ResolverFulfillment, type ResolverUnit,
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

/** KIND 30901 v1.2.0 online-shop tags (SPEC §6) → resolver unit. Absent fee == '0.00'. */
export function unitToResolver(u: UnitRow): ResolverUnit {
  let shippingFee = '0.00';
  let freeShippingFrom: string | null = null;
  try {
    const ev = u.raw_event ? JSON.parse(u.raw_event) : null;
    const fee = ev ? tag(ev, 'online_shop_shipping_fee') : undefined;
    const free = ev ? tag(ev, 'online_shop_free_shipping_from') : undefined;
    if (fee && toCents(fee) !== null) shippingFee = fee;
    if (free && toCents(free) !== null) freeShippingFrom = free;
  } catch { /* defaults */ }
  return {
    ownerHex: u.owner_hex,
    staffHexes: unitSigners(u).filter(h => h !== u.owner_hex),
    currency: String(u.currency || '').toUpperCase(),
    shippingFee,
    freeShippingFrom,
  };
}

// ─── Parsers (tag layouts frozen in SPEC §2–§4, §7) ─────────────────────

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
    const [kindS, owner] = String(addr || '').split(':');
    const qty = Number(qtyS);
    if (!/^\d+$/.test(kindS || '') || !HEX64.test(owner || '') || !Number.isInteger(qty) || qty <= 0) return null;
    if (toCents(unitPrice) === null || !cur) return null;
    items.push({ a: addr, kind: Number(kindS), qty, saleUnit: saleUnit || '', unitPrice, currency: cur });
  }
  if (items.length === 0) return null;
  // v1: exactly one item; every item must belong to the unit owner.
  if (items.length !== 1 || items[0].a.split(':')[1] !== aOwner) return null;

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
  const unit = unitRow(db, o.unitId);
  if (!unit) return null; // not our unit (or a simple.lanapays.us one)
  // Poisoned-mirror defence: the order must point at the identity that signed the 30901.
  if (o.unitOwnerHex !== unit.owner_hex && o.unitOwnerHex !== unit.pubkey) return null;

  const existing = db.prepare('SELECT buyer_pubkey, created_at, event_id FROM shop_orders WHERE order_id = ?').get(o.d) as any;
  if (existing) {
    if (existing.buyer_pubkey !== o.pubkey) return null;          // NIP-33 replace is per (pubkey, d)
    if (o.createdAt <= existing.created_at) return null;          // NIP-33 newest wins (same event = no-op)
  }
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
  const unit = unitRow(db, f.unitId);
  if (!unit || !unitSigners(unit).includes(f.pubkey)) return null;
  const order = db.prepare('SELECT unit_id, buyer_pubkey FROM shop_orders WHERE order_id = ?').get(f.d) as any;
  if (order && order.unit_id !== f.unitId) return null;
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
  const existing = db.prepare('SELECT created_at FROM shop_order_payments WHERE pubkey = ? AND tx_id = ?').get(p.pubkey, p.txId) as any;
  if (existing && p.createdAt <= existing.created_at) return null;
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

export interface ListingInfo { price: string | null; currency: string; status: string; createdAt: number }
export type ListingFetcher = (address: string) => Promise<ListingInfo | null>;

const listingCache = new Map<string, { info: ListingInfo | null; fetchedAt: number }>();
const LISTING_TTL_MS = 10 * 60 * 1000;

/** REQ the listing event `<kind>:<pubkey>:<d>`; newest signed by that pubkey wins. */
export function makeListingFetcher(relays: string[], timeout = 6000): ListingFetcher {
  return async (address: string) => {
    const cached = listingCache.get(address);
    if (cached && Date.now() - cached.fetchedAt < LISTING_TTL_MS) return cached.info;
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
        const price = tagRow(best, 'price');
        info = {
          price: price && toCents(price[1]) !== null ? price[1] : null,
          currency: price?.[2] || '',
          status: tag(best, 'status') || 'active',
          createdAt: best.created_at,
        };
      }
    } catch { info = null; }
    if (info === null && cached) return cached.info; // relay hiccup: keep the last known signed price
    listingCache.set(address, { info, fetchedAt: Date.now() });
    return info;
  };
}

export function clearListingCache(): void { listingCache.clear(); }

// ─── Resolve (SPEC §8 via orderResolver.ts) ─────────────────────────────

export interface ResolveOptions {
  orderIds?: string[];          // default: every order that can still change
  trusted: Set<string>;
  fetchListing: ListingFetcher;
  now?: number;
}

function orderFromRow(r: any): ResolverOrder {
  let items: any[] = [];
  try { items = JSON.parse(r.items_json || '[]'); } catch { items = []; }
  return {
    d: r.order_id, pubkey: r.buyer_pubkey, createdAt: r.created_at, unitId: r.unit_id,
    status: r.order_status, fulfillment: r.fulfillment,
    items: items.map((i: any) => ({ a: String(i.a), qty: Number(i.qty), unitPrice: String(i.unitPrice), currency: String(i.currency) })),
    total: r.total, currency: r.currency, payBy: r.pay_by,
  };
}

/** Orders whose state can still move: unpaid/expired within 7d, anything pending, never resolved. */
export function activeOrderIds(db: Database.Database, now = nowUnix()): string[] {
  return (db.prepare(`
    SELECT order_id FROM shop_orders
    WHERE resolved_at IS NULL
       OR pending = 1
       OR (payment_state IN ('unpaid', 'expired') AND created_at > ?)
  `).all(now - 7 * DAY) as any[]).map(r => r.order_id);
}

export async function resolveOrders(db: Database.Database, opts: ResolveOptions): Promise<number> {
  const now = opts.now ?? nowUnix();
  const ids = opts.orderIds ?? activeOrderIds(db, now);
  const getOrder = db.prepare('SELECT * FROM shop_orders WHERE order_id = ?');
  const getPurchases = db.prepare('SELECT * FROM shop_order_payments WHERE unit_id = ? AND invoice_number = ?');
  const getFulfillment = db.prepare('SELECT * FROM shop_order_fulfillments WHERE order_id = ?');
  const update = db.prepare(`
    UPDATE shop_orders SET
      payment_state = ?, expected_total = ?, price_changed = ?, effective_status = ?, pending = ?,
      paid_signer_hex = ?, paid_tx_id = ?, paid_event_id = ?, paid_customer_hex = ?, paid_amount = ?, paid_lana_amount = ?, paid_at = ?,
      fulfillment_status = ?, fulfillment_event_id = ?, fulfillment_pubkey = ?, fulfillment_created_at = ?,
      fulfillment_carrier = ?, fulfillment_tracking = ?, fulfillment_published = ?,
      resolved_at = ?, updated_at = datetime('now')
    WHERE order_id = ?
  `);

  // Warm the listing cache for every distinct address up front, a few at a
  // time. The loop below awaits one fetch per order; with a dead relay set
  // that would serialize a 6s timeout per distinct listing inside a heartbeat
  // whose stuck-lock reset is 120s. Failures are swallowed here — the loop's
  // own fetch (now a cache hit, or null) decides.
  const addresses = new Set<string>();
  for (const id of ids) {
    const row = getOrder.get(id) as any;
    if (!row) continue;
    const a = orderFromRow(row).items[0]?.a;
    if (a) addresses.add(a);
  }
  const addrList = [...addresses];
  const PREFETCH_CONCURRENCY = 8;
  for (let i = 0; i < addrList.length; i += PREFETCH_CONCURRENCY) {
    await Promise.all(addrList.slice(i, i + PREFETCH_CONCURRENCY).map(a => opts.fetchListing(a).catch(() => null)));
  }

  let resolved = 0;
  for (const id of ids) {
    const row = getOrder.get(id) as any;
    if (!row) continue;
    const unit = unitRow(db, row.unit_id);
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

    let listing: ListingInfo | null = null;
    if (order.items[0]) {
      try { listing = await opts.fetchListing(order.items[0].a); } catch { listing = null; }
    }

    const r = resolveOrder({
      order, purchases, fulfillment, unit: unitToResolver(unit),
      listingPrice: listing?.price ?? null,
      listingCreatedAt: listing ? listing.createdAt : null,
      trustedSigners: opts.trusted, now,
    });

    const paidPurchase = r.paidBy ? purchases.find(p => p.eventId === r.paidBy!.eventId) || null : null;
    const signerOk = !!fRow && unitSigners(unit).includes(fRow.pubkey);
    update.run(
      r.paymentState, r.expected, r.priceChanged ? 1 : 0, r.effectiveStatus, r.pending ? 1 : 0,
      paidPurchase?.pubkey ?? null, r.paidBy?.txId ?? null, r.paidBy?.eventId ?? null, r.paidBy?.customerHex ?? null,
      r.paidBy?.amount ?? null, r.paidBy?.lanaAmount ?? null, paidPurchase?.createdAt ?? null,
      signerOk ? fRow.status : null, signerOk ? fRow.event_id : null, signerOk ? fRow.pubkey : null,
      signerOk ? fRow.created_at : null, signerOk ? fRow.carrier : null, signerOk ? fRow.tracking : null,
      signerOk ? fRow.published : 1,
      now, row.order_id,
    );
    resolved++;
  }
  return resolved;
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
  relays: number; trusted: number; fetched: Record<string, number>; touched: number; resolved: number; republished: number; safetyNet: boolean;
}

export async function syncShopOrders(db: Database.Database, relaysFromHeartbeat?: string[]): Promise<SyncStats> {
  const relays = readRelays(db, relaysFromHeartbeat);
  const trusted = readTrustedSigners(db);
  const now = nowUnix();
  const tick = (parseInt(readState(db, 'tick') || '0', 10) || 0) + 1;
  writeState(db, 'tick', String(tick));
  const safetyNet = tick % SAFETY_NET_EVERY === 1;

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
  //    of ours can still be paid (bounded: no open orders ⇒ no purchase REQ).
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
  } else {
    console.warn('[orders] no trusted signers in KIND 38888 — purchases are NOT synced (fail-closed)');
  }

  // 3) Resolve everything that moved or can still move.
  const ids = new Set<string>([...touched, ...activeOrderIds(db, now)]);
  const resolved = await resolveOrders(db, { orderIds: [...ids], trusted, fetchListing: makeListingFetcher(relays), now });

  // 4) Our own fulfillments that no relay accepted at POST time.
  const republished = await republishUnpublished(db, relays);

  const stats: SyncStats = { relays: relays.length, trusted: trusted.size, fetched, touched: touched.size, resolved, republished, safetyNet };
  console.log(`[orders] sync: 36520=${fetched['36520']} 36521=${fetched['36521']} 36522=${fetched['36522']} 30933=${fetched['30933']} touched=${touched.size} resolved=${resolved} republished=${republished}${safetyNet ? ' (safety net)' : ''}`);
  return stats;
}
