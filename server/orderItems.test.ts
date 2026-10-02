// @vitest-environment node
/**
 * Lana Online Shop — WHAT was ordered, on the merchant's order screen.
 *
 * Marjan (Eko veganska trgovina Živa Center, 30. 9. 2026) opened a paid test
 * order and saw "1 × g · a5a1f51e1fb7ceecf5761aa40a04fc2b": the listing's own
 * `unit` tag and its d-tag. A KIND 36520 v1 item carries only
 * [address, qty, saleUnit, unitPrice, currency] — no title, no SKU — and this
 * app kept nothing of the listing except its price.
 *
 * Pinned here:
 *   (a) the merchant-signed listing's title / sku / weight reach
 *       GET /api/orders/:id, with a line total;
 *   (b) a listing edited AFTER the order never overwrites the version that was
 *       live when the buyer ordered;
 *   (c) a "listing" signed by anyone but the address's pubkey (or a forged
 *       copy of the real one) is ignored;
 *   (d) an order that is already resolved — rejected, never re-resolved — is
 *       filled by the backfill (the real test order is exactly that);
 *   (e) with no listing on the relays, the title comes from the paid 30933
 *       receipt_description (binding suffix stripped, never shown);
 *   (f) the money verdict is untouched: resolveOrder still receives only the
 *       listing's price and created_at, and the outcome is identical to a
 *       price-only fetcher.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

vi.mock('./lib/orderResolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./lib/orderResolver.js')>();
  return { ...real, resolveOrder: vi.fn(real.resolveOrder) };
});

import { initializeSchema } from './db/schema.js';
import { registerOrderRoutes } from './orders.js';
import {
  ingestEvent, ingestFulfillment, resolveOrders, activeOrderIds, makeListingFetcher, clearListingCache,
  backfillItemSnapshots, snapshotItem, syncShopOrders, type ListingFetcher, type ListingInfo,
} from './lib/orderSync.js';
import { bindingString, resolveOrder } from './lib/orderResolver.js';

// ── keys ──────────────────────────────────────────────────────────────────
const mk = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const owner = mk(), stranger = mk(), brain = mk();

const UNIT = 'd'.repeat(32);
const now = () => Math.floor(Date.now() / 1000);
const hex32 = () => crypto.randomBytes(16).toString('hex');
const orderIdFor = (pk: string) => `${pk.slice(0, 24)}.${hex32()}`;

function sign(sk: Uint8Array, kind: number, tags: string[][], content = '', createdAt = now()) {
  return finalizeEvent({ kind, tags, content, created_at: createdAt }, sk) as any;
}

/** A Živa-shaped KIND 36502 (lana-pays-feed import): per-package price, unit 'g', size in `weight`. */
function listingEvent(signer: { sk: Uint8Array }, d: string, createdAt: number, over: Partial<{ title: string; sku: string; weight: string; price: string; unit: string }> = {}) {
  return sign(signer.sk, 36502, [
    ['d', d],
    ['a', `30901:${owner.pk}:${UNIT}`],
    ['title', over.title ?? 'TARTEN S PETERŠILJEM BIO 200g'],
    ['type', 'product'],
    ['price', over.price ?? '4.08', 'EUR'],
    ['unit', over.unit ?? 'g'],
    ['status', 'active'],
    ['sku', over.sku ?? '321'],
    ['weight', over.weight ?? '200 g'],
    ['brand', 'ffa-pensa-bio'],
  ], '', createdAt);
}

function orderEvent(b: { sk: Uint8Array; pk: string }, d: string, listingD: string, qty: number, createdAt: number) {
  const total = (4.08 * qty).toFixed(2);
  return sign(b.sk, 36520, [
    ['d', d],
    ['a', `30901:${owner.pk}:${UNIT}`],
    ['p', owner.pk],
    ['unit_id', UNIT],
    ['invoice_number', d],
    ['item', `36502:${owner.pk}:${listingD}`, String(qty), 'g', '4.08', 'EUR'],
    ['shipping', '0.00', 'EUR'],
    ['total', total, 'EUR'],
    ['fulfillment', 'pickup'],
    ['status', 'placed'],
    ['pay_by', String(createdAt + 1800)],
    ['client', 'lanaeco.shop'],
    ['v', '1'],
  ], '', createdAt);
}

