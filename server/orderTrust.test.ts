// @vitest-environment node
/**
 * Lana Online Shop — what the merchant app believes about money (review of
 * 2 Oct 2026).
 *
 * The buyer's ephemeral key lives in the buyer's browser, so the buyer can
 * sign a REPLACEMENT 36520 with the same d at any time and publish it
 * straight to the relays. The brain, when it cancels a purchase, republishes
 * the same 30933 d with status 'cancelled'. Pinned here:
 *
 *   (1) a replacement 36520 never prices itself: a line whose listing is not
 *       found (another listing kind, a failed REQ) makes the order unpaid
 *       until the merchant-signed price is known — no buyer unit_price;
 *   (2) only listing kinds may be ordered;
 *   (3) a cancellation of a paid order's 30933 is seen even when no other
 *       order is open, so the merchant cannot ship a cancelled order;
 *   (7) between storing a replacement and judging it, the order is not
 *       shown — or fulfillable — as paid;
 *   and an order whose listing was not found is judged again until it is.
 *
 * Everything runs against a loopback relay stub; nothing leaves 127.0.0.1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { initializeSchema } from './db/schema.js';
import { registerOrderRoutes } from './orders.js';
import {
  ingestEvent, resolveOrders, activeOrderIds, syncShopOrders, parseOrderEvent, clearListingCache, makeListingFetcher,
  unitToResolver, unitRow, orderTimeSnapshotPrice, type ListingFetcher,
} from './lib/orderSync.js';
import { bindingString } from './lib/orderResolver.js';

const mk = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const owner = mk(), brain = mk();
const UNIT = 'e'.repeat(32);
const now = () => Math.floor(Date.now() / 1000);
const orderIdFor = (pk: string) => `${pk.slice(0, 24)}.${crypto.randomBytes(16).toString('hex')}`;
const APPLES = `36502:${owner.pk}:apples`;
const PEARS = `36502:${owner.pk}:pears`;

function sign(sk: Uint8Array, kind: number, tags: string[][], content = '', createdAt = now()) {
  return finalizeEvent({ kind, tags, content, created_at: createdAt }, sk) as any;
}

function listingEvent(d: string, price: string, title: string) {
  return sign(owner.sk, 36502, [
    ['d', d], ['a', `30901:${owner.pk}:${UNIT}`], ['title', title], ['price', price, 'EUR'], ['unit', 'kg'], ['status', 'active'],
  ], '', now() - 86_400);
}

/** 36520 with the shop's tags around `items`; shipping 2.50. */
function orderEvent(b: { sk: Uint8Array; pk: string }, d: string, items: string[][], total: string, createdAt: number) {
  return sign(b.sk, 36520, [
    ['d', d], ['a', `30901:${owner.pk}:${UNIT}`], ['p', owner.pk], ['unit_id', UNIT], ['invoice_number', d],
    ...items,
    ['shipping', '2.50', 'EUR'], ['total', total, 'EUR'], ['fulfillment', 'shipping'], ['status', 'placed'],
    ['pay_by', String(createdAt + 1800)], ['client', 'lanaeco.shop'], ['v', '1'],
  ], '', createdAt);
}

function purchaseEvent(d: string, buyerPk: string, txId: string, amount = '12.50', createdAt = now() - 60) {
  return sign(brain.sk, 30933, [
    ['d', txId], ['p', 'f'.repeat(64)], ['unit_id', UNIT], ['payment_type', 'lana'], ['customer_hex', 'f'.repeat(64)],
    ['merchant_hex', owner.pk], ['amount', amount], ['currency', 'EUR'], ['lana_amount', '9765432100'],
    ['status', 'processing'], ['invoice_number', d], ['receipt_description', `Jabolka ×2 · ${bindingString(buyerPk, d)}`],
  ], '', createdAt);
}

/** The brain's cancel republish (lana-brain cancelTransaction.ts): same d, no receipt_description. */
function cancelledPurchaseEvent(d: string, txId: string, createdAt = now() - 10) {
  return sign(brain.sk, 30933, [
    ['d', txId], ['p', 'f'.repeat(64)], ['unit_id', UNIT], ['payment_type', 'lana'], ['customer_hex', 'f'.repeat(64)],
    ['customer_wallet', ''], ['merchant_hex', owner.pk], ['amount', '12.50'], ['currency', 'EUR'], ['exchange_rate', '0.001'],
    ['status', 'cancelled'], ['cancelled_at', new Date().toISOString()], ['cancelled_by', ''], ['cancel_reason', ''],
    ['invoice_number', d],
  ], '', createdAt);
}

