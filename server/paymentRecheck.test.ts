// @vitest-environment node
/**
 * Round 5, F2 + F5 (5 Oct 2026): money the merchant app acts on is read
 * fresh.
 *
 *   F2 — the listing price that judges an order is read again every tick:
 *        a price the merchant changed is seen on the next tick (MW4), not
 *        up to ten ticks later from a module-wide 10-minute cache.
 *   F5 — the brain cancels a purchase by republishing its 30933 (same d =
 *        tx id) with status 'cancelled'. The sync re-read that only for
 *        paid orders still pending, so for a REJECTED (or shipped, or
 *        delivered) paid order a cancellation was never seen and the
 *        merchant could refund money that never came in (MW5). Now:
 *          - every 5th tick the sync also re-reads rejected / shipped /
 *            delivered paid orders' 30933 (60 days by the brain-signed
 *            paid_at; ≤ 2000, 100 tx ids per REQ);
 *          - before 'shipped', 'delivered' or 'refunded' the fulfillment
 *            route reads the 30933 live and re-judges the order if it
 *            changed; no relay finished the read ⇒ 503, nothing written.
 *
 * Everything runs against loopback relay stubs; nothing leaves 127.0.0.1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Before any import reads it: a code path that falls back to the built-in
// relay list must find a dead loopback relay, never the production ones.
vi.hoisted(() => { process.env.LANA_RELAYS_OVERRIDE = 'ws://127.0.0.1:9'; });

import Database from 'better-sqlite3';
import express from 'express';
import crypto from 'crypto';
import net from 'net';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { initializeSchema } from './db/schema.js';
import { registerOrderRoutes } from './orders.js';
import * as orderSync from './lib/orderSync.js';
import { bindingString } from './lib/orderResolver.js';

const mk = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const owner = mk(), brain = mk();
const UNIT = '5'.repeat(32);
const REF = `30901:${owner.pk}:${UNIT}`;
const now = () => Math.floor(Date.now() / 1000);
const orderIdFor = (pk: string) => `${pk.slice(0, 24)}.${crypto.randomBytes(16).toString('hex')}`;

function sign(sk: Uint8Array, kind: number, tags: string[][], content = '', createdAt = now()) {
  return finalizeEvent({ kind, tags, content, created_at: createdAt }, sk) as any;
}
function listingEvent(d: string, price: string, createdAt: number) {
  return sign(owner.sk, 36502, [['d', d], ['a', REF], ['title', 'Jabolka'], ['price', price, 'EUR'], ['unit', 'kg'], ['status', 'active']], '', createdAt);
}
function orderEvent(b: { sk: Uint8Array; pk: string }, d: string, listingA: string, total: string, createdAt: number) {
  return sign(b.sk, 36520, [
    ['d', d], ['a', REF], ['p', owner.pk], ['unit_id', UNIT], ['invoice_number', d],
    ['item', listingA, '2', 'kg', '5.00', 'EUR'],
    ['shipping', '2.50', 'EUR'], ['total', total, 'EUR'], ['fulfillment', 'shipping'], ['status', 'placed'],
    ['pay_by', String(createdAt + 1800)], ['client', 'lanaeco.shop'], ['v', '1'],
  ], '', createdAt);
}
function purchaseEvent(d: string, buyerPk: string, txId: string, createdAt: number) {
  return sign(brain.sk, 30933, [
    ['d', txId], ['p', 'f'.repeat(64)], ['unit_id', UNIT], ['payment_type', 'lana'], ['customer_hex', 'f'.repeat(64)],
    ['merchant_hex', owner.pk], ['amount', '12.50'], ['currency', 'EUR'], ['lana_amount', '9765432100'],
    ['status', 'processing'], ['invoice_number', d], ['receipt_description', `Jabolka ×2 · ${bindingString(buyerPk, d)}`],
  ], '', createdAt);
}
/** The brain's cancel republish (lana-brain cancelTransaction.ts): same d, status cancelled. */
function cancelledPurchaseEvent(d: string, txId: string, createdAt = now() - 10) {
  return sign(brain.sk, 30933, [
    ['d', txId], ['p', 'f'.repeat(64)], ['unit_id', UNIT], ['payment_type', 'lana'], ['customer_hex', 'f'.repeat(64)],
    ['merchant_hex', owner.pk], ['amount', '12.50'], ['currency', 'EUR'], ['status', 'cancelled'],
    ['cancelled_at', new Date().toISOString()], ['invoice_number', d],
  ], '', createdAt);
}
function fulfillmentEvent(o: { d: string; buyerPk: string; txId: string }, status: string, createdAt = now()) {
  return sign(owner.sk, 36521, [
    ['d', o.d], ['a', `36520:${o.buyerPk}:${o.d}`], ['a', REF], ['p', o.buyerPk], ['unit_id', UNIT], ['status', status],
    ['payment', `30933:${brain.pk}:${o.txId}`], ['v', '1'],
  ], '', createdAt);
}

