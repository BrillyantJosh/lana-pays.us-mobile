/**
 * Lana Online Shop — merchant "Orders" routes (SPEC §9.4).
 *
 * Reads trust the client hex (same pattern as /api/business-units/:hexId and
 * the Lana-online payment requests); the ONE write — publishing a KIND 36521
 * fulfillment — is gated on the event's own signature: verifyEvent, signer ==
 * hex, hex ∈ owner/staff of the order's unit, d == order, monotonic status,
 * and the order must be PAID (a brain-signed 30933 resolved by orderSync).
 *
 * NO PII passes through here: the buyer's delivery details are returned as the
 * raw NIP-44 ciphertext event (36522) addressed to THIS hex, decrypted only in
 * the merchant's browser.
 */

import type Database from 'better-sqlite3';
import type { Express } from 'express';
import { verifyEvent } from 'nostr-tools/pure';
import { HEX64, unitForMerchant, unitIdsForMerchant } from './lib/merchantAuth.js';
import { broadcastEvent } from './lib/nostr.js';
import { gate } from './lib/exclusionGate.js';
import {
  KIND_FULFILLMENT, FULFILLMENT_RANK, parseFulfillmentEvent, upsertFulfillmentRow, readRelays, unitRow, unitSigners,
  paidReceiptTitle,
} from './lib/orderSync.js';
import { toCents, centsToString } from './lib/orderResolver.js';
import type { SignedEvent } from './lib/dm.js';

const TERMINAL = new Set(['shipped', 'delivered', 'completed', 'rejected', 'refunded']);
const CREATED_AT_SKEW = 10 * 60; // seconds

/**
 * Every tag name a KIND 36521 may carry (SPEC §3).
 *
 * This server BROADCASTS the merchant's event verbatim to the public relays, and
 * it is signed in OrderDetailSheet — the one component that holds the buyer's
 * DECRYPTED name, phone and address. Without an allowlist, the obvious way to
 * put a delivery note on the seller's screen ("just add the ship-to to the
 * event") silently publishes that address to the world, and nothing here would
 * have said no. PII belongs only in the NIP-44 ciphertext of KIND 36522.
 *
 * Anything not on this list is refused rather than stripped: silently dropping a
 * tag would let a client believe it had recorded something it had not.
 */
const FULFILLMENT_TAGS = new Set([
  'd', 'a', 'p', 'unit_id', 'status', 'payment',
  'carrier', 'tracking', 'shipped_at', 'delivered_at', 'eta', 'refund', 'v',
]);