function fulfillmentEvent(order: any, status: string) {
  return sign(owner.sk, 36521, [
    ['d', order.order_id], ['a', `36520:${order.buyer_pubkey}:${order.order_id}`], ['a', `30901:${owner.pk}:${UNIT}`],
    ['p', order.buyer_pubkey], ['unit_id', UNIT], ['status', status],
    ['payment', `30933:${order.paid_signer_hex}:${order.paid_tx_id}`], ['v', '1'],
  ]);
}

// ── loopback relay stub: honours kinds, authors and #d; records every REQ ──
let relayEvents: any[] = [];
const reqs: any[] = [];
let relay: WebSocketServer;
let relayUrl = '';
function matches(ev: any, f: any): boolean {
  if (Array.isArray(f.kinds) && !f.kinds.includes(ev.kind)) return false;
  if (Array.isArray(f.authors) && !f.authors.includes(ev.pubkey)) return false;
  if (Array.isArray(f['#d']) && !f['#d'].includes(ev.tags.find((t: string[]) => t[0] === 'd')?.[1])) return false;
  return true;
}

let db: Database.Database;
let base = '';
let httpServer: any;
const trusted = new Set([brain.pk]);
const LISTED: Record<string, string> = { [APPLES]: '5.00', [PEARS]: '50.00' };
/** Merchant-signed prices by address; `down` = the REQ for that address failed. */
function fetcher(down: string[] = []): ListingFetcher {
  return async (a: string) => (LISTED[a] && !down.includes(a))
    ? { price: LISTED[a], currency: 'EUR', status: 'active', createdAt: now() - 86_400, unitRef: `30901:${owner.pk}:${UNIT}` }
    : null;
}
const row = (d: string) => db.prepare('SELECT * FROM shop_orders WHERE order_id = ?').get(d) as any;
const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, json: await r.json() as any }; };
const post = async (path: string, body: any) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};

/** E1 = 2 × apples at 5.00 + 2.50 shipping = 12.50, with its 30933, judged once. */
async function placeApples(fetchListing = fetcher()) {
  const buyer = mk();
  const d = orderIdFor(buyer.pk);
  const t0 = now() - 120;
  const txId = crypto.randomUUID();
  expect(ingestEvent(db, orderEvent(buyer, d, [['item', APPLES, '2', 'kg', '5.00', 'EUR']], '12.50', t0), trusted)).toBe(d);
  expect(ingestEvent(db, purchaseEvent(d, buyer.pk, txId), trusted)).toBe(d);
  await resolveOrders(db, { orderIds: [d], trusted, fetchListing, now: now() });
  return { buyer, d, t0, txId };
}

/** …paid, pending and pinned. */
async function paidApples() {
  const p = await placeApples();
  const r = row(p.d);
  expect(r).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50' });
  expect(r.paid_order_event_id).toBe(r.event_id);
  return p;
}