function purchaseEvent(d: string, buyerPk: string, amount: string, title: string, qty: number) {
  return sign(brain.sk, 30933, [
    ['d', crypto.randomUUID()],
    ['p', 'f'.repeat(64)],
    ['unit_id', UNIT],
    ['payment_type', 'lana'],
    ['customer_hex', 'f'.repeat(64)],
    ['merchant_hex', owner.pk],
    ['amount', amount],
    ['currency', 'EUR'],
    ['lana_amount', '1593750000'],
    ['status', 'processing'],
    ['invoice_number', d],
    ['receipt_description', `${title} ×${qty} · ${bindingString(buyerPk, d)}`],
  ]);
}

function rejectEvent(order: any) {
  return sign(owner.sk, 36521, [
    ['d', order.order_id],
    ['a', `36520:${order.buyer_pubkey}:${order.order_id}`],
    ['a', `30901:${owner.pk}:${UNIT}`],
    ['p', order.buyer_pubkey],
    ['unit_id', UNIT],
    ['status', 'rejected'],
    ['payment', `30933:${order.paid_signer_hex}:${order.paid_tx_id}`],
    ['v', '1'],
  ]);
}

// ── relay stub: answers REQ by kind + #d and IGNORES `authors` (a careless
//    or hostile relay) — so the author check has to happen in our code. ─────
let relayEvents: any[] = [];
let relay: WebSocketServer;
let relayUrl = '';
let reqCount = 0;

function matches(ev: any, f: any): boolean {
  if (Array.isArray(f.kinds) && !f.kinds.includes(ev.kind)) return false;
  if (Array.isArray(f['#d'])) {
    const d = ev.tags.find((t: string[]) => t[0] === 'd')?.[1];
    if (!f['#d'].includes(d)) return false;
  }
  return true;
}

let db: Database.Database;
let base = '';
let httpServer: any;
const trusted = new Set([brain.pk]);
/** The fetcher every pre-existing test uses: money fields only, nothing to display. */
const priceOnly: ListingFetcher = async () => ({ price: '4.08', currency: 'EUR', status: 'active', createdAt: now() - 86_400, unitRef: `30901:${owner.pk}:${UNIT}` });

const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, json: await r.json() as any }; };
const snapRow = (orderId: string) => db.prepare('SELECT * FROM shop_order_item_snapshots WHERE order_id = ?').get(orderId) as any;

async function placeAndPay(buyer: { sk: Uint8Array; pk: string }, listingD: string, fetchListing: ListingFetcher, qty = 1, createdAt = now() - 120) {
  const d = orderIdFor(buyer.pk);
  expect(ingestEvent(db, orderEvent(buyer, d, listingD, qty, createdAt), trusted)).toBe(d);
  expect(ingestEvent(db, purchaseEvent(d, buyer.pk, (4.08 * qty).toFixed(2), 'TARTEN S PETERŠILJEM BIO 200g', qty), trusted)).toBe(d);
  await resolveOrders(db, { orderIds: [d], trusted, fetchListing, now: now() });
  return db.prepare('SELECT * FROM shop_orders WHERE order_id = ?').get(d) as any;
}