// ── loopback relay stubs: honour kinds / authors / #d; record every REQ filter ──
interface Stub { server: WebSocketServer; url: string; reqs: any[] }
let relayEvents: any[] = [];
function matches(ev: any, f: any): boolean {
  if (Array.isArray(f.kinds) && !f.kinds.includes(ev.kind)) return false;
  if (Array.isArray(f.authors) && !f.authors.includes(ev.pubkey)) return false;
  if (Array.isArray(f['#d']) && !f['#d'].includes(ev.tags.find((t: string[]) => t[0] === 'd')?.[1])) return false;
  for (const k of Object.keys(f)) {
    if (!k.startsWith('#') || k === '#d' || !Array.isArray(f[k])) continue;
    if (!ev.tags.some((t: string[]) => t[0] === k.slice(1) && f[k].includes(t[1]))) return false;
  }
  return true;
}
async function startStub(): Promise<Stub> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(r => server.once('listening', r));
  const stub: Stub = { server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, reqs: [] };
  server.on('connection', (socket) => {
    socket.on('message', (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m[0] === 'REQ') {
          const [, sub, ...filters] = m;
          stub.reqs.push(...filters);
          for (const ev of relayEvents) if (filters.some((f: any) => matches(ev, f))) socket.send(JSON.stringify(['EVENT', sub, ev]));
          socket.send(JSON.stringify(['EOSE', sub]));
        } else if (m[0] === 'EVENT') {
          socket.send(JSON.stringify(['OK', m[1].id, true, '']));
        }
      } catch { /* ignore */ }
    });
  });
  return stub;
}
/** A loopback URL nobody listens on: every connection is refused. */
async function deadUrl(): Promise<string> {
  const srv = net.createServer();
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>(r => srv.close(() => r()));
  return `ws://127.0.0.1:${port}`;
}

let db: Database.Database;
let stub: Stub;
let base = '';
let httpServer: any;
const trusted = new Set([brain.pk]);
const row = (d: string) => db.prepare('SELECT * FROM shop_orders WHERE order_id = ?').get(d) as any;
const post = async (p: string, body: any) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};
const byTxReqs = (s: Stub) => s.reqs.filter(f => Array.isArray(f.kinds) && f.kinds.includes(30933) && Array.isArray(f['#d']));

beforeAll(async () => {
  stub = await startStub();
  process.env.LANA_RELAYS_OVERRIDE = stub.url;
  process.env.LANA_TRUSTED_SIGNERS_OVERRIDE = brain.pk;
  db = new Database(':memory:');
  initializeSchema(db);
  const unitEv = sign(owner.sk, 30901, [['d', UNIT], ['unit_id', UNIT], ['online_shop', 'true'], ['online_shop_shipping_fee', '2.50']], '', now() - 86_400);
  db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event)
    VALUES (?, ?, ?, ?, 'Sadovnjak', ?, ?, 'EUR', 'active', ?)
  `).run(UNIT, unitEv.id, owner.pk, unitEv.created_at, owner.pk, JSON.stringify([owner.pk]), JSON.stringify(unitEv));
  const app = express();
  app.use(express.json());
  registerOrderRoutes(app, db);
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => httpServer.once('listening', r));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env.LANA_TRUSTED_SIGNERS_OVERRIDE;
  await new Promise<void>(r => httpServer.close(() => r()));
  await new Promise<void>(r => stub.server.close(() => r()));
  db.close();
});

beforeEach(() => {
  for (const t of ['shop_orders', 'shop_order_payments', 'shop_order_fulfillments', 'shop_order_delivery', 'shop_order_item_snapshots', 'shop_order_listing_prices', 'shop_order_sync_state', 'shop_order_settle_review']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  relayEvents = [];
  stub.reqs.length = 0;
  process.env.LANA_RELAYS_OVERRIDE = stub.url;
});

/** A paid, pinned order of 2 × <listing> at 5.00 + 2.50, judged by a tick; then rejected by the merchant. */
async function paidThenRejected() {
  const buyer = mk();
  const d = orderIdFor(buyer.pk);
  const listingD = `apples-${crypto.randomBytes(4).toString('hex')}`;
  const t0 = now() - 600;
  const txId = crypto.randomUUID();
  relayEvents = [listingEvent(listingD, '5.00', now() - 86_400)];
  expect(orderSync.ingestEvent(db, orderEvent(buyer, d, `36502:${owner.pk}:${listingD}`, '12.50', t0), trusted)).toBe(d);
  expect(orderSync.ingestEvent(db, purchaseEvent(d, buyer.pk, txId, t0 + 60), trusted)).toBe(d);
  await orderSync.resolveOrders(db, { orderIds: [d], trusted, fetchListing: orderSync.makeListingFetcher([stub.url], 2000), now: now() });
  expect(row(d)).toMatchObject({ payment_state: 'paid', pending: 1 });
  const o = { d, buyerPk: buyer.pk, txId, listingD };
  const rej = await post(`/api/orders/${d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(o, 'rejected', now() - 30) });
  expect(rej.status).toBe(200);
  expect(row(d)).toMatchObject({ payment_state: 'paid', effective_status: 'rejected', pending: 0 });
  // no order is open: the window read of step 2 has nothing to read for
  expect(db.prepare(`SELECT COUNT(*) AS n FROM shop_orders WHERE payment_state IN ('unpaid','expired')`).get()).toEqual({ n: 0 });
  return o;
}