beforeAll(async () => {
  relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(r => relay.once('listening', r));
  relay.on('connection', (socket) => {
    socket.on('message', (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m[0] === 'REQ') {
          const [, sub, filter] = m;
          reqs.push(filter);
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
  `).run(UNIT, 'e'.repeat(64), owner.pk, now(), 'Trgovina', owner.pk, JSON.stringify([owner.pk]),
    JSON.stringify({ kind: 30901, pubkey: owner.pk, tags: [['d', UNIT], ['unit_id', UNIT], ['online_shop', 'true'], ['online_shop_shipping_fee', '2.50'], ['online_shop_pickup', 'true']], content: '' }));

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
  // Every test starts with no order at all — "no order is open" must really be true.
  for (const t of ['shop_orders', 'shop_order_payments', 'shop_order_fulfillments', 'shop_order_delivery', 'shop_order_item_snapshots', 'shop_order_listing_prices', 'shop_order_sync_state', 'shop_order_settle_review']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  relayEvents = [];
  reqs.length = 0;
  clearListingCache();
});

describe('(1) a buyer-signed replacement 36520 never prices itself', () => {
  async function replace(p: Awaited<ReturnType<typeof paidApples>>, items: string[][], fetchListing = fetcher()) {
    expect(ingestEvent(db, orderEvent(p.buyer, p.d, items, '12.50', p.t0 + 5), trusted)).toBe(p.d);
    await resolveOrders(db, { orderIds: [p.d], trusted, fetchListing, now: now() });
    return row(p.d);
  }

  it('the real pears listing named under ANOTHER listing kind (36503) is unknown: not paid', async () => {
    const p = await paidApples();
    const r = await replace(p, [['item', `36503:${owner.pk}:pears`, '10', 'kg', '1.00', 'EUR']]);
    expect(r).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, paid_order_event_id: null });
  });

  it('apples plus "free" pears under another kind: not paid', async () => {
    const p = await paidApples();
    const r = await replace(p, [['item', APPLES, '2', 'kg', '5.00', 'EUR'], ['item', `36503:${owner.pk}:pears`, '10', 'kg', '0.00', 'EUR']]);
    expect(r).toMatchObject({ payment_state: 'amount_mismatch', pending: 0 });
  });

  it('the real pears address while its REQ fails: not paid; once it answers, judged on 50.00', async () => {
    const p = await paidApples();
    const items = [['item', PEARS, '10', 'kg', '1.00', 'EUR']];
    expect(await replace(p, items, fetcher([PEARS]))).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '' });
    // amount_mismatch is judged again on the next sync…
    expect(activeOrderIds(db, now())).toContain(p.d);
    await resolveOrders(db, { trusted, fetchListing: fetcher(), now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '502.50' });
  });

  it('an order whose listing was not found is judged again, and is paid once the listing answers', async () => {
    const { d } = await placeApples(fetcher([APPLES]));
    expect(row(d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0 });
    expect(activeOrderIds(db, now())).toContain(d);
    await resolveOrders(db, { trusted, fetchListing: fetcher(), now: now() });
    expect(row(d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50' });
  });
});

describe('(2) only listing kinds may be ordered', () => {
  it('an item that is not a listing (any other kind, an empty or extra d part) drops the order', () => {
    const b = mk();
    const d = orderIdFor(b.pk);
    for (const addr of [`30901:${owner.pk}:${UNIT}`, `1:${owner.pk}:x`, `36520:${owner.pk}:x`, `36517:${owner.pk}:x`, `36502:${owner.pk}:`, `36502:${owner.pk}:a:b`, `036502:${owner.pk}:apples`]) {
      expect(parseOrderEvent(orderEvent(b, d, [['item', addr, '1', 'kg', '5.00', 'EUR']], '7.50', now() - 60)), addr).toBeNull();
    }
    for (const kind of [36500, 36502, 36511, 36516, 31923]) {
      expect(parseOrderEvent(orderEvent(b, d, [['item', `${kind}:${owner.pk}:x`, '1', 'kg', '5.00', 'EUR']], '7.50', now() - 60)), String(kind)).not.toBeNull();
    }
  });

  it('a replacement naming a non-listing kind is not stored: the paid order stays as it was', async () => {
    const p = await paidApples();
    const e1 = row(p.d).event_id;
    expect(ingestEvent(db, orderEvent(p.buyer, p.d, [['item', `30901:${owner.pk}:${UNIT}`, '10', 'kg', '1.00', 'EUR']], '12.50', p.t0 + 5), trusted)).toBeNull();
    expect(row(p.d)).toMatchObject({ event_id: e1, payment_state: 'paid', pending: 1 });
  });
});

describe('(3) a cancelled 30933 is seen even when no order is open', () => {
  it('the brain cancels a paid order\'s purchase while nothing else is open: the merchant cannot ship it', async () => {
    const p = await paidApples();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM shop_orders WHERE payment_state IN ('unpaid','expired')`).get()).toEqual({ n: 0 });
    relayEvents = [listingEvent('apples', '5.00', 'Jabolka'), cancelledPurchaseEvent(p.d, p.txId)];

    await syncShopOrders(db, [relayUrl]);

    // read by the paid order's tx id
    expect(reqs.some(f => Array.isArray(f.kinds) && f.kinds.includes(30933) && JSON.stringify(f['#d']) === JSON.stringify([p.txId]))).toBe(true);
    const r = row(p.d);
    expect(r.payment_state).not.toBe('paid');
    expect(r.pending).toBe(0);
    const ship = await post(`/api/orders/${p.d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent({ ...r, paid_signer_hex: brain.pk, paid_tx_id: p.txId }, 'shipped') });
    expect(ship.status).toBe(409);
    expect(ship.json.error).toBe('NOT_PAID');
  });

  it('…and the paid order stays paid while its 30933 stands', async () => {
    const p = await paidApples();
    relayEvents = [listingEvent('apples', '5.00', 'Jabolka'), purchaseEvent(p.d, p.buyer.pk, p.txId)];
    await syncShopOrders(db, [relayUrl]);
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1 });
  });
});

describe('(7) a stored replacement is not "paid" before it is judged', () => {
  it('view, pending count and the fulfillment gate stop treating it as paid at once', async () => {
    const p = await paidApples();
    const paidRow = row(p.d);
    // E2 lands (ingest) — resolveOrders has not run yet
    expect(ingestEvent(db, orderEvent(p.buyer, p.d, [['item', PEARS, '10', 'kg', '1.00', 'EUR']], '12.50', p.t0 + 5), trusted)).toBe(p.d);

    const v = await get(`/api/orders/${p.d}?hex=${owner.pk}`);
    expect(v.json.items[0].a).toBe(PEARS);
    expect(v.json.paymentState).not.toBe('paid');
    expect(v.json.pending).toBe(false);
    expect((await get(`/api/orders/pending-count?hex=${owner.pk}`)).json.count).toBe(0);
    const ship = await post(`/api/orders/${p.d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(paidRow, 'shipped') });
    expect(ship.status).toBe(409);
    expect(ship.json.error).toBe('NOT_PAID');
    expect(activeOrderIds(db, now())).toContain(p.d);
  });

  it('the same event arriving again changes nothing', async () => {
    const p = await paidApples();
    const e1 = row(p.d);
    expect(ingestEvent(db, JSON.parse(e1.raw_event), trusted)).toBeNull();
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, paid_order_event_id: e1.event_id });
  });
});

