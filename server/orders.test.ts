// @vitest-environment node
/**
 * Lana Online Shop — merchant order routes + relay ingest, on an in-memory DB
 * (pattern: nostrBroadcast.test.ts for the relay stub).
 *
 * What is pinned here:
 *   - pending-count spans owner + staff units, excludes shipped/rejected
 *     orders and simple.lanapays.us units;
 *   - POST fulfillment rejects a bad signature, a foreign signer, a wrong
 *     kind, a d mismatch and a status regression; accepts staff; a double
 *     POST leaves ONE row and answers 409;
 *   - ingest drops a 30933 from an untrusted signer, and the resolver never
 *     marks a tampered amount as pending.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { initializeSchema } from './db/schema.js';
import { registerOrderRoutes, transitionAllowed } from './orders.js';
import {
  ingestEvent, ingestPurchase, ingestFulfillment, resolveOrders, readTrustedSigners, parseOrderEvent,
  type ListingFetcher,
} from './lib/orderSync.js';
import { bindingString } from './lib/orderResolver.js';

// ── keys ──────────────────────────────────────────────────────────────────
const mk = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const owner = mk(), staff = mk(), stranger = mk(), brain = mk(), rogue = mk();
const buyer = mk(), buyer2 = mk(), buyer3 = mk(), buyer4 = mk(), buyer5 = mk();

const UNIT_A = 'a'.repeat(32);
const UNIT_B = 'b'.repeat(32);
const UNIT_S = 'c'.repeat(32); // simple.lanapays.us — never ours
const LISTING = `36502:${owner.pk}:lst1`;
const now = () => Math.floor(Date.now() / 1000);

const orderIdFor = (pk: string) => `${pk.slice(0, 24)}.${crypto.randomBytes(16).toString('hex')}`;

function sign(sk: Uint8Array, kind: number, tags: string[][], content = '', createdAt = now()) {
  return finalizeEvent({ kind, tags, content, created_at: createdAt }, sk) as any;
}

function orderEvent(b: { sk: Uint8Array; pk: string }, unitId: string, d: string, opts: Partial<{ total: string; fulfillment: string; createdAt: number }> = {}) {
  const createdAt = opts.createdAt ?? now() - 60;
  return sign(b.sk, 36520, [
    ['d', d],
    ['a', `30901:${owner.pk}:${unitId}`],
    ['p', owner.pk],
    ['unit_id', unitId],
    ['invoice_number', d],
    ['item', LISTING, '2', 'kos', '5.00', 'EUR'],
    ['shipping', opts.fulfillment === 'pickup' ? '0.00' : '2.50', 'EUR'],
    ['total', opts.total ?? '12.50', 'EUR'],
    ['fulfillment', opts.fulfillment ?? 'shipping'],
    ['status', 'placed'],
    ['pay_by', String(createdAt + 1800)],
    ['client', 'lanaeco.shop'],
    ['v', '1'],
  ], '', createdAt);
}

function purchaseEvent(signer: { sk: Uint8Array; pk: string }, unitId: string, d: string, buyerPk: string, amount = '12.50') {
  return sign(signer.sk, 30933, [
    ['d', crypto.randomUUID()],
    ['p', 'f'.repeat(64)],
    ['unit_id', unitId],
    ['payment_type', 'lana'],
    ['customer_hex', 'f'.repeat(64)],
    ['customer_wallet', 'LdevWallet'],
    ['merchant_hex', owner.pk],
    ['amount', amount],
    ['currency', 'EUR'],
    ['lana_amount', '9765432100'],
    ['status', 'processing'],
    ['invoice_number', d],
    ['receipt_description', `Jabolka ×2 · ${bindingString(buyerPk, d)}`],
  ]);
}

function fulfillmentEvent(signer: { sk: Uint8Array; pk: string }, order: any, status: string, extra: string[][] = [], kind = 36521, createdAt = now()) {
  return sign(signer.sk, kind, [
    ['d', order.order_id],
    ['a', `36520:${order.buyer_pubkey}:${order.order_id}`],
    ['a', `30901:${owner.pk}:${order.unit_id}`],
    ['p', order.buyer_pubkey],
    ['unit_id', order.unit_id],
    ['status', status],
    ['payment', `30933:${order.paid_signer_hex}:${order.paid_tx_id}`],
    ...extra,
    ['v', '1'],
  ], '', createdAt);
}

// ── fixtures ──────────────────────────────────────────────────────────────
let db: Database.Database;
let base = '';
let httpServer: any;
let relay: WebSocketServer;
const trusted = new Set([brain.pk]);
const listing: ListingFetcher = async () => ({ price: '5.00', currency: 'EUR', status: 'active', createdAt: now() - 3600 });

const unitRaw = (unitId: string, extraTags: string[][] = []) => JSON.stringify({
  kind: 30901, pubkey: owner.pk, tags: [['d', unitId], ['unit_id', unitId], ['online_shop', 'true'], ['online_shop_shipping_fee', '2.50'], ...extraTags], content: '',
});

function insertUnit(unitId: string, name: string, authorized: string[], simple = false) {
  db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event, unit_type, lana_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', 'active', ?, ?, ?)
  `).run(unitId, 'e'.repeat(64), owner.pk, now(), name, owner.pk, JSON.stringify(authorized), unitRaw(unitId, simple ? [['unit_type', 'simple.lanapays.us']] : []), simple ? 'simple.lanapays.us' : null, simple ? 1 : 0);
}

async function placeAndPay(b: { sk: Uint8Array; pk: string }, unitId: string, amount = '12.50') {
  const d = orderIdFor(b.pk);
  expect(ingestEvent(db, orderEvent(b, unitId, d), trusted)).toBe(d);
  expect(ingestEvent(db, purchaseEvent(brain, unitId, d, b.pk, amount), trusted)).toBe(d);
  await resolveOrders(db, { orderIds: [d], trusted, fetchListing: listing });
  return db.prepare('SELECT * FROM shop_orders WHERE order_id = ?').get(d) as any;
}

const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, json: await r.json() as any }; };
const post = async (path: string, body: any) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};

beforeAll(async () => {
  // Relay stub: accepts every EVENT (OK true) so the fulfillment POST publishes.
  relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(r => relay.once('listening', r));
  relay.on('connection', (socket) => {
    socket.on('message', (raw: Buffer) => {
      try { const m = JSON.parse(raw.toString()); if (m[0] === 'EVENT') socket.send(JSON.stringify(['OK', m[1].id, true, ''])); } catch { /* ignore */ }
    });
  });
  process.env.LANA_RELAYS_OVERRIDE = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`;

  db = new Database(':memory:');
  initializeSchema(db);
  insertUnit(UNIT_A, 'Shop A', [owner.pk, staff.pk]);
  insertUnit(UNIT_B, 'Shop B', [owner.pk]);
  insertUnit(UNIT_S, 'Simple S', [owner.pk], true);

  const app = express();
  app.use(express.json());
  registerOrderRoutes(app, db);
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => httpServer.once('listening', r));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.LANA_RELAYS_OVERRIDE;
  await new Promise<void>(r => httpServer.close(() => r()));
  await new Promise<void>(r => relay.close(() => r()));
  db.close();
});

// ── ingest + resolver ────────────────────────────────────────────────────
describe('ingest', () => {
  it('drops a 30933 from an untrusted signer, keeps the trusted one', async () => {
    const d = orderIdFor(buyer5.pk);
    expect(ingestEvent(db, orderEvent(buyer5, UNIT_A, d), trusted)).toBe(d);
    expect(ingestPurchase(db, purchaseEvent(rogue, UNIT_A, d, buyer5.pk), trusted)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS c FROM shop_order_payments WHERE invoice_number = ?').get(d)).toEqual({ c: 0 });
    await resolveOrders(db, { orderIds: [d], trusted, fetchListing: listing });
    expect((db.prepare('SELECT payment_state, pending FROM shop_orders WHERE order_id = ?').get(d) as any)).toEqual({ payment_state: 'unpaid', pending: 0 });

    expect(ingestPurchase(db, purchaseEvent(brain, UNIT_A, d, buyer5.pk), trusted)).toBe(d);
    await resolveOrders(db, { orderIds: [d], trusted, fetchListing: listing });
    expect((db.prepare('SELECT payment_state, pending FROM shop_orders WHERE order_id = ?').get(d) as any)).toEqual({ payment_state: 'paid', pending: 1 });
  });

  it('a tampered amount is amount_mismatch and never pending', async () => {
    const o = await placeAndPay(buyer4, UNIT_A, '12.49');
    expect(o.payment_state).toBe('amount_mismatch');
    expect(o.pending).toBe(0);
    expect(o.paid_tx_id).toBeTruthy();
  });

  it('an order for a simple.lanapays.us unit is never stored', () => {
    const d = orderIdFor(buyer3.pk);
    expect(ingestEvent(db, orderEvent(buyer3, UNIT_S, d), trusted)).toBeNull();
  });

  it('a 36521 signed by a stranger is dropped; by staff it lands', async () => {
    const o = await placeAndPay(buyer3, UNIT_B);
    expect(ingestFulfillment(db, fulfillmentEvent(stranger, o, 'shipped'))).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS c FROM shop_order_fulfillments WHERE order_id = ?').get(o.order_id)).toEqual({ c: 0 });
    // staff is on unit A only — still a stranger for unit B
    expect(ingestFulfillment(db, fulfillmentEvent(staff, o, 'shipped'))).toBeNull();
    expect(ingestFulfillment(db, fulfillmentEvent(owner, o, 'packed'))).toBe(o.order_id);
    await resolveOrders(db, { orderIds: [o.order_id], trusted, fetchListing: listing });
    const fresh = db.prepare('SELECT effective_status, pending FROM shop_orders WHERE order_id = ?').get(o.order_id) as any;
    expect(fresh).toEqual({ effective_status: 'packed', pending: 1 });
  });

  it('parseOrderEvent rejects non-empty content and a prefix that does not match the signer', () => {
    const d = orderIdFor(buyer.pk);
    const ev = orderEvent(buyer, UNIT_A, d);
    expect(parseOrderEvent(ev)?.d).toBe(d);
    expect(parseOrderEvent({ ...ev, content: 'x' })).toBeNull();
    const squat = orderEvent(buyer2, UNIT_A, d); // buyer2 signs an id minted for buyer
    expect(parseOrderEvent(squat)).toBeNull();
  });

  it('readTrustedSigners takes only the money groups out of KIND 38888', () => {
    const saved = process.env.LANA_TRUSTED_SIGNERS_OVERRIDE;
    delete process.env.LANA_TRUSTED_SIGNERS_OVERRIDE;
    const raw = JSON.stringify({
      id: '1'.repeat(64), pubkey: '2'.repeat(64), kind: 38888, created_at: now(), tags: [['d', 'main']], sig: '3'.repeat(128),
      content: JSON.stringify({ trusted_signers: { LanaPaysUs: [brain.pk], Lana8Wonder: [rogue.pk], Brain: owner.pk } }),
    });
    db.prepare('INSERT INTO kind_38888 (event_id, raw_event) VALUES (?, ?)').run('1'.repeat(64), raw);
    const set = readTrustedSigners(db);
    expect(set.has(brain.pk)).toBe(true);
    expect(set.has(owner.pk)).toBe(true);
    expect(set.has(rogue.pk)).toBe(false);
    if (saved !== undefined) process.env.LANA_TRUSTED_SIGNERS_OVERRIDE = saved;
  });
});

// ── routes ───────────────────────────────────────────────────────────────
describe('GET /api/orders/pending-count', () => {
  let a1: any, b1: any;
  beforeAll(async () => {
    db.prepare('DELETE FROM shop_orders').run();
    db.prepare('DELETE FROM shop_order_fulfillments').run();
    db.prepare('DELETE FROM shop_order_payments').run();
    a1 = await placeAndPay(buyer, UNIT_A);
    b1 = await placeAndPay(buyer2, UNIT_B);
    // shipped → not pending
    const a2 = await placeAndPay(buyer3, UNIT_A);
    expect(ingestFulfillment(db, fulfillmentEvent(owner, a2, 'shipped'))).toBe(a2.order_id);
    await resolveOrders(db, { orderIds: [a2.order_id], trusted, fetchListing: listing });
    // rejected → not pending
    const a3 = await placeAndPay(buyer4, UNIT_A);
    expect(ingestFulfillment(db, fulfillmentEvent(owner, a3, 'rejected'))).toBe(a3.order_id);
    await resolveOrders(db, { orderIds: [a3.order_id], trusted, fetchListing: listing });
    // a pending row on a SIMPLE unit (forced in — ingest would never store it)
    db.prepare(`
      INSERT INTO shop_orders (order_id, event_id, buyer_pubkey, created_at, unit_id, unit_owner_hex, items_json, shipping, total, currency,
        fulfillment, order_status, pay_by, raw_event, payment_state, effective_status, pending, paid_at)
      VALUES (?, ?, ?, ?, ?, ?, '[]', '0.00', '5.00', 'EUR', 'pickup', 'placed', ?, '{}', 'paid', 'paid', 1, ?)
    `).run(orderIdFor(buyer5.pk), 'x'.repeat(64), buyer5.pk, now(), UNIT_S, owner.pk, now() + 1800, now());
  });

  it('owner sees both units, staff only theirs, a stranger nothing', async () => {
    const o = await get(`/api/orders/pending-count?hex=${owner.pk}`);
    expect(o.status).toBe(200);
    expect(o.json.count).toBe(2);
    expect(o.json.latest.map((x: any) => x.order_id).sort()).toEqual([a1.order_id, b1.order_id].sort());
    expect(o.json.latest[0]).toMatchObject({ currency: 'EUR', total: '12.50' });
    expect(['Shop A', 'Shop B']).toContain(o.json.latest[0].unit_name);

    const s = await get(`/api/orders/pending-count?hex=${staff.pk}`);
    expect(s.json).toMatchObject({ count: 1 });
    expect(s.json.latest[0].order_id).toBe(a1.order_id);

    const x = await get(`/api/orders/pending-count?hex=${stranger.pk}`);
    expect(x.json).toEqual({ success: true, count: 0, latest: [] });
  });

  it('list + detail respect the unit authorization', async () => {
    const all = await get(`/api/orders?hex=${owner.pk}&scope=all&limit=50`);
    expect(all.json.total).toBe(4);
    const pendingA = await get(`/api/orders?hex=${staff.pk}&unit_id=${UNIT_A}&scope=pending`);
    expect(pendingA.json.orders.map((o: any) => o.order_id)).toEqual([a1.order_id]);
    expect(pendingA.json.orders[0].delivery_event).toBeNull();
    expect(JSON.stringify(pendingA.json)).not.toContain('raw_event');
    const forbidden = await get(`/api/orders?hex=${staff.pk}&unit_id=${UNIT_B}`);
    expect(forbidden.status).toBe(403);
    const detail = await get(`/api/orders/${b1.order_id}?hex=${staff.pk}`);
    expect(detail.status).toBe(403);
    const ok = await get(`/api/orders/${b1.order_id}?hex=${owner.pk}`);
    expect(ok.json).toMatchObject({ success: true, order_id: b1.order_id, paymentState: 'paid', effectiveStatus: 'paid', pending: true, unit_owner_hex: owner.pk });
    expect(JSON.stringify(ok.json)).not.toContain('raw_event');
  });
});

describe('POST /api/orders/:id/fulfillment', () => {
  let order: any;
  beforeAll(async () => { order = await placeAndPay(buyer, UNIT_A); });

  it('rejects a bad signature', async () => {
    const ev = fulfillmentEvent(owner, order, 'shipped');
    const bad = { ...ev, sig: ev.sig.replace(/^./, ev.sig[0] === '0' ? '1' : '0') };
    const r = await post(`/api/orders/${order.order_id}/fulfillment`, { hex: owner.pk, event: bad });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('INVALID_SIGNATURE');
  });

  it('rejects a foreign signer (and a hex that is not the signer)', async () => {
    const r = await post(`/api/orders/${order.order_id}/fulfillment`, { hex: stranger.pk, event: fulfillmentEvent(stranger, order, 'shipped') });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('NOT_AUTHORIZED');
    const r2 = await post(`/api/orders/${order.order_id}/fulfillment`, { hex: staff.pk, event: fulfillmentEvent(owner, order, 'shipped') });
    expect(r2.status).toBe(403);
    expect(r2.json.error).toBe('SIGNER_MISMATCH');
  });

  it('rejects the wrong kind and a d mismatch', async () => {
    const r = await post(`/api/orders/${order.order_id}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(owner, order, 'shipped', [], 36520) });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('INVALID_KIND');
    const other = { ...order, order_id: orderIdFor(buyer.pk) };
    const r2 = await post(`/api/orders/${order.order_id}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(owner, other, 'shipped') });
    expect(r2.status).toBe(400);
    expect(r2.json.error).toBe('D_MISMATCH');
  });

  it('rejects an unpaid order', async () => {
    const d = orderIdFor(buyer2.pk);
    ingestEvent(db, orderEvent(buyer2, UNIT_A, d), trusted);
    await resolveOrders(db, { orderIds: [d], trusted, fetchListing: listing });
    const unpaid = db.prepare('SELECT * FROM shop_orders WHERE order_id = ?').get(d) as any;
    const r = await post(`/api/orders/${d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(owner, { ...unpaid, paid_signer_hex: brain.pk, paid_tx_id: 'tx' }, 'received') });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('NOT_PAID');
  });

  it('accepts staff, keeps the order pending until shipped', async () => {
    const r = await post(`/api/orders/${order.order_id}/fulfillment`, { hex: staff.pk, event: fulfillmentEvent(staff, order, 'packed') });
    expect(r.status).toBe(200);
    expect(r.json.published).toBe(true);
    expect(r.json.relays.ok.length).toBe(1);
    const row = db.prepare('SELECT fulfillment_status, fulfillment_pubkey, pending, fulfillment_published FROM shop_orders WHERE order_id = ?').get(order.order_id) as any;
    expect(row).toEqual({ fulfillment_status: 'packed', fulfillment_pubkey: staff.pk, pending: 1, fulfillment_published: 1 });
  });

  it('double POST → one row + 409; then a regression is refused', async () => {
    const ev = fulfillmentEvent(owner, order, 'shipped', [['carrier', 'Pošta'], ['tracking', 'RR123']], 36521, now() + 1);
    const first = await post(`/api/orders/${order.order_id}/fulfillment`, { hex: owner.pk, event: ev });
    expect(first.status).toBe(200);
    const second = await post(`/api/orders/${order.order_id}/fulfillment`, { hex: owner.pk, event: ev });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe('STALE_STATUS');
    expect(db.prepare('SELECT COUNT(*) AS c FROM shop_order_fulfillments WHERE order_id = ?').get(order.order_id)).toEqual({ c: 1 });
    const row = db.prepare('SELECT fulfillment_status, fulfillment_carrier, fulfillment_tracking, pending, effective_status FROM shop_orders WHERE order_id = ?').get(order.order_id) as any;
    expect(row).toEqual({ fulfillment_status: 'shipped', fulfillment_carrier: 'Pošta', fulfillment_tracking: 'RR123', pending: 0, effective_status: 'shipped' });

    const back = await post(`/api/orders/${order.order_id}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(owner, order, 'packed', [], 36521, now() + 2) });
    expect(back.status).toBe(409);
    expect(back.json.error).toBe('STATUS_REGRESSION');

    // The badge dropped: this order is no longer pending for anyone.
    const c = await get(`/api/orders/pending-count?hex=${owner.pk}`);
    expect(c.json.latest.map((x: any) => x.order_id)).not.toContain(order.order_id);
  });

  it('a resync keeps the freshly published fulfillment (write-through survives resolve)', async () => {
    await resolveOrders(db, { orderIds: [order.order_id], trusted, fetchListing: listing });
    const row = db.prepare('SELECT effective_status, pending, fulfillment_published FROM shop_orders WHERE order_id = ?').get(order.order_id) as any;
    expect(row).toEqual({ effective_status: 'shipped', pending: 0, fulfillment_published: 1 });
  });
});

describe('transitionAllowed', () => {
  it('follows SPEC §3', () => {
    expect(transitionAllowed(null, 'received')).toBe(true);
    expect(transitionAllowed(null, 'shipped')).toBe(true);
    expect(transitionAllowed('packed', 'shipped')).toBe(true);
    expect(transitionAllowed('shipped', 'packed')).toBe(false);
    expect(transitionAllowed('shipped', 'shipped')).toBe(false);
    expect(transitionAllowed('delivered', 'rejected')).toBe(true);
    expect(transitionAllowed('completed', 'refunded')).toBe(false);
    expect(transitionAllowed('rejected', 'refunded')).toBe(true);
    expect(transitionAllowed('refunded', 'shipped')).toBe(false);
  });
});