describe('F2 — the listing price is read again every tick', () => {
  it('MW4: a price change between ticks is seen on the next tick', async () => {
    const buyer = mk();
    const d = orderIdFor(buyer.pk);
    const listingD = `pears-${crypto.randomBytes(4).toString('hex')}`;
    relayEvents = [listingEvent(listingD, '5.00', now() - 86_400)];
    expect(orderSync.ingestEvent(db, orderEvent(buyer, d, `36502:${owner.pk}:${listingD}`, '12.50', now() - 120), trusted)).toBe(d);
    await orderSync.syncShopOrders(db, [stub.url]);
    expect(row(d)).toMatchObject({ payment_state: 'unpaid', expected_total: '12.50' });

    // the merchant raises the price; one minute later the next tick runs
    relayEvents = [listingEvent(listingD, '6.00', now() - 5)];
    await orderSync.syncShopOrders(db, [stub.url]);
    expect(row(d)).toMatchObject({ payment_state: 'unpaid', expected_total: '14.50' });
  });
});

describe('F5 — a cancelled payment is never refunded or shipped', () => {
  it('MW5: a rejected paid order whose 30933 the brain republishes as cancelled, while no order is open, ends not paid; refund → 409', async () => {
    const o = await paidThenRejected();
    relayEvents = [listingEvent(o.listingD, '5.00', now() - 86_400), cancelledPurchaseEvent(o.d, o.txId)];
    stub.reqs.length = 0;
    await orderSync.syncShopOrders(db, [stub.url]);
    expect(byTxReqs(stub).some(f => f['#d'].includes(o.txId))).toBe(true);
    const r = row(o.d);
    expect(r.payment_state).not.toBe('paid');
    expect(r.effective_status).toBe('rejected');

    const refund = await post(`/api/orders/${o.d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(o, 'refunded') });
    expect(refund.status).toBe(409);
    expect(refund.json.error).toBe('NOT_PAID');
    expect(db.prepare('SELECT status FROM shop_order_fulfillments WHERE order_id = ?').get(o.d)).toEqual({ status: 'rejected' });
  });

  it('a cancel already on the relays before the tick: the refund POST reads it live and answers 409', async () => {
    const o = await paidThenRejected();
    relayEvents = [listingEvent(o.listingD, '5.00', now() - 86_400), cancelledPurchaseEvent(o.d, o.txId)];
    stub.reqs.length = 0;
    const refund = await post(`/api/orders/${o.d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(o, 'refunded') });
    expect(byTxReqs(stub).some(f => JSON.stringify(f['#d']) === JSON.stringify([o.txId]))).toBe(true);
    expect(refund.status).toBe(409);
    expect(refund.json.error).toBe('NOT_PAID');
    expect(row(o.d).payment_state).not.toBe('paid');
    expect(db.prepare('SELECT status FROM shop_order_fulfillments WHERE order_id = ?').get(o.d)).toEqual({ status: 'rejected' });
  });

  it('a cancel already stored but not judged yet (a sync cut short) is judged before the refund: 409', async () => {
    const o = await paidThenRejected();
    // stored by ingest, never resolved; the relays hold nothing newer
    expect(orderSync.ingestEvent(db, cancelledPurchaseEvent(o.d, o.txId), trusted)).toBe(o.d);
    expect(row(o.d).payment_state).toBe('paid');
    const refund = await post(`/api/orders/${o.d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(o, 'refunded') });
    expect(refund.status).toBe(409);
    expect(refund.json.error).toBe('NOT_PAID');
    expect(row(o.d).payment_state).not.toBe('paid');
  });

  it('…and while the 30933 still stands, the refund goes through after the live read', async () => {
    const o = await paidThenRejected();
    const refund = await post(`/api/orders/${o.d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(o, 'refunded') });
    expect(refund.status).toBe(200);
    expect(row(o.d)).toMatchObject({ payment_state: 'paid', effective_status: 'refunded' });
  });

  it('no relay answers: 503 PAYMENT_CHECK_UNAVAILABLE and nothing written — for refunded and for shipped', async () => {
    const o = await paidThenRejected();
    const before = row(o.d);
    const fBefore = db.prepare('SELECT * FROM shop_order_fulfillments WHERE order_id = ?').get(o.d);
    process.env.LANA_RELAYS_OVERRIDE = await deadUrl();
    try {
      const refund = await post(`/api/orders/${o.d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(o, 'refunded') });
      expect(refund.status).toBe(503);
      expect(refund.json.error).toBe('PAYMENT_CHECK_UNAVAILABLE');
      expect(row(o.d)).toEqual(before);
      expect(db.prepare('SELECT * FROM shop_order_fulfillments WHERE order_id = ?').get(o.d)).toEqual(fBefore);

      // a paid order not yet shipped, same answer
      const buyer = mk();
      const d = orderIdFor(buyer.pk);
      const txId = crypto.randomUUID();
      expect(orderSync.ingestEvent(db, orderEvent(buyer, d, `36502:${owner.pk}:${o.listingD}`, '12.50', now() - 300), trusted)).toBe(d);
      expect(orderSync.ingestEvent(db, purchaseEvent(d, buyer.pk, txId, now() - 200), trusted)).toBe(d);
      await orderSync.resolveOrders(db, { orderIds: [d], trusted, fetchListing: async () => ({ price: '5.00', currency: 'EUR', status: 'active', createdAt: now() - 86_400, unitRef: REF }), now: now() });
      const paid = row(d);
      expect(paid).toMatchObject({ payment_state: 'paid', pending: 1 });
      const ship = await post(`/api/orders/${d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent({ d, buyerPk: buyer.pk, txId }, 'shipped') });
      expect(ship.status).toBe(503);
      expect(ship.json.error).toBe('PAYMENT_CHECK_UNAVAILABLE');
      expect(row(d)).toEqual(paid);
      expect(db.prepare('SELECT COUNT(*) AS n FROM shop_order_fulfillments WHERE order_id = ?').get(d)).toEqual({ n: 0 });
    } finally {
      process.env.LANA_RELAYS_OVERRIDE = stub.url;
    }
  });

  it('refreshPurchaseByTx: "read" when a relay finished the REQ (and ingests what it served), "unreadable" when none did', async () => {
    const o = await paidThenRejected();
    relayEvents = [cancelledPurchaseEvent(o.d, o.txId)];
    expect(await orderSync.refreshPurchaseByTx(db, [await deadUrl()], trusted, o.txId, 1000)).toBe('unreadable');
    expect((db.prepare('SELECT status FROM shop_order_payments WHERE tx_id = ?').get(o.txId) as any).status).toBe('processing');
    expect(await orderSync.refreshPurchaseByTx(db, [stub.url], new Set(), o.txId, 1000)).toBe('unreadable');
    expect(await orderSync.refreshPurchaseByTx(db, [await deadUrl(), stub.url], trusted, o.txId, 1000)).toBe('read');
    expect((db.prepare('SELECT status FROM shop_order_payments WHERE tx_id = ?').get(o.txId) as any).status).toBe('cancelled');
  });
});