describe('the live order of 2 Oct 2026 keeps its verdict', () => {
  it('1 × 4.08, pickup, paid then rejected, judged before step 5a (no paid_order_event_id): still paid when judged again', async () => {
    const b = mk();
    const d = orderIdFor(b.pk);
    const t0 = now() - 3 * 86_400;
    const ev = sign(b.sk, 36520, [
      ['d', d], ['a', `30901:${owner.pk}:${UNIT}`], ['p', owner.pk], ['unit_id', UNIT], ['invoice_number', d],
      ['item', APPLES, '1', 'g', '4.08', 'EUR'], ['shipping', '0.00', 'EUR'], ['total', '4.08', 'EUR'], ['fulfillment', 'pickup'],
      ['status', 'placed'], ['pay_by', String(t0 + 1800)], ['client', 'lanaeco.shop'], ['v', '1'],
    ], '', t0);
    const txId = crypto.randomUUID();
    expect(ingestEvent(db, ev, trusted)).toBe(d);
    expect(ingestEvent(db, purchaseEvent(d, b.pk, txId, '4.08', t0 + 44), trusted)).toBe(d);
    // as live: the listing was republished after the order, with unit 'kos' where the order says 'g'
    const listing408: ListingFetcher = async () => ({ price: '4.08', currency: 'EUR', status: 'active', createdAt: now() - 60, unitRef: `30901:${owner.pk}:${UNIT}`, unit: 'kos' });
    await resolveOrders(db, { orderIds: [d], trusted, fetchListing: listing408, now: now() });
    db.prepare(`UPDATE shop_orders SET paid_order_event_id = NULL, settled_order_event_id = NULL, fulfillment_status = 'rejected', effective_status = 'rejected', pending = 0 WHERE order_id = ?`).run(d);
    db.prepare('DELETE FROM shop_order_listing_prices').run();
    db.prepare(`INSERT INTO shop_order_fulfillments (order_id, event_id, pubkey, created_at, status, raw_event, published) VALUES (?, ?, ?, ?, 'rejected', '{}', 1)`)
      .run(d, 'f'.repeat(64), owner.pk, t0 + 600);
    await resolveOrders(db, { orderIds: [d], trusted, fetchListing: listing408, now: now() });
    expect(row(d)).toMatchObject({ payment_state: 'paid', expected_total: '4.08', price_changed: 1, effective_status: 'rejected', pending: 0 });
    expect(row(d).settled_order_event_id).toBe(row(d).event_id);
    const v = await get(`/api/orders/${d}?hex=${owner.pk}`);
    expect(v.json).toMatchObject({ paymentState: 'paid', effectiveStatus: 'rejected', total: '4.08', shipping: '0.00', buyer_total: '4.08' });
  });
});

/**
 * Second review of 2 Oct 2026 (SPEC v1.1.2). E1 = 2 × apples at 5.00 + 2.50
 * shipping = 12.50, paid; E2 = the buyer's replacement with the same d.
 */