beforeAll(async () => {
  relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(r => relay.once('listening', r));
  relay.on('connection', (socket) => {
    socket.on('message', (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m[0] === 'REQ') {
          reqCount++;
          const [, sub, filter] = m;
          for (const ev of relayEvents) if (matches(ev, filter)) socket.send(JSON.stringify(['EVENT', sub, ev]));
          socket.send(JSON.stringify(['EOSE', sub]));
        } else if (m[0] === 'EVENT') {
          socket.send(JSON.stringify(['OK', m[1].id, true, '']));
        }
      } catch { /* ignore */ }
    });
  });
  relayUrl = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  process.env.LANA_RELAYS_OVERRIDE = relayUrl;
  process.env.LANA_TRUSTED_SIGNERS_OVERRIDE = brain.pk;

  db = new Database(':memory:');
  initializeSchema(db);
  db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', 'active', ?)
  `).run(UNIT, 'e'.repeat(64), owner.pk, now(), 'Eko veganska trgovina Živa Center', owner.pk, JSON.stringify([owner.pk]),
    JSON.stringify({ kind: 30901, pubkey: owner.pk, tags: [['d', UNIT], ['unit_id', UNIT], ['online_shop', 'true'], ['online_shop_pickup', 'true']], content: '' }));

  const app = express();
  app.use(express.json());
  registerOrderRoutes(app, db);
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => httpServer.once('listening', r));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.LANA_RELAYS_OVERRIDE;
  delete process.env.LANA_TRUSTED_SIGNERS_OVERRIDE;
  await new Promise<void>(r => httpServer.close(() => r()));
  await new Promise<void>(r => relay.close(() => r()));
  db.close();
});

beforeEach(() => {
  relayEvents = [];
  clearListingCache();
  vi.mocked(resolveOrder).mockClear();
});

describe('order items carry the listing the buyer saw', () => {
  it('(a) title, šifra and weight from the merchant-signed listing reach GET /api/orders/:id, with a line total', async () => {
    const listingD = hex32();
    const lst = listingEvent(owner, listingD, now() - 86_400);
    relayEvents = [lst];
    const o = await placeAndPay(mk(), listingD, makeListingFetcher([relayUrl], 3000), 2);
    expect(o.payment_state).toBe('paid');

    const r = await get(`/api/orders/${o.order_id}?hex=${owner.pk}`);
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0]).toMatchObject({
      a: `36502:${owner.pk}:${listingD}`, qty: 2, saleUnit: 'g', unitPrice: '4.08', currency: 'EUR',
      title: 'TARTEN S PETERŠILJEM BIO 200g', sku: '321', weight: '200 g', lineTotal: '8.16',
    });
    // shipping / total are the order's own, unchanged
    expect(r.json).toMatchObject({ shipping: '0.00', total: '8.16', currency: 'EUR' });
    expect(snapRow(o.order_id)).toMatchObject({ source: 'listing', listing_event_id: lst.id, listing_created_at: lst.created_at, price: '4.08', currency: 'EUR', sale_unit: 'g' });

    // the list carries it too (the row shows the first item's title)
    const list = await get(`/api/orders?hex=${owner.pk}&unit_id=${UNIT}&scope=all&limit=50`);
    const row = list.json.orders.find((x: any) => x.order_id === o.order_id);
    expect(row.items[0].title).toBe('TARTEN S PETERŠILJEM BIO 200g');
  });

  it('(b) a listing edited after the order never overwrites the version live at order time', async () => {
    const listingD = hex32();
    const before = listingEvent(owner, listingD, now() - 86_400, { title: 'TARTEN S PETERŠILJEM BIO 200g', sku: '321' });
    relayEvents = [before];
    const o = await placeAndPay(mk(), listingD, makeListingFetcher([relayUrl], 3000));
    expect(snapRow(o.order_id).listing_event_id).toBe(before.id);

    // The merchant renames the product and changes the code a minute later.
    // Relays keep only the newest version (NIP-33).
    const after = listingEvent(owner, listingD, now() + 60, { title: 'TARTEN S PETERŠILJEM 250g', sku: '999' });
    relayEvents = [after];
    clearListingCache();
    expect(activeOrderIds(db)).toContain(o.order_id); // paid + pending → re-resolved every tick
    await resolveOrders(db, { orderIds: [o.order_id], trusted, fetchListing: makeListingFetcher([relayUrl], 3000), now: now() });

    expect(snapRow(o.order_id)).toMatchObject({ listing_event_id: before.id, title: 'TARTEN S PETERŠILJEM BIO 200g', sku: '321' });
    const r = await get(`/api/orders/${o.order_id}?hex=${owner.pk}`);
    expect(r.json.items[0]).toMatchObject({ title: 'TARTEN S PETERŠILJEM BIO 200g', sku: '321' });
  });

  it('(b) a paid order whose only snapshot is a version from AFTER the order shows the buyer\'s checked line, not the later sale unit or price (third review)', async () => {
    const t0 = now() - 120;
    // edited: 4.08 kos — the relays only ever had the version published after the order
    const sameD = hex32();
    relayEvents = [listingEvent(owner, sameD, t0 + 30, { unit: 'kos' })];
    const o1 = await placeAndPay(mk(), sameD, makeListingFetcher([relayUrl], 3000), 1, t0);
    expect(o1.payment_state).toBe('paid');
    expect(snapRow(o1.order_id)).toMatchObject({ sale_unit: 'kos', listing_created_at: t0 + 30 });
    const v1 = await get(`/api/orders/${o1.order_id}?hex=${owner.pk}`);
    expect(v1.json.items.map((i: any) => [i.qty, i.saleUnit, i.unitPrice, i.lineTotal, i.saleUnitChanged, i.listingSaleUnit]))
      .toEqual([[1, 'g', '4.08', '4.08', true, 'kos']]);

    // edited: 5.00 kos — paid at 4.08 (and pinned), the first snapshot is of the edit
    const editD = hex32();
    relayEvents = [];
    const o2 = await placeAndPay(mk(), editD, priceOnly, 1, t0);
    expect(o2.payment_state).toBe('paid');
    relayEvents = [listingEvent(owner, editD, t0 + 30, { unit: 'kos', price: '5.00' })];
    clearListingCache();
    await resolveOrders(db, { orderIds: [o2.order_id], trusted, fetchListing: makeListingFetcher([relayUrl], 3000), now: now() });
    expect(snapRow(o2.order_id)).toMatchObject({ sale_unit: 'kos', price: '5.00' });
    const v2 = await get(`/api/orders/${o2.order_id}?hex=${owner.pk}`);
    expect(v2.json).toMatchObject({ paymentState: 'paid', total: '4.08', shipping: '0.00' });
    expect(v2.json.items.map((i: any) => [i.qty, i.saleUnit, i.unitPrice, i.lineTotal, i.saleUnitChanged])).toEqual([[1, 'g', '4.08', '4.08', true]]);

    // a snapshot live at order time is the merchant's line, as before
    const liveD = hex32();
    relayEvents = [listingEvent(owner, liveD, t0 - 86_400, { unit: 'g' })];
    const o3 = await placeAndPay(mk(), liveD, makeListingFetcher([relayUrl], 3000), 1, t0);
    const v3 = await get(`/api/orders/${o3.order_id}?hex=${owner.pk}`);
    expect(v3.json.items.map((i: any) => [i.saleUnit, i.unitPrice, i.saleUnitChanged, i.listingSaleUnit])).toEqual([['g', '4.08', false, null]]);
  });

  it('(b) …and a version that was live at order time replaces one fetched from after it', () => {
    const order = { order_id: orderIdFor(mk().pk), created_at: 1_000_000 };
    const a = `36502:${owner.pk}:${hex32()}`;
    const info = (eventId: string, createdAt: number, title: string): ListingInfo =>
      ({ price: '4.08', currency: 'EUR', status: 'active', createdAt, eventId, title, sku: '1', weight: '1 g', unit: 'g' });

    expect(snapshotItem(db, order, a, info('e1', 1_000_100, 'after'))).toBe(true);
    expect(snapshotItem(db, order, a, info('e2', 1_000_200, 'later still'))).toBe(false); // further from order time
    expect(snapshotItem(db, order, a, info('e0', 999_900, 'at order time'))).toBe(true);
    expect(snapshotItem(db, order, a, info('e1', 1_000_100, 'after'))).toBe(false);
    expect(snapshotItem(db, order, a, info('e-1', 999_000, 'older than the live one'))).toBe(false);
    expect((db.prepare('SELECT title FROM shop_order_item_snapshots WHERE order_id = ?').get(order.order_id) as any).title).toBe('at order time');
  });

  it('(c) a listing signed by another key — or a forged copy of the real one — is ignored', async () => {
    const listingD = hex32();
    const real = listingEvent(owner, listingD, now() - 86_400, { title: 'Pravi izdelek', sku: '321' });
    const foreign = listingEvent(stranger, listingD, now() - 3_600, { title: 'Ponaredek', sku: '666', price: '0.01' });
    const forged = { ...listingEvent(owner, listingD, now() - 1_800, { title: 'Ponarejen podpis' }), tags: [...real.tags.filter((t: string[]) => t[0] !== 'title'), ['title', 'Ponarejen podpis']] };
    relayEvents = [real, foreign, forged];

    const o = await placeAndPay(mk(), listingD, makeListingFetcher([relayUrl], 3000));
    const r = await get(`/api/orders/${o.order_id}?hex=${owner.pk}`);
    expect(r.json.items[0]).toMatchObject({ title: 'Pravi izdelek', sku: '321' });
    expect(JSON.stringify(r.json)).not.toContain('Ponaredek');
    expect(JSON.stringify(r.json)).not.toContain('Ponarejen');
    expect(snapRow(o.order_id).listing_event_id).toBe(real.id);
    // and the money side used the real price, not the stranger's 0.01
    expect(o.payment_state).toBe('paid');
    expect(o.expected_total).toBe('4.08');
  });

  it('(d) the backfill fills an order that is already resolved (rejected) and never re-resolved', async () => {
    const listingD = hex32();
    // Placed, paid and rejected BEFORE this code existed: resolved with the
    // old price-only fetcher, then the snapshot table had nothing for it.
    const o = await placeAndPay(mk(), listingD, priceOnly);
    expect(ingestFulfillment(db, rejectEvent(o))).toBe(o.order_id);
    await resolveOrders(db, { orderIds: [o.order_id], trusted, fetchListing: priceOnly, now: now() });
    db.prepare('DELETE FROM shop_order_item_snapshots WHERE order_id = ?').run(o.order_id);
    const resolved = db.prepare('SELECT effective_status, pending FROM shop_orders WHERE order_id = ?').get(o.order_id) as any;
    expect(resolved).toEqual({ effective_status: 'rejected', pending: 0 });
    expect(activeOrderIds(db)).not.toContain(o.order_id);

    relayEvents = [listingEvent(owner, listingD, now() - 86_400)];
    // Through the heartbeat entry point, so the wiring is pinned too.
    const stats = await syncShopOrders(db, [relayUrl]);
    expect(stats.backfilled).toBeGreaterThanOrEqual(1);
    expect(snapRow(o.order_id)).toMatchObject({ source: 'listing', title: 'TARTEN S PETERŠILJEM BIO 200g', sku: '321', weight: '200 g' });
    const after = db.prepare('SELECT effective_status, pending, payment_state FROM shop_orders WHERE order_id = ?').get(o.order_id) as any;
    expect(after).toEqual({ effective_status: 'rejected', pending: 0, payment_state: 'paid' });

    // A second pass finds nothing left to do for it.
    const again = await backfillItemSnapshots(db, makeListingFetcher([relayUrl], 3000));
    expect(again).toBe(0);
  });

  it('(e) no listing on any relay → title from the 30933 receipt, binding suffix stripped; upgraded once the listing appears', async () => {
    const listingD = hex32();
    relayEvents = []; // listing deleted / relays silent
    const o = await placeAndPay(mk(), listingD, makeListingFetcher([relayUrl], 3000), 1);
    // SPEC v1.1.1: with no merchant-signed price the amount is not computable,
    // so the order is not paid yet (never priced at the buyer's unit_price).
    expect(o).toMatchObject({ payment_state: 'amount_mismatch', pending: 0 });
    expect(snapRow(o.order_id)).toMatchObject({ source: 'receipt', title: 'TARTEN S PETERŠILJEM BIO 200g', sku: null, listing_event_id: null });

    const r = await get(`/api/orders/${o.order_id}?hex=${owner.pk}`);
    expect(r.json.items[0]).toMatchObject({ title: 'TARTEN S PETERŠILJEM BIO 200g', sku: null, lineTotal: '4.08' });
    expect(JSON.stringify(r.json.items)).not.toContain('36520:');

    // The listing shows up again: the next resolve pays the order and upgrades the receipt title.
    relayEvents = [listingEvent(owner, listingD, now() - 86_400)];
    clearListingCache();
    expect(activeOrderIds(db, now())).toContain(o.order_id);
    await resolveOrders(db, { orderIds: [o.order_id], trusted, fetchListing: makeListingFetcher([relayUrl], 3000), now: now() });
    expect(snapRow(o.order_id)).toMatchObject({ source: 'listing', sku: '321' });
    expect(db.prepare('SELECT payment_state, pending FROM shop_orders WHERE order_id = ?').get(o.order_id)).toEqual({ payment_state: 'paid', pending: 1 });
  });

  it('(e) a receipt whose binding is for another order gives no title', async () => {
    const buyer = mk();
    const d = orderIdFor(buyer.pk);
    const listingD = hex32();
    expect(ingestEvent(db, orderEvent(buyer, d, listingD, 1, now() - 120), trusted)).toBe(d);
    const other = orderIdFor(buyer.pk);
    const ev = sign(brain.sk, 30933, [
      ['d', crypto.randomUUID()], ['unit_id', UNIT], ['payment_type', 'lana'], ['amount', '4.08'], ['currency', 'EUR'],
      ['status', 'processing'], ['invoice_number', d], ['customer_hex', 'f'.repeat(64)],
      ['receipt_description', `Napačen naslov ×1 · ${bindingString(buyer.pk, other)}`],
    ]);
    expect(ingestEvent(db, ev, trusted)).toBe(d);
    relayEvents = [];
    await resolveOrders(db, { orderIds: [d], trusted, fetchListing: makeListingFetcher([relayUrl], 3000), now: now() });
    const r = await get(`/api/orders/${d}?hex=${owner.pk}`);
    expect(r.json.items[0].title).toBeNull();
    expect(JSON.stringify(r.json)).not.toContain('Napačen naslov');
  });

  it('(f) resolveOrder gets only price + created_at, and the verdict equals a price-only fetcher', async () => {
    const listingD = hex32();
    const createdAt = now() - 86_400;
    relayEvents = [listingEvent(owner, listingD, createdAt)];
    const sameAsListing: ListingFetcher = async () => ({ price: '4.08', currency: 'EUR', status: 'active', createdAt, unitRef: `30901:${owner.pk}:${UNIT}` });

    const withDisplay = await placeAndPay(mk(), listingD, makeListingFetcher([relayUrl], 3000));
    const calls = vi.mocked(resolveOrder).mock.calls;
    expect(calls.length).toBe(1);
    const input = calls[0][0];
    // every item carries its own price (SPEC v1.1.0); no v1.0 top-level pair any more
    expect(Object.keys(input).sort()).toEqual(['fulfillment', 'now', 'order', 'purchases', 'settledPurchase', 'trustedSigners', 'unit']);
    // A first resolve has no stored paid verdict to keep (SPEC §8 step 5a).
    expect(input.settledPurchase).toBeNull();
    // The order the resolver sees is still the buyer's own item tag plus that
    // item's own listing price + created_at (SPEC v1.1.0) — no listing text mixed in.
    expect(Object.keys(input.order.items[0]).sort()).toEqual(['a', 'currency', 'listingCreatedAt', 'listingPrice', 'qty', 'unitPrice']);
    expect(input.order.items[0]).toMatchObject({ listingPrice: '4.08', listingCreatedAt: createdAt });
    expect(JSON.stringify(input.order)).not.toContain('TARTEN');

    const priceOnlyRow = await placeAndPay(mk(), listingD, sameAsListing);
    const verdict = (r: any) => ({ payment_state: r.payment_state, expected_total: r.expected_total, price_changed: r.price_changed, effective_status: r.effective_status, pending: r.pending });
    expect(verdict(withDisplay)).toEqual(verdict(priceOnlyRow));
    expect(verdict(withDisplay)).toEqual({ payment_state: 'paid', expected_total: '4.08', price_changed: 0, effective_status: 'paid', pending: 1 });

    // A changed price is still flagged exactly as before (price_changed from created_at only).
    const listingD2 = hex32();
    relayEvents = [listingEvent(owner, listingD2, now() + 30, { price: '5.00' })];
    const drift = await placeAndPay(mk(), listingD2, makeListingFetcher([relayUrl], 3000));
    expect(drift).toMatchObject({ payment_state: 'amount_mismatch', expected_total: '5.00', price_changed: 1, pending: 0 });
  });

  it('the listing fetch is shared with the resolver — no extra REQ per order', async () => {
    const listingD = hex32();
    relayEvents = [listingEvent(owner, listingD, now() - 86_400)];
    const fetchListing = makeListingFetcher([relayUrl], 3000);
    reqCount = 0;
    await placeAndPay(mk(), listingD, fetchListing);
    // prefetch: the listing REQ + the REQ for the KIND 5s naming it (round 3,
    // NIP-09); the per-order fetch and the snapshot reuse both
    expect(reqCount).toBe(2);
  });
});

describe('cart orders: several products of one shop in ONE order (SPEC v1.1.0)', () => {
  /** 2 × 4.08 (g) + 3 × 3.98 (kos), pickup = 20.10 */
  function cartOrderEvent(b: { sk: Uint8Array; pk: string }, d: string, items: string[][], total: string, createdAt = now() - 120) {
    return sign(b.sk, 36520, [
      ['d', d], ['a', `30901:${owner.pk}:${UNIT}`], ['p', owner.pk], ['unit_id', UNIT], ['invoice_number', d],
      ...items,
      ['shipping', '0.00', 'EUR'], ['total', total, 'EUR'], ['fulfillment', 'pickup'], ['status', 'placed'],
      ['pay_by', String(createdAt + 1800)], ['client', 'lanaeco.shop'], ['v', '1'],
    ], '', createdAt);
  }
  const L1 = hex32();
  const L2 = hex32();
  const items = (q1 = '2', q2 = '3') => [
    ['item', `36502:${owner.pk}:${L1}`, q1, 'g', '4.08', 'EUR'],
    ['item', `36502:${owner.pk}:${L2}`, q2, 'kos', '3.98', 'EUR'],
  ];
  function listings() {
    return [
      listingEvent(owner, L1, now() - 86_400),
      listingEvent(owner, L2, now() - 86_400, { title: 'HUMUS KLASIČNI BIO 180g', sku: '777', weight: '180 g', price: '3.98' }),
    ];
  }

  it('the merchant sees a paid 2-product order: both lines with their own titles and line totals', async () => {
    relayEvents = listings();
    const buyer = mk();
    const d = orderIdFor(buyer.pk);
    expect(ingestEvent(db, cartOrderEvent(buyer, d, items(), '20.10'), trusted)).toBe(d);
    expect(ingestEvent(db, purchaseEvent(d, buyer.pk, '20.10', 'TARTEN S PETERŠILJEM BIO 200g ×2 (+1)', 2), trusted)).toBe(d);
    await resolveOrders(db, { orderIds: [d], trusted, fetchListing: makeListingFetcher([relayUrl], 3000), now: now() });
    const row = db.prepare('SELECT * FROM shop_orders WHERE order_id = ?').get(d) as any;
    expect(row).toMatchObject({ payment_state: 'paid', expected_total: '20.10', pending: 1 });

    const r = await get(`/api/orders/${d}?hex=${owner.pk}`);
    // The sale unit shown is the MERCHANT-signed listing's (both fixtures sign 'g'); the buyer's tag says 'kos'.
    expect(r.json.items.map((i: any) => [i.title, i.qty, i.saleUnit, i.unitPrice, i.lineTotal, i.sku, i.buyerSaleUnit])).toEqual([
      ['TARTEN S PETERŠILJEM BIO 200g', 2, 'g', '4.08', '8.16', '321', 'g'],
      ['HUMUS KLASIČNI BIO 180g', 3, 'g', '3.98', '11.94', '777', 'kos'],
    ]);
    expect(r.json).toMatchObject({ total: '20.10', shipping: '0.00' });
    // a snapshot per item
    expect((db.prepare('SELECT COUNT(*) AS n FROM shop_order_item_snapshots WHERE order_id = ?').get(d) as any).n).toBe(2);
  });

  it('each item is priced by ITS listing: paid as item-1 price × all units → amount_mismatch, never pending', async () => {
    relayEvents = listings();
    const buyer = mk();
    const d = orderIdFor(buyer.pk);
    expect(ingestEvent(db, cartOrderEvent(buyer, d, items(), '20.10'), trusted)).toBe(d);
    expect(ingestEvent(db, purchaseEvent(d, buyer.pk, '20.40', 'x', 2), trusted)).toBe(d); // 4.08 × 5
    await resolveOrders(db, { orderIds: [d], trusted, fetchListing: makeListingFetcher([relayUrl], 3000), now: now() });
    expect(db.prepare('SELECT payment_state, pending FROM shop_orders WHERE order_id = ?').get(d)).toEqual({ payment_state: 'amount_mismatch', pending: 0 });
  });

  it('a paid cart stays paid and pending when one product\'s price changes afterwards (SPEC §8 step 5a)', async () => {
    relayEvents = listings();
    const buyer = mk();
    const d = orderIdFor(buyer.pk);
    expect(ingestEvent(db, cartOrderEvent(buyer, d, items(), '20.10'), trusted)).toBe(d);
    expect(ingestEvent(db, purchaseEvent(d, buyer.pk, '20.10', 'x', 2), trusted)).toBe(d);
    const fetchListing = makeListingFetcher([relayUrl], 3000);
    await resolveOrders(db, { orderIds: [d], trusted, fetchListing, now: now() });
    const paid = db.prepare('SELECT * FROM shop_orders WHERE order_id = ?').get(d) as any;
    expect(paid).toMatchObject({ payment_state: 'paid', pending: 1 });
    expect(paid.paid_order_event_id).toBe(paid.event_id);

    // Next day the merchant republishes the second product at 4.20.
    relayEvents = [listings()[0], listingEvent(owner, L2, now() - 10, { title: 'HUMUS KLASIČNI BIO 180g', sku: '777', weight: '180 g', price: '4.20' })];
    clearListingCache();
    expect(activeOrderIds(db, now())).toContain(d);
    await resolveOrders(db, { trusted, fetchListing: makeListingFetcher([relayUrl], 3000), now: now() });
    const after = db.prepare('SELECT payment_state, pending, expected_total, price_changed FROM shop_orders WHERE order_id = ?').get(d);
    expect(after).toEqual({ payment_state: 'paid', pending: 1, expected_total: '20.10', price_changed: 1 });
    expect(activeOrderIds(db, now())).toContain(d);

    // The buyer replaces the 36520 afterwards: that new event is judged afresh at today's prices.
    expect(ingestEvent(db, cartOrderEvent(buyer, d, items(), '20.10', now() - 5), trusted)).toBe(d);
    clearListingCache();
    await resolveOrders(db, { orderIds: [d], trusted, fetchListing: makeListingFetcher([relayUrl], 3000), now: now() });
    expect(db.prepare('SELECT payment_state, pending, paid_order_event_id FROM shop_orders WHERE order_id = ?').get(d))
      .toEqual({ payment_state: 'amount_mismatch', pending: 0, paid_order_event_id: null });
  });

  it('refused like any malformed order: the same product twice, another shop\'s product, more than 30 items', () => {
    const buyer = mk();
    const twice = orderIdFor(buyer.pk);
    expect(ingestEvent(db, cartOrderEvent(buyer, twice, [items()[0], items()[0]], '16.32'), trusted)).toBeNull();
    const foreign = orderIdFor(buyer.pk);
    expect(ingestEvent(db, cartOrderEvent(buyer, foreign, [items()[0], ['item', `36502:${stranger.pk}:${L2}`, '1', 'kos', '3.98', 'EUR']], '12.14'), trusted)).toBeNull();
    const many = orderIdFor(buyer.pk);
    const lines = Array.from({ length: 31 }, () => ['item', `36502:${owner.pk}:${hex32()}`, '1', 'kos', '1.00', 'EUR']);
    expect(ingestEvent(db, cartOrderEvent(buyer, many, lines, '31.00'), trusted)).toBeNull();
    const thirty = orderIdFor(buyer.pk);
    expect(ingestEvent(db, cartOrderEvent(buyer, thirty, lines.slice(0, 30), '30.00'), trusted)).toBe(thirty);
  });
});