describe('F5 — which 30933 step 2b re-reads', () => {
  /** A paid row straight into the table (no relay round-trip): judged, pinned, not active. */
  function insertPaid(i: number, opts: { effective: string; pending: 0 | 1; paidAt: number | null; createdAt?: number; tx?: string }) {
    const d = `${'a'.repeat(24)}.${crypto.createHash('md5').update(`row${i}${Math.random()}`).digest('hex')}`;
    const eventId = crypto.createHash('sha256').update(d).digest('hex');
    const t = now();
    db.prepare(`
      INSERT INTO shop_orders (order_id, event_id, buyer_pubkey, created_at, unit_id, unit_owner_hex, items_json, shipping, total, currency,
        fulfillment, order_status, pay_by, raw_event, payment_state, effective_status, pending, paid_tx_id, paid_at,
        settled_order_event_id, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, '[]', '2.50', '12.50', 'EUR', 'shipping', 'placed', ?, '{}', 'paid', ?, ?, ?, ?, ?, ?)
    `).run(d, eventId, 'a'.repeat(64), opts.createdAt ?? t - 3600, UNIT, owner.pk, t, opts.effective, opts.pending, opts.tx ?? crypto.randomUUID(), opts.paidAt, eventId, t);
    return d;
  }

  it('250 tx ids give 3 REQs per relay (100 + 100 + 50)', async () => {
    const second = await startStub();
    try {
      for (let i = 0; i < 250; i++) insertPaid(i, { effective: i % 3 === 0 ? 'rejected' : i % 3 === 1 ? 'shipped' : 'delivered', pending: 0, paidAt: now() - 86_400 });
      // the dev override wins over the relay list handed in (readRelays), so name both there
      process.env.LANA_RELAYS_OVERRIDE = `${stub.url},${second.url}`;
      await orderSync.syncShopOrders(db, [stub.url, second.url]);
      for (const s of [stub, second]) {
        const sizes = byTxReqs(s).map(f => f['#d'].length).sort((a, b) => b - a);
        expect(sizes).toEqual([100, 100, 50]);
      }
    } finally {
      await new Promise<void>(r => second.server.close(() => r()));
    }
  });

  it('terminal orders are re-read every 5th tick; pending ones every tick', async () => {
    const shipped = insertPaid(1, { effective: 'shipped', pending: 0, paidAt: now() - 86_400 });
    // a real paid order still pending (its listing and 30933 stand, so every tick keeps it paid)
    const buyer = mk();
    const open = orderIdFor(buyer.pk);
    const listingD = `plums-${crypto.randomBytes(4).toString('hex')}`;
    const openTx = crypto.randomUUID();
    relayEvents = [listingEvent(listingD, '5.00', now() - 86_400)];
    expect(orderSync.ingestEvent(db, orderEvent(buyer, open, `36502:${owner.pk}:${listingD}`, '12.50', now() - 600), trusted)).toBe(open);
    expect(orderSync.ingestEvent(db, purchaseEvent(open, buyer.pk, openTx, now() - 500), trusted)).toBe(open);
    const tx = (d: string) => row(d).paid_tx_id;
    const readThisTick = async () => {
      stub.reqs.length = 0;
      await orderSync.syncShopOrders(db, [stub.url]);
      return new Set(byTxReqs(stub).flatMap(f => f['#d']));
    };
    db.prepare(`INSERT INTO shop_order_sync_state (key, value) VALUES ('tick', '1')`).run();
    await orderSync.resolveOrders(db, { orderIds: [open], trusted, fetchListing: orderSync.makeListingFetcher([stub.url], 2000), now: now() });
    expect(row(open)).toMatchObject({ payment_state: 'paid', pending: 1 });
    for (const t of [2, 3, 4, 5]) {
      const ids = await readThisTick();
      expect(ids.has(tx(open)), `tick ${t}`).toBe(true);
      expect(ids.has(tx(shipped)), `tick ${t}`).toBe(false);
    }
    const sixth = await readThisTick();
    expect(sixth.has(tx(open))).toBe(true);
    expect(sixth.has(tx(shipped))).toBe(true);
  });

  it('the window is 60 days by the brain-signed paid_at, not the buyer-signed created_at', () => {
    const DAY = 86_400;
    const recent = insertPaid(1, { effective: 'rejected', pending: 0, paidAt: now() - 59 * DAY });
    const old = insertPaid(2, { effective: 'delivered', pending: 0, paidAt: now() - 61 * DAY });
    // a buyer-chosen created_at in the window does not bring an old payment back
    const backdated = insertPaid(3, { effective: 'shipped', pending: 0, paidAt: now() - 90 * DAY, createdAt: now() - DAY });
    // …and one far in the past does not drop a recent payment
    const lateOrder = insertPaid(4, { effective: 'shipped', pending: 0, paidAt: now() - DAY, createdAt: now() - 120 * DAY });
    const completed = insertPaid(5, { effective: 'completed', pending: 0, paidAt: now() - DAY });
    const ids = new Set(orderSync.txIdsToRecheck(db, now(), true));
    expect(ids.has(row(recent).paid_tx_id)).toBe(true);
    expect(ids.has(row(lateOrder).paid_tx_id)).toBe(true);
    expect(ids.has(row(old).paid_tx_id)).toBe(false);
    expect(ids.has(row(backdated).paid_tx_id)).toBe(false);
    expect(ids.has(row(completed).paid_tx_id)).toBe(false);
    expect(orderSync.txIdsToRecheck(db, now(), false)).toEqual([]);
  });
});