describe('SPEC v1.1.2 — the merchant app pays and shows only the merchant\'s numbers', () => {
  const REF = () => `30901:${owner.pk}:${UNIT}`;
  async function replaceWith(p: Awaited<ReturnType<typeof paidApples>>, items: string[][], total: string, fetchListing: ListingFetcher = fetcher(), extra: Partial<{ shipping: string; fulfillment: string }> = {}) {
    const ev = sign(p.buyer.sk, 36520, [
      ['d', p.d], ['a', REF()], ['p', owner.pk], ['unit_id', UNIT], ['invoice_number', p.d],
      ...items,
      ['shipping', extra.shipping ?? '2.50', 'EUR'], ['total', total, 'EUR'], ['fulfillment', extra.fulfillment ?? 'shipping'], ['status', 'placed'],
      ['pay_by', String(p.t0 + 1800)], ['client', 'lanaeco.shop'], ['v', '1'],
    ], '', p.t0 + 5);
    expect(ingestEvent(db, ev, trusted)).toBe(p.d);
    await resolveOrders(db, { orderIds: [p.d], trusted, fetchListing, now: now() });
    return row(p.d);
  }

  it('D: the same line re-signed as unit_price 500.00, sale unit "crate", total 1002.50 is not paid — and never shown as the amount', async () => {
    const p = await paidApples();
    const r = await replaceWith(p, [['item', APPLES, '2', 'crate', '500.00', 'EUR']], '1002.50');
    expect(r).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '12.50' });
    const v = await get(`/api/orders/${p.d}?hex=${owner.pk}`);
    expect(v.json.total).toBe('12.50');
    expect(v.json.buyer_total).toBe('1002.50');
    const ship = await post(`/api/orders/${p.d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(r, 'shipped') });
    expect(ship.status).toBe(409);
  });

  it('A/B/C: a listing in another currency, of another shop, or priced 0.00 does not price the order', async () => {
    const cases: Array<[string, any]> = [
      ['currency HUF', { price: '5.00', currency: 'HUF', unitRef: REF() }],
      ['another shop', { price: '5.00', currency: 'EUR', unitRef: `30901:${owner.pk}:${'f'.repeat(32)}` }],
      ['no shop', { price: '5.00', currency: 'EUR' }],
      ['price 0.00', { price: '0.00', currency: 'EUR', unitRef: REF() }],
    ];
    for (const [why, l] of cases) {
      const p = await paidApples();
      const odd: ListingFetcher = async (a: string) => a === PEARS
        ? { status: 'active', createdAt: now() - 86_400, ...l }
        : (await fetcher()(a));
      const r = await replaceWith(p, [['item', PEARS, '10', 'kg', l.price === '0.00' ? '0.00' : '1.00', 'EUR']], l.price === '0.00' ? '2.50' : '12.50', odd);
      expect(r.payment_state, why).toBe('amount_mismatch');
      expect(r.pending, why).toBe(0);
      expect(r.expected_total, why).toBe('');
    }
  });

  it('E: pickup at a shop that does not offer it is not computable', async () => {
    const raw = JSON.parse(unitRow(db, UNIT)!.raw_event!);
    expect(unitToResolver(unitRow(db, UNIT)!).pickup).toBe(true);
    db.prepare('UPDATE business_units SET raw_event = ? WHERE unit_id = ?')
      .run(JSON.stringify({ ...raw, tags: raw.tags.filter((t: string[]) => t[0] !== 'online_shop_pickup') }), UNIT);
    try {
      expect(unitToResolver(unitRow(db, UNIT)!).pickup).toBe(false);
      const p = await paidApples();
      // E2 switches to pickup and turns the 2.50 shipping fee into goods: 10 × pears at 1.25 = the same 12.50
      LISTED[PEARS] = '1.25';
      const r = await replaceWith(p, [['item', PEARS, '10', 'kg', '1.25', 'EUR']], '12.50', fetcher(), { shipping: '0.00', fulfillment: 'pickup' });
      expect(r).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '' });
    } finally {
      LISTED[PEARS] = '50.00';
      db.prepare('UPDATE business_units SET raw_event = ? WHERE unit_id = ?').run(JSON.stringify(raw), UNIT);
    }
  });

  it('an honest order whose listing is deleted after it was judged once is still paid — also after a restart', async () => {
    const buyer = mk();
    const d = orderIdFor(buyer.pk);
    const t0 = now() - 120;
    expect(ingestEvent(db, orderEvent(buyer, d, [['item', APPLES, '2', 'kg', '5.00', 'EUR']], '12.50', t0), trusted)).toBe(d);
    await resolveOrders(db, { orderIds: [d], trusted, fetchListing: fetcher(), now: now() });
    expect(row(d)).toMatchObject({ payment_state: 'unpaid', expected_total: '12.50' });
    // the merchant deletes the product while the buyer is paying; the app restarts (no cache)
    clearListingCache();
    expect(ingestEvent(db, purchaseEvent(d, buyer.pk, crypto.randomUUID()), trusted)).toBe(d);
    await resolveOrders(db, { orderIds: [d], trusted, fetchListing: fetcher([APPLES]), now: now() });
    expect(row(d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50' });
    expect(row(d).paid_order_event_id).toBe(row(d).event_id);
  });

  it('…but a replacement naming a listing it was never judged with has no price: not paid', async () => {
    const p = await paidApples();
    // E2 names pears, whose REQ fails from the start: no price was ever seen for THIS event
    const r = await replaceWith(p, [['item', PEARS, '10', 'kg', '1.00', 'EUR']], '12.50', fetcher([PEARS]));
    expect(r).toMatchObject({ payment_state: 'amount_mismatch', expected_total: '' });
    // E1's apples price is E1's memory, never E2's
    expect((db.prepare('SELECT COUNT(*) AS n FROM shop_order_listing_prices WHERE order_event_id = ?').get(r.event_id) as any).n).toBe(0);
  });

  it('the brain re-signs the same purchase (publish retry) after a reprice: the order stays paid', async () => {
    const p = await paidApples();
    LISTED[APPLES] = '6.00';
    try {
      clearListingCache();
      // newer copy of the same 30933 (same d = tx id, same amount), signed 60 s later
      expect(ingestEvent(db, purchaseEvent(p.d, p.buyer.pk, p.txId, '12.50', now()), trusted)).toBe(p.d);
      await resolveOrders(db, { orderIds: [p.d], trusted, fetchListing: fetcher(), now: now() });
      expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50' });
    } finally {
      LISTED[APPLES] = '5.00';
    }
  });

  it('a cancellation signed in the same second as the payment is stored, whichever id is lower (probe-tie)', async () => {
    for (const lower of [true, false]) {
      const p = await paidApples();
      const stored = db.prepare('SELECT created_at, event_id FROM shop_order_payments WHERE tx_id = ?').get(p.txId) as any;
      let cancel: any = null;
      for (let i = 0; i < 4096; i++) { // a stored id near 0 or f…: 64 tries missed ~1 run in 65
        const c = sign(brain.sk, 30933, [
          ['d', p.txId], ['p', 'f'.repeat(64)], ['unit_id', UNIT], ['payment_type', 'lana'], ['customer_hex', 'f'.repeat(64)],
          ['merchant_hex', owner.pk], ['amount', '12.50'], ['currency', 'EUR'], ['status', 'cancelled'], ['cancel_reason', `r${i}`],
          ['invoice_number', p.d],
        ], '', stored.created_at);
        if ((c.id < stored.event_id) === lower) { cancel = c; break; }
      }
      expect(cancel).not.toBeNull();
      expect(ingestEvent(db, cancel, trusted)).toBe(p.d);
      await resolveOrders(db, { orderIds: [p.d], trusted, fetchListing: fetcher(), now: now() });
      expect(row(p.d), `cancel id lower: ${lower}`).toMatchObject({ payment_state: 'unpaid', pending: 0 });
      // the processing copy coming back changes nothing
      const proc = db.prepare('SELECT raw_event FROM shop_order_payments WHERE tx_id = ?').get(p.txId) as any;
      expect(JSON.parse(proc.raw_event).id).toBe(cancel.id);
    }
  });

  it('the listing fetcher never returns a deleted listing\'s old price (probe-stale)', async () => {
    const lst = sign(owner.sk, 36502, [['d', 'stale'], ['a', REF()], ['title', 'Hruske'], ['price', '1.00', 'EUR'], ['unit', 'kg'], ['status', 'active']], '', now() - 3600);
    relayEvents = [lst];
    const f = makeListingFetcher([relayUrl], 2000);
    const a = `36502:${owner.pk}:stale`;
    expect((await f(a))?.price).toBe('1.00');
    expect((await f(a))?.unitRef).toBe(REF());
    relayEvents = []; // the merchant deleted it: the relay answers EOSE with no event
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 11 * 60 * 1000; // past the 10-min cache
      expect(await f(a)).toBeNull();
      Date.now = () => realNow() + 3 * 86_400 * 1000;
      expect(await f(a)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

/**
 * Third review of 2 Oct 2026. A 'paid' the OLDER rules stored is never
 * carried into the step-5a pin: before v1.1.1 a line whose listing was not
 * found was priced at the BUYER's own unit_price, so a buyer's replacement
 * naming an unknown listing was 'paid' (and, with fbb2c3d, pinned through
 * paid_order_event_id). Every such row is judged again by step 5 — shipped
 * or not — and the ones it does not pay are listed for Brilly.
 */
describe('third review — an older \'paid\' is judged again, never pinned', () => {
  const REF = `30901:${owner.pk}:${UNIT}`;
  const GOLD = `36502:${owner.pk}:gold`;
  /** The listing as a relay returns it, with the display fields (so the app keeps a snapshot). */
  const listed = (prices: Record<string, string>, createdAt: number, down: string[] = []): ListingFetcher => async (a: string) =>
    prices[a] && !down.includes(a)
      ? { price: prices[a], currency: 'EUR', status: 'active', createdAt, unitRef: REF, eventId: crypto.createHash('sha256').update(a + prices[a] + createdAt).digest('hex'), title: 'Jabolka', unit: 'kg' }
      : null;
  /** What the older code left in the row (probe x1/p1m "old 2"): paid and pending, maybe pinned the old way. */
  function asOlderRulesLeftIt(d: string, o: { oldPin?: boolean; pending?: 0 | 1 } = {}) {
    const pay = db.prepare('SELECT * FROM shop_order_payments WHERE invoice_number = ?').get(d) as any;
    db.prepare(`
      UPDATE shop_orders SET payment_state = 'paid', expected_total = ?, effective_status = 'paid', pending = ?,
        paid_signer_hex = ?, paid_tx_id = ?, paid_event_id = ?, paid_amount = ?, paid_at = ?,
        paid_order_event_id = ${o.oldPin === false ? 'NULL' : 'event_id'}, resolved_at = ?
      WHERE order_id = ?
    `).run(pay.amount, o.pending ?? 1, pay.pubkey, pay.tx_id, pay.event_id, pay.amount, pay.created_at, now(), d);
  }
  /** …and before this code ran at all: no v1.1.2 pin, no price memory. */
  function fromBeforeThisCode(d: string) {
    db.prepare('UPDATE shop_orders SET settled_order_event_id = NULL WHERE order_id = ?').run(d);
    db.prepare('DELETE FROM shop_order_listing_prices').run();
  }
  const review = (d: string) => db.prepare('SELECT verdict, expected_total, old_paid_amount, cleared_at FROM shop_order_settle_review WHERE order_id = ?').get(d) as any;

  it('brain key rotation: the NEW trusted key\'s cancel of the same tx id un-pays what the OLD key paid (p2)', async () => {
    const p = await paidApples();
    const newBrain = mk();
    const both = new Set([brain.pk, newBrain.pk]);
    const cancel = sign(newBrain.sk, 30933, [
      ['d', p.txId], ['p', 'f'.repeat(64)], ['unit_id', UNIT], ['payment_type', 'lana'], ['customer_hex', 'f'.repeat(64)],
      ['merchant_hex', owner.pk], ['amount', '12.50'], ['currency', 'EUR'], ['status', 'cancelled'], ['invoice_number', p.d],
    ], '', now() - 10);
    expect(ingestEvent(db, cancel, both)).toBe(p.d);
    expect((db.prepare('SELECT COUNT(*) AS n FROM shop_order_payments WHERE tx_id = ?').get(p.txId) as any).n).toBe(2);
    await resolveOrders(db, { orderIds: [p.d], trusted: both, fetchListing: fetcher(), now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'unpaid', pending: 0, settled_order_event_id: null });
  });

  it('the replacement that named an unknown listing at the buyer\'s price is not paid after deploy, also when the real listing lands (x1/p1m)', async () => {
    const p = await paidApples();
    const e2 = orderEvent(p.buyer, p.d, [['item', GOLD, '2', 'kg', '5.00', 'EUR']], '12.50', p.t0 + 5);
    expect(ingestEvent(db, e2, trusted)).toBe(p.d);
    await resolveOrders(db, { orderIds: [p.d], trusted, fetchListing: fetcher(), now: now() });
    expect(row(p.d).payment_state).toBe('amount_mismatch');
    // the older rules priced gold at the buyer's 5.00: paid, pending and pinned to E2 (old 2)
    asOlderRulesLeftIt(p.d);
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, paid_order_event_id: e2.id });
    expect(activeOrderIds(db)).toContain(p.d);
    // until the next sync has judged it, the merchant cannot ship it either
    const early = await post(`/api/orders/${p.d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(row(p.d), 'shipped') });
    expect(early.status).toBe(409);
    expect(early.json).toMatchObject({ error: 'NOT_PAID', paymentState: 'not_judged_yet' });
    await resolveOrders(db, { trusted, fetchListing: fetcher(), now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '' });
    expect(review(p.d)).toMatchObject({ verdict: 'amount_mismatch', old_paid_amount: '12.50', cleared_at: null });
    // the merchant's real gold at 500.00 (new 4 / control 4)
    const gold: ListingFetcher = async (a: string) => a === GOLD
      ? { price: '500.00', currency: 'EUR', status: 'active', createdAt: now() - 60, unitRef: REF }
      : fetcher()(a);
    await resolveOrders(db, { trusted, fetchListing: gold, now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '1002.50', settled_order_event_id: null });
    const ship = await post(`/api/orders/${p.d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(row(p.d), 'shipped') });
    expect(ship.status).toBe(409);
  });

  it('an honest older \'paid\' with no pin, repriced since: paid by step 5 at the price live when it was ordered, then pinned', async () => {
    const t0 = now() - 120;
    const p = await placeApples(listed({ [APPLES]: '5.00' }, t0 - 86_400));
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1 });
    asOlderRulesLeftIt(p.d, { oldPin: false }); // before fbb2c3d: no paid_order_event_id either
    fromBeforeThisCode(p.d);
    // the merchant has raised apples to 6.00 since
    clearListingCache();
    const now6 = listed({ [APPLES]: '6.00' }, now() - 60);
    await resolveOrders(db, { trusted, fetchListing: now6, now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50' });
    expect(row(p.d).settled_order_event_id).toBe(row(p.d).event_id);
    expect(review(p.d)).toBeUndefined();
    // from now on the pin holds it, judged on today's 6.00
    await resolveOrders(db, { orderIds: [p.d], trusted, fetchListing: now6, now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50' });
  });

  it('a shipped (not pending) older \'paid\' is judged once at deploy too, so a later touch cannot flip it', async () => {
    const t0 = now() - 120;
    const p = await placeApples(listed({ [APPLES]: '5.00' }, t0 - 86_400));
    asOlderRulesLeftIt(p.d, { oldPin: false, pending: 0 });
    fromBeforeThisCode(p.d);
    db.prepare(`UPDATE shop_orders SET fulfillment_status = 'shipped', effective_status = 'shipped' WHERE order_id = ?`).run(p.d);
    db.prepare(`INSERT INTO shop_order_fulfillments (order_id, event_id, pubkey, created_at, status, raw_event, published) VALUES (?, ?, ?, ?, 'shipped', '{}', 1)`)
      .run(p.d, 'f'.repeat(64), owner.pk, t0 + 600);
    clearListingCache();
    const now6 = listed({ [APPLES]: '6.00' }, now() - 60);
    expect(activeOrderIds(db)).toContain(p.d);
    await resolveOrders(db, { trusted, fetchListing: now6, now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 0, effective_status: 'shipped' });
    expect(row(p.d).settled_order_event_id).toBe(row(p.d).event_id);
    expect(activeOrderIds(db)).not.toContain(p.d);
    // e.g. a delivery event touches it later: still paid on the pin
    await resolveOrders(db, { orderIds: [p.d], trusted, fetchListing: now6, now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', expected_total: '12.50' });
  });

  it('an older \'paid\' step 5 cannot price at deploy (listing REQ failed) is listed, not paid — and cleared once the listing answers', async () => {
    const p = await placeApples(listed({ [APPLES]: '5.00' }, now() - 86_400));
    asOlderRulesLeftIt(p.d);
    fromBeforeThisCode(p.d);
    db.prepare('DELETE FROM shop_order_item_snapshots').run();
    clearListingCache();
    await resolveOrders(db, { trusted, fetchListing: listed({ [APPLES]: '5.00' }, now() - 86_400, [APPLES]), now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '' });
    expect(review(p.d)).toMatchObject({ verdict: 'amount_mismatch', old_paid_amount: '12.50', cleared_at: null });
    expect(activeOrderIds(db)).toContain(p.d);
    await resolveOrders(db, { trusted, fetchListing: listed({ [APPLES]: '5.00' }, now() - 86_400), now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50' });
    expect(row(p.d).settled_order_event_id).toBe(row(p.d).event_id);
    expect(review(p.d).cleared_at).toBeGreaterThan(0);
  });

  it('a snapshot prices an older \'paid\' only when it was live at order time, in the shop\'s currency, while the listing still names this shop', async () => {
    const t0 = now() - 120;
    // the snapshot is a version published AFTER the order: not the price the broker checked
    const p = await placeApples(listed({ [APPLES]: '5.00' }, t0 + 30));
    asOlderRulesLeftIt(p.d);
    fromBeforeThisCode(p.d);
    clearListingCache();
    await resolveOrders(db, { trusted, fetchListing: listed({ [APPLES]: '6.00' }, now() - 60), now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', expected_total: '14.50' });
    // a live snapshot, but the listing at that address now names ANOTHER shop
    const q = await placeApples(listed({ [APPLES]: '5.00' }, t0 - 86_400));
    asOlderRulesLeftIt(q.d);
    fromBeforeThisCode(q.d);
    clearListingCache();
    const moved: ListingFetcher = async () => ({ price: '6.00', currency: 'EUR', status: 'active', createdAt: now() - 60, unitRef: `30901:${owner.pk}:${'f'.repeat(32)}` });
    await resolveOrders(db, { orderIds: [q.d], trusted, fetchListing: moved, now: now() });
    expect(row(q.d)).toMatchObject({ payment_state: 'amount_mismatch', expected_total: '' });
    expect(orderTimeSnapshotPrice({ price: '5.00', currency: 'EUR', listing_created_at: 100, source: 'listing' }, 100, 'EUR')).toEqual({ price: '5.00', createdAt: 100 });
    expect(orderTimeSnapshotPrice({ price: '5.00', currency: 'EUR', listing_created_at: 101, source: 'listing' }, 100, 'EUR')).toBeNull();
    expect(orderTimeSnapshotPrice({ price: '5.00', currency: 'EUR', listing_created_at: 90, source: 'receipt' }, 100, 'EUR')).toBeNull();
    expect(orderTimeSnapshotPrice({ price: '5.00', currency: 'HUF', listing_created_at: 90, source: 'listing' }, 100, 'EUR')).toBeNull();
    expect(orderTimeSnapshotPrice({ price: '0.00', currency: 'EUR', listing_created_at: 90, source: 'listing' }, 100, 'EUR')).toBeNull();
    expect(orderTimeSnapshotPrice(undefined, 100, 'EUR')).toBeNull();
  });
});