function parseItems(json: string): any[] {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * The buyer's item tags, plus WHAT they are: the listing's title / šifra /
 * package size as snapshotted at order time (orderSync snapshotOrderItem),
 * else the title from the paid 30933 receipt.
 *
 * Every number and the sale unit on the merchant's screen come from the
 * MERCHANT-signed listing snapshot when there is one (review 2 Oct 2026): the
 * buyer's key signs the 36520 and may re-sign it with any unit_price or sale
 * unit ("crate"), so those are kept only as buyerUnitPrice / buyerSaleUnit.
 * Without a listing snapshot (or one in another currency) the buyer's values
 * are all there is to show; a 'paid' order's are the merchant's anyway
 * (resolver step 5 pays only an order whose own numbers are the listing's).
 *
 * A snapshot whose listing version was published AFTER the order (taken by a
 * later sync or the backfill, when no earlier version was left on the
 * relays) is not what the buyer ordered: for a PAID order the buyer's line
 * stands — its unit_price is the one step 5 checked against the listing —
 * and the later listing's sale unit, when it differs, is only reported as
 * listingSaleUnit with saleUnitChanged (third review 2 Oct 2026). An unpaid
 * order is judged on the current listing, so it keeps showing that.
 */
function itemsView(db: Database.Database, r: any): any[] {
  const items = parseItems(r.items_json);
  const snaps = db.prepare(
    'SELECT item_a, title, sku, weight, sale_unit, price, currency, source, listing_created_at FROM shop_order_item_snapshots WHERE order_id = ?'
  ).all(r.order_id) as Array<{ item_a: string; title: string | null; sku: string | null; weight: string | null; sale_unit: string | null; price: string | null; currency: string | null; source: string; listing_created_at: number | null }>;
  const paid = r.payment_state === 'paid';
  const byA = new Map(snaps.map(s => [s.item_a, s]));
  let receipt: string | null | undefined;
  return items.map(it => {
    const s = byA.get(String(it?.a));
    let title = s?.title || null;
    if (!title) {
      if (receipt === undefined) receipt = paidReceiptTitle(db, r);
      title = receipt;
    }
    const fromListing = s?.source === 'listing';
    // a later version stands in for what was ordered only while nothing is paid
    const laterListing = fromListing && !(typeof s?.listing_created_at === 'number' && s.listing_created_at <= Number(r.created_at));
    const useListing = fromListing && !(paid && laterListing);
    const listingPrice = useListing && toCents(s?.price) !== null && String(s?.currency || '').toUpperCase() === String(r.currency || '').toUpperCase()
      ? String(s!.price) : null;
    const unitPrice = listingPrice ?? String(it?.unitPrice ?? '');
    const saleUnit = useListing ? String(s?.sale_unit ?? '') : String(it?.saleUnit ?? '');
    const later = fromListing && !useListing && String(s?.sale_unit ?? '') !== String(it?.saleUnit ?? '') ? String(s?.sale_unit ?? '') : null;
    const cents = toCents(unitPrice);
    const qty = Number(it?.qty);
    const lineTotal = cents !== null && Number.isInteger(qty) && qty > 0 ? centsToString(cents * qty) : null;
    return {
      ...it, unitPrice, saleUnit, buyerUnitPrice: it?.unitPrice ?? null, buyerSaleUnit: it?.saleUnit ?? null,
      saleUnitChanged: later !== null, listingSaleUnit: later,
      title, sku: s?.sku || null, weight: s?.weight || null, lineTotal,
    };
  });
}

/**
 * The amount the merchant's screen shows for an order — and the one a
 * "refunded" event names: the brain-signed 30933 amount once the order is
 * paid, else the amount recomputed from the merchant's listings, else
 * (nothing computable) the buyer's own total. Never the buyer's total for a
 * paid order.
 */
export function merchantAmount(r: { payment_state?: string; paid_amount?: string | null; expected_total?: string | null; total?: string }): string {
  if (r.payment_state === 'paid' && r.paid_amount) return String(r.paid_amount);
  if (r.expected_total) return String(r.expected_total);
  return String(r.total ?? '');
}

/** The shipping line that adds up to merchantAmount: amount − Σ line totals; the buyer's tag when that does not work out. */
function merchantShipping(amount: string, items: any[], buyerShipping: string): string {
  const total = toCents(amount);
  let sum = 0;
  for (const it of items) {
    const c = toCents(it?.lineTotal);
    if (c === null) return buyerShipping;
    sum += c;
  }
  return total !== null && total >= sum ? centsToString(total - sum) : buyerShipping;
}

/** Public order view — everything the merchant UI needs, never a plaintext detail. */
export function orderView(db: Database.Database, r: any, hex: string): any {
  const unit = db.prepare('SELECT name FROM business_units WHERE unit_id = ?').get(r.unit_id) as any;
  const delivery = db.prepare(
    'SELECT raw_event FROM shop_order_delivery WHERE order_id = ? AND recipient_hex = ?'
  ).get(r.order_id, hex) as any;
  let deliveryEvent: any = null;
  try { deliveryEvent = delivery ? JSON.parse(delivery.raw_event) : null; } catch { deliveryEvent = null; }
  const items = itemsView(db, r);
  const total = merchantAmount(r);
  return {
    order_id: r.order_id,
    unit_id: r.unit_id,
    unit_name: unit?.name || r.unit_id,
    unit_owner_hex: r.unit_owner_hex,
    buyer_pubkey: r.buyer_pubkey,
    created_at: r.created_at,
    items,
    // total / shipping = what the merchant asked and was paid (merchantAmount);
    // the buyer-signed tags stay visible as buyer_total / buyer_shipping.
    shipping: merchantShipping(total, items, r.shipping),
    total,
    buyer_shipping: r.shipping,
    buyer_total: r.total,
    currency: r.currency,
    fulfillment: r.fulfillment,
    order_status: r.order_status,
    pay_by: r.pay_by,
    client: r.client,
    paymentState: r.payment_state,
    expected_total: r.expected_total,
    price_changed: r.price_changed === 1,
    effectiveStatus: r.effective_status,
    pending: r.pending === 1,
    paid_signer_hex: r.paid_signer_hex,
    paid_tx_id: r.paid_tx_id,
    paid_event_id: r.paid_event_id,
    paid_customer_hex: r.paid_customer_hex,
    paid_amount: r.paid_amount,
    paid_lana_amount: r.paid_lana_amount,
    paid_at: r.paid_at,
    fulfillment_status: r.fulfillment_status,
    fulfillment_event_id: r.fulfillment_event_id,
    fulfillment_pubkey: r.fulfillment_pubkey,
    fulfillment_created_at: r.fulfillment_created_at,
    fulfillment_carrier: r.fulfillment_carrier,
    fulfillment_tracking: r.fulfillment_tracking,
    fulfillment_published: r.fulfillment_published === 1,
    delivery_event: deliveryEvent,
  };
}

/** SPEC §3 monotonic rule. `from` is the current (validated) status or null. */
export function transitionAllowed(from: string | null, to: string): boolean {
  if (from === to) return false;
  if (from === 'completed') return false;
  if (from === 'rejected' || from === 'refunded') return to === 'refunded' && from === 'rejected';
  if (to === 'rejected' || to === 'refunded') return true;
  const fromRank = from ? (FULFILLMENT_RANK[from] ?? 0) : 0;
  const toRank = FULFILLMENT_RANK[to] ?? 0;
  return toRank > fromRank;
}

export function registerOrderRoutes(app: Express, db: Database.Database): void {
  /** Working counter for the home badge: paid ∧ not yet shipped/delivered/…
   *  across every unit the hex owns or staffs (SIMPLE units excluded). No
   *  mark-seen — the badge clears when the order ships. */
  app.get('/api/orders/pending-count', gate(db, req => req.query.hex), (req, res) => {
    const hex = String(req.query.hex || '').toLowerCase();
    const unitIds = unitIdsForMerchant(db, hex);
    if (unitIds.length === 0) return res.json({ success: true, count: 0, latest: [] });
    const ph = unitIds.map(() => '?').join(',');
    const count = (db.prepare(`
      SELECT COUNT(*) AS c FROM shop_orders WHERE unit_id IN (${ph}) AND pending = 1
    `).get(...unitIds) as any).c;
    // total = the paid 30933 amount (pending ⇒ paid), never the buyer-signed tag.
    const latest = (db.prepare(`
      SELECT o.order_id, o.unit_id, COALESCE(u.name, o.unit_id) AS unit_name,
             o.payment_state, o.paid_amount, o.expected_total, o.total, o.currency, o.paid_at
      FROM shop_orders o LEFT JOIN business_units u ON u.unit_id = o.unit_id
      WHERE o.unit_id IN (${ph}) AND o.pending = 1
      ORDER BY o.paid_at DESC LIMIT 3
    `).all(...unitIds) as any[]).map(o => ({
      order_id: o.order_id, unit_id: o.unit_id, unit_name: o.unit_name,
      total: merchantAmount(o), currency: o.currency, paid_at: o.paid_at,
    }));
    res.json({ success: true, count, latest });
  });

  /** List orders: one unit (unit_id=) or every unit of the hex; scope pending|all. */
  app.get('/api/orders', gate(db, req => req.query.hex), (req, res) => {
    const hex = String(req.query.hex || '').toLowerCase();
    const unitIdParam = String(req.query.unit_id || '');
    const scope = String(req.query.scope || 'pending') === 'all' ? 'all' : 'pending';
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);

    let unitIds: string[];
    if (unitIdParam) {
      const unit = unitForMerchant(db, hex, unitIdParam);
      if (!unit) return res.status(403).json({ success: false, error: 'NOT_AUTHORIZED' });
      unitIds = [unit.unit_id];
    } else {
      unitIds = unitIdsForMerchant(db, hex);
      if (unitIds.length === 0) {
        if (!HEX64.test(hex)) return res.status(403).json({ success: false, error: 'NOT_AUTHORIZED' });
        return res.json({ success: true, total: 0, orders: [] });
      }
    }
    const ph = unitIds.map(() => '?').join(',');
    const where = `unit_id IN (${ph})${scope === 'pending' ? ' AND pending = 1' : ''}`;
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM shop_orders WHERE ${where}`).get(...unitIds) as any).c;
    const rows = db.prepare(`
      SELECT * FROM shop_orders WHERE ${where}
      ORDER BY COALESCE(paid_at, created_at) DESC, created_at DESC LIMIT ? OFFSET ?
    `).all(...unitIds, limit, offset) as any[];
    res.json({ success: true, total, orders: rows.map(r => orderView(db, r, hex)) });
  });

  /** One order (+ the 36522 ciphertext addressed to this hex, if any). */
  app.get('/api/orders/:orderId', gate(db, req => req.query.hex), (req, res) => {
    const hex = String(req.query.hex || '').toLowerCase();
    const row = db.prepare('SELECT * FROM shop_orders WHERE order_id = ?').get(String(req.params.orderId)) as any;
    if (!row) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (!unitForMerchant(db, hex, row.unit_id)) return res.status(403).json({ success: false, error: 'NOT_AUTHORIZED' });
    // SPEC §9.4: the detail response IS the orderView (top-level fields).
    res.json({ success: true, ...orderView(db, row, hex) });
  });

  /**
   * Publish a merchant-signed KIND 36521. The browser signs; this server only
   * verifies, records (atomically — a double tap is a 409, not a second row)
   * and broadcasts. Unpublished events are retried by the heartbeat.
   */
  // Both names the handler acts on: the claimed `hex` AND the pubkey that
  // signed the event. It forces them equal a few lines down, but a gate that
  // reads one field while the handler reads two is exactly the shape that got
  // walked past elsewhere in this app — so it asks for both.
  app.post('/api/orders/:orderId/fulfillment', gate(db, req => [req.body?.hex, req.body?.event?.pubkey]), async (req, res) => {
    const orderId = String(req.params.orderId);
    const hex = String(req.body?.hex || '').toLowerCase();
    const event = req.body?.event as SignedEvent | undefined;
    if (!HEX64.test(hex) || !event || typeof event !== 'object') {
      return res.status(400).json({ success: false, error: 'INVALID_REQUEST' });
    }

    let sigOk = false;
    try { sigOk = verifyEvent(event as any); } catch { sigOk = false; }
    if (!sigOk) return res.status(400).json({ success: false, error: 'INVALID_SIGNATURE' });
    if (event.kind !== KIND_FULFILLMENT) return res.status(400).json({ success: false, error: 'INVALID_KIND' });
    if (event.pubkey !== hex) return res.status(403).json({ success: false, error: 'SIGNER_MISMATCH' });

    const row = db.prepare('SELECT * FROM shop_orders WHERE order_id = ?').get(orderId) as any;
    if (!row) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    const unit = unitForMerchant(db, hex, row.unit_id);
    if (!unit) return res.status(403).json({ success: false, error: 'NOT_AUTHORIZED' });

    const f = parseFulfillmentEvent(event);
    if (!f) return res.status(400).json({ success: false, error: 'INVALID_EVENT' });
    if (f.d !== orderId) return res.status(400).json({ success: false, error: 'D_MISMATCH' });
    if (f.unitId !== row.unit_id) return res.status(400).json({ success: false, error: 'UNIT_MISMATCH' });
    const orderRef = `36520:${row.buyer_pubkey}:${row.order_id}`;
    const hasOrderRef = event.tags.some(t => t[0] === 'a' && t[1] === orderRef);
    const hasBuyerP = event.tags.some(t => t[0] === 'p' && t[1] === row.buyer_pubkey);
    if (!hasOrderRef || !hasBuyerP) return res.status(400).json({ success: false, error: 'INVALID_TAGS' });
    // Fail closed on anything this event is not allowed to say — see FULFILLMENT_TAGS.
    const badTag = event.tags.find(t => !Array.isArray(t) || typeof t[0] !== 'string' || !FULFILLMENT_TAGS.has(t[0]));
    if (badTag) {
      return res.status(400).json({ success: false, error: 'INVALID_TAGS', tag: String((badTag as any[])?.[0] ?? '') });
    }
    if (event.content !== '') return res.status(400).json({ success: false, error: 'CONTENT_NOT_EMPTY' });
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(event.created_at - now) > CREATED_AT_SKEW) return res.status(400).json({ success: false, error: 'STALE_EVENT' });

    // Money gate: only a brain-signed 30933 (resolver: payment_state === 'paid') can be fulfilled.
    if (row.payment_state !== 'paid') return res.status(409).json({ success: false, error: 'NOT_PAID', paymentState: row.payment_state });
    // …reached by THIS rule set (SPEC v1.1.2 §8 5a): a 'paid' the older rules
    // stored is judged again on the next sync (orderSync activeOrderIds) and
    // cannot be shipped before that.
    if (row.settled_order_event_id !== row.event_id) {
      return res.status(409).json({ success: false, error: 'NOT_PAID', paymentState: 'not_judged_yet' });
    }
    // From 'confirmed' onward the event must name the payment it accepts (SPEC §3).
    const needsPayment = f.status !== 'received';
    const expectedPaymentRef = `30933:${row.paid_signer_hex}:${row.paid_tx_id}`;
    if (needsPayment && f.paymentRef !== expectedPaymentRef) {
      return res.status(400).json({ success: false, error: 'PAYMENT_REF_MISMATCH' });
    }

    const current: string | null = row.fulfillment_status || null;
    if (!transitionAllowed(current, f.status)) {
      return res.status(409).json({ success: false, error: current === f.status ? 'STALE_STATUS' : 'STATUS_REGRESSION', status: current });
    }
    // NIP-33: a relay keeps the newest created_at, so an event not newer than
    // the current fulfillment could never replace it — refuse it here too.
    if (row.fulfillment_created_at && event.created_at <= row.fulfillment_created_at) {
      return res.status(409).json({ success: false, error: 'STALE_STATUS', status: current });
    }

    // Atomic claim — the linearization point (pattern: paymentRequests.ts submit).
    // `IS` compares NULL as a value in SQLite, so a first fulfillment (NULL) is
    // claimed exactly once too.
    const pending = TERMINAL.has(f.status) ? 0 : 1;
    const claimed = db.prepare(`
      UPDATE shop_orders SET
        fulfillment_status = ?, fulfillment_event_id = ?, fulfillment_pubkey = ?, fulfillment_created_at = ?,
        fulfillment_carrier = ?, fulfillment_tracking = ?, fulfillment_published = 0,
        effective_status = ?, pending = ?, updated_at = datetime('now')
      WHERE order_id = ? AND payment_state = 'paid' AND settled_order_event_id = event_id AND fulfillment_status IS ?
    `).run(f.status, f.eventId, f.pubkey, f.createdAt, f.carrier, f.tracking, f.status, pending, orderId, current);
    if (claimed.changes !== 1) {
      const fresh = db.prepare('SELECT fulfillment_status FROM shop_orders WHERE order_id = ?').get(orderId) as any;
      return res.status(409).json({ success: false, error: 'STALE_STATUS', status: fresh?.fulfillment_status ?? null });
    }
    upsertFulfillmentRow(db, f, event, 0);

    // Broadcast server-side (never the open /api/broadcast-event). Bounded
    // retries; the heartbeat republishes whatever no relay accepted.
    const relays = readRelays(db);
    let result = { success: [] as string[], failed: [] as string[] };
    for (let attempt = 0; attempt < 3; attempt++) {
      try { result = await broadcastEvent(event as any, relays); } catch { result = { success: [], failed: relays }; }
      if (result.success.length > 0) break;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
    const published = result.success.length > 0;
    if (published) {
      db.prepare('UPDATE shop_order_fulfillments SET published = 1 WHERE order_id = ? AND event_id = ?').run(orderId, f.eventId);
      db.prepare('UPDATE shop_orders SET fulfillment_published = 1 WHERE order_id = ? AND fulfillment_event_id = ?').run(orderId, f.eventId);
    }
    console.log(`[orders] fulfillment ${f.status} order=${orderId.slice(0, 12)}… unit=${row.unit_id.slice(0, 12)} relays ok=${result.success.length} failed=${result.failed.length}`);
    res.json({ success: true, published, relays: { ok: result.success, failed: result.failed } });
  });

  console.log('[orders] Shop-order routes registered');
}

// Re-exported for tests that want to assert on the unit's signer set.
export { unitRow, unitSigners };
