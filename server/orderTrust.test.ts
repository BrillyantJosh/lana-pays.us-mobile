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
  ingestEvent, resolveOrders, activeOrderIds, syncShopOrders, parseOrderEvent, makeListingFetcher,
  unitToResolver, unitRow, confirmSettleReview, listSettleReview, listingDeletedBy, type ListingFetcher,
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

// ── loopback relay stub: honours kinds, authors and #<tag> (every filter of a REQ); records every filter ──
let relayEvents: any[] = [];
const reqs: any[] = [];
let relay: WebSocketServer;
let relayUrl = '';
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
          const [, sub, ...filters] = m;
          reqs.push(...filters);
          for (const ev of relayEvents) if (filters.some((f: any) => matches(ev, f))) socket.send(JSON.stringify(['EVENT', sub, ev]));
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
  // the unit's KIND 30901 as the heartbeat stores it: signed by the owner (orderSync moneyUnit verifies it)
  const unitEv = sign(owner.sk, 30901, [['d', UNIT], ['unit_id', UNIT], ['online_shop', 'true'], ['online_shop_shipping_fee', '2.50'], ['online_shop_pickup', 'true']], '', now() - 86_400);
  db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', 'active', ?)
  `).run(UNIT, unitEv.id, owner.pk, unitEv.created_at, 'Trgovina', owner.pk, JSON.stringify([owner.pk]), JSON.stringify(unitEv));

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
    // the merchant republishes the unit without pickup (signed: orderSync moneyUnit verifies the stored 30901)
    db.prepare('UPDATE business_units SET raw_event = ? WHERE unit_id = ?')
      .run(JSON.stringify(sign(owner.sk, 30901, raw.tags.filter((t: string[]) => t[0] !== 'online_shop_pickup'), '', raw.created_at + 1)), UNIT);
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
    // The next tick makes a new fetcher (round 5, F2: a fetcher's cache lives
    // one tick): nothing the last tick read carries over.
    expect(await makeListingFetcher([relayUrl], 2000)(a)).toBeNull();
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

  it('an honest older \'paid\' with no pin, repriced since: listed, not paid — paid and pinned again once Brilly confirms exactly that event (round 3)', async () => {
    const t0 = now() - 120;
    const p = await placeApples(listed({ [APPLES]: '5.00' }, t0 - 86_400));
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1 });
    asOlderRulesLeftIt(p.d, { oldPin: false }); // before fbb2c3d: no paid_order_event_id either
    fromBeforeThisCode(p.d);
    // the order-time snapshot says 5.00 — display only, it records no sale status (x3/m1)
    expect(db.prepare("SELECT price FROM shop_order_item_snapshots WHERE order_id = ? AND source = 'listing'").get(p.d)).toEqual({ price: '5.00' });
    // the merchant has raised apples to 6.00 since
    const now6 = listed({ [APPLES]: '6.00' }, now() - 60);
    await resolveOrders(db, { trusted, fetchListing: now6, now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '14.50', settled_order_event_id: null });
    expect(review(p.d)).toMatchObject({ verdict: 'amount_mismatch', old_paid_amount: '12.50', cleared_at: null });
    expect(listSettleReview(db).map(e => ({ id: e.order_id, ev: e.order_event_id, now: e.current_event_id, tx: e.old_paid_tx_id })))
      .toEqual([{ id: p.d, ev: row(p.d).event_id, now: row(p.d).event_id, tx: p.txId }]);
    // Brilly checked it against what the broker took at order time and confirms THIS event
    expect(await confirmSettleReview(db, p.d, row(p.d).event_id, { trusted, now: now() })).toEqual({ ok: true, paymentState: 'paid', expected: '12.50' });
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50', paid_tx_id: p.txId });
    expect(row(p.d).settled_order_event_id).toBe(row(p.d).event_id);
    expect(review(p.d).cleared_at).toBeGreaterThan(0);
    expect((db.prepare('SELECT confirmed_at FROM shop_order_settle_review WHERE order_id = ?').get(p.d) as any).confirmed_at).toBeGreaterThan(0);
    expect(listSettleReview(db)).toEqual([]);
    // from now on the pin holds it, judged on today's 6.00
    await resolveOrders(db, { trusted, fetchListing: now6, now: now() + 60 });
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50' });
    const ship = await post(`/api/orders/${p.d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(row(p.d), 'shipped') });
    expect(ship.status).not.toBe(409);
  });

  it('a shipped (not pending) older \'paid\' is judged once at deploy too: listed, and a confirmation keeps it paid and shipped (round 3)', async () => {
    const t0 = now() - 120;
    const p = await placeApples(listed({ [APPLES]: '5.00' }, t0 - 86_400));
    asOlderRulesLeftIt(p.d, { oldPin: false, pending: 0 });
    fromBeforeThisCode(p.d);
    db.prepare(`UPDATE shop_orders SET fulfillment_status = 'shipped', effective_status = 'shipped' WHERE order_id = ?`).run(p.d);
    db.prepare(`INSERT INTO shop_order_fulfillments (order_id, event_id, pubkey, created_at, status, raw_event, published) VALUES (?, ?, ?, ?, 'shipped', '{}', 1)`)
      .run(p.d, 'f'.repeat(64), owner.pk, t0 + 600);
    const now6 = listed({ [APPLES]: '6.00' }, now() - 60);
    expect(activeOrderIds(db)).toContain(p.d);
    await resolveOrders(db, { trusted, fetchListing: now6, now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, effective_status: 'shipped', settled_order_event_id: null });
    expect(review(p.d)).toMatchObject({ verdict: 'amount_mismatch', old_paid_amount: '12.50', cleared_at: null });
    expect(await confirmSettleReview(db, p.d, row(p.d).event_id, { trusted, now: now() })).toMatchObject({ ok: true, expected: '12.50' });
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 0, effective_status: 'shipped' });
    expect(row(p.d).settled_order_event_id).toBe(row(p.d).event_id);
    expect(activeOrderIds(db)).not.toContain(p.d);
    // e.g. a delivery event touches it later: still paid on the pin
    await resolveOrders(db, { orderIds: [p.d], trusted, fetchListing: now6, now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', expected_total: '12.50' });
  });

  it('a confirmation pays only the event that was listed, and only while its old purchase still stands (round 3)', async () => {
    const t0 = now() - 120;
    const p = await placeApples(listed({ [APPLES]: '5.00' }, t0 - 86_400));
    asOlderRulesLeftIt(p.d, { oldPin: false });
    fromBeforeThisCode(p.d);
    // nothing listed yet: nothing to confirm, nothing written
    expect(await confirmSettleReview(db, p.d, row(p.d).event_id, { trusted, now: now() })).toEqual({ ok: false, reason: 'no_open_entry' });
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', settled_order_event_id: null });
    const now6 = listed({ [APPLES]: '6.00' }, now() - 60);
    await resolveOrders(db, { trusted, fetchListing: now6, now: now() });
    expect(review(p.d)).toMatchObject({ verdict: 'amount_mismatch', cleared_at: null });
    // another event id than the one stored (and checked): refused, nothing written
    expect(await confirmSettleReview(db, p.d, 'a'.repeat(64), { trusted, now: now() })).toEqual({ ok: false, reason: 'event_mismatch' });
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', settled_order_event_id: null });
    // the brain has cancelled that purchase since: a confirmation does not pay it
    expect(ingestEvent(db, cancelledPurchaseEvent(p.d, p.txId, now()), trusted)).toBe(p.d);
    expect(await confirmSettleReview(db, p.d, row(p.d).event_id, { trusted, now: now() })).toEqual({ ok: false, reason: 'not_paid', paymentState: 'unpaid' });
    expect(row(p.d)).toMatchObject({ payment_state: 'unpaid', pending: 0, settled_order_event_id: null });
    expect(review(p.d).cleared_at).toBeNull();
    expect((db.prepare('SELECT confirmed_at FROM shop_order_settle_review WHERE order_id = ?').get(p.d) as any).confirmed_at).toBeNull();
    const ship = await post(`/api/orders/${p.d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(row(p.d), 'shipped') });
    expect(ship.status).toBe(409);
  });

  it('an older \'paid\' step 5 cannot price at deploy (listing REQ failed) is listed, not paid — and cleared once the listing answers', async () => {
    const p = await placeApples(listed({ [APPLES]: '5.00' }, now() - 86_400));
    asOlderRulesLeftIt(p.d);
    fromBeforeThisCode(p.d);
    db.prepare('DELETE FROM shop_order_item_snapshots').run();
    await resolveOrders(db, { trusted, fetchListing: listed({ [APPLES]: '5.00' }, now() - 86_400, [APPLES]), now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '' });
    expect(review(p.d)).toMatchObject({ verdict: 'amount_mismatch', old_paid_amount: '12.50', cleared_at: null });
    expect(activeOrderIds(db)).toContain(p.d);
    await resolveOrders(db, { trusted, fetchListing: listed({ [APPLES]: '5.00' }, now() - 86_400), now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50' });
    expect(row(p.d).settled_order_event_id).toBe(row(p.d).event_id);
    expect(review(p.d).cleared_at).toBeGreaterThan(0);
  });

  it('the order-time snapshot is no money: live at order time, published after it, or with the listing moved to another shop — all listed, none paid (round 3)', async () => {
    const t0 = now() - 120;
    const moved: ListingFetcher = async () => ({ price: '6.00', currency: 'EUR', status: 'active', createdAt: now() - 60, unitRef: `30901:${owner.pk}:${'f'.repeat(32)}` });
    const cases: Array<[string, number, ListingFetcher, string]> = [
      ['live at order time, repriced since', t0 - 86_400, listed({ [APPLES]: '6.00' }, now() - 60), '14.50'],
      ['published after the order', t0 + 30, listed({ [APPLES]: '6.00' }, now() - 60), '14.50'],
      ['the address now names another shop', t0 - 86_400, moved, ''],
    ];
    for (const [label, snapAt, fetchNow, expected] of cases) {
      const p = await placeApples(listed({ [APPLES]: '5.00' }, snapAt));
      asOlderRulesLeftIt(p.d);
      fromBeforeThisCode(p.d);
      await resolveOrders(db, { orderIds: [p.d], trusted, fetchListing: fetchNow, now: now() });
      expect(row(p.d), label).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: expected, settled_order_event_id: null });
      expect(review(p.d), label).toMatchObject({ verdict: 'amount_mismatch', old_paid_amount: '12.50', cleared_at: null });
    }
  });

  it('an older \'paid\' whose first judgement found no listing is listed once; its listing answering repriced does not pay it (fourth review, mob-mig fail-first; round 3)', async () => {
    const t0 = now() - 120;
    const p = await placeApples(listed({ [APPLES]: '5.00' }, t0 - 86_400)); // the snapshot: live at order time
    asOlderRulesLeftIt(p.d, { oldPin: false });
    fromBeforeThisCode(p.d);
    // the first sync after deploy: the listing REQ fails
    const failing = listed({ [APPLES]: '6.00' }, now() - 60, [APPLES]);
    await resolveOrders(db, { trusted, fetchListing: failing, now: now() });
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '' });
    expect(review(p.d)).toMatchObject({ verdict: 'amount_mismatch', old_paid_amount: '12.50', cleared_at: null });
    const listedAt = (db.prepare('SELECT listed_at FROM shop_order_settle_review WHERE order_id = ?').get(p.d) as any).listed_at;
    // it fails again a tick later: still listed ONCE — listed_at and the old paid amount stay, so the 7-day window ends
    await resolveOrders(db, { trusted, fetchListing: failing, now: now() + 60 });
    const entry = () => db.prepare('SELECT listed_at, old_paid_amount, old_paid_tx_id, verdict, expected_total, cleared_at FROM shop_order_settle_review WHERE order_id = ?').get(p.d);
    expect(entry()).toEqual({ listed_at: listedAt, old_paid_amount: '12.50', old_paid_tx_id: p.txId, verdict: 'amount_mismatch', expected_total: '', cleared_at: null });
    expect(activeOrderIds(db, listedAt + 8 * 86_400)).not.toContain(p.d);
    // the listing answers, repriced to 6.00 since: judged at today's price — never at the snapshot's 5.00
    await resolveOrders(db, { trusted, fetchListing: listed({ [APPLES]: '6.00' }, now() - 60), now: now() + 120 });
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '14.50', settled_order_event_id: null });
    expect(entry()).toEqual({ listed_at: listedAt, old_paid_amount: '12.50', old_paid_tx_id: p.txId, verdict: 'amount_mismatch', expected_total: '14.50', cleared_at: null });
    // the old payment is kept on the entry, so Brilly can still confirm it
    expect(await confirmSettleReview(db, p.d, row(p.d).event_id, { trusted, now: now() + 180 })).toMatchObject({ ok: true, expected: '12.50' });
  });

  it('…but a buyer\'s replacement of a listed older \'paid\' is judged afresh, never at the old order\'s price', async () => {
    const t0 = now() - 120;
    const p = await placeApples(listed({ [APPLES]: '5.00' }, t0 - 86_400));
    asOlderRulesLeftIt(p.d, { oldPin: false });
    fromBeforeThisCode(p.d);
    await resolveOrders(db, { trusted, fetchListing: listed({ [APPLES]: '6.00' }, now() - 60, [APPLES]), now: now() });
    expect(review(p.d)).toMatchObject({ cleared_at: null });
    // E2: the same line, a new event — the snapshot of E1 must not price it
    expect(ingestEvent(db, orderEvent(p.buyer, p.d, [['item', APPLES, '2', 'kg', '5.00', 'EUR']], '12.50', p.t0 + 5), trusted)).toBe(p.d);
    await resolveOrders(db, { trusted, fetchListing: listed({ [APPLES]: '6.00' }, now() - 60), now: now() + 60 });
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '14.50' });
    // the entry Brilly could confirm was E1's: E2 is another order, refused (round 3)
    expect(await confirmSettleReview(db, p.d, row(p.d).event_id, { trusted, now: now() + 120 })).toEqual({ ok: false, reason: 'order_replaced' });
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', settled_order_event_id: null });
  });
});

/**
 * Fourth review of 2 Oct 2026. A shop keeps old, merchant-signed listings it
 * has taken off sale (x2/p2); the order route refuses them, so an order that
 * names one is the buyer's own replacement. And a qty the portal and the
 * broker refuse is not mirrored here either (x2/p4), so the two mirrors never
 * show different "paid" orders for one order id.
 */
describe('fourth review — only a listing on sale prices an order; one qty shape for every mirror', () => {
  const REF = `30901:${owner.pk}:${UNIT}`;
  const HONEY = `36502:${owner.pk}:honey-2026`;
  const OLD = `36502:${owner.pk}:honey-2024`;
  const shop = (status: string): ListingFetcher => async (a: string) =>
    a === HONEY ? { price: '50.00', currency: 'EUR', status: 'active', createdAt: now() - 86_400, unitRef: REF }
      : a === OLD ? { price: '5.00', currency: 'EUR', status, createdAt: now() - 90_000, unitRef: REF }
        : null;

  it('a replacement naming the shop\'s off-sale cheaper listing is not paid, pending or fulfillable (inactive, sold_out, deleted, draft)', async () => {
    for (const status of ['inactive', 'sold_out', 'deleted', 'draft', 'published']) {
      const buyer = mk();
      const d = orderIdFor(buyer.pk);
      const t0 = now() - 120;
      expect(ingestEvent(db, orderEvent(buyer, d, [['item', HONEY, '1', 'kg', '50.00', 'EUR']], '52.50', t0), trusted)).toBe(d);
      expect(ingestEvent(db, purchaseEvent(d, buyer.pk, crypto.randomUUID(), '52.50'), trusted)).toBe(d);
      await resolveOrders(db, { orderIds: [d], trusted, fetchListing: shop(status), now: now() });
      expect(row(d), status).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '52.50' });
      expect(ingestEvent(db, orderEvent(buyer, d, [['item', OLD, '10', 'kg', '5.00', 'EUR']], '52.50', t0 + 5), trusted)).toBe(d);
      await resolveOrders(db, { orderIds: [d], trusted, fetchListing: shop(status), now: now() });
      expect(row(d), status).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '', settled_order_event_id: null });
      const ship = await post(`/api/orders/${d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(row(d), 'shipped') });
      expect(ship.status, status).toBe(409);
    }
  });

  it('the listing fetcher reads the sale status the order route reads (KIND 31923: lana-status, absent = published)', async () => {
    relayEvents = [
      sign(owner.sk, 31923, [['d', 'ev1'], ['a', REF], ['title', 'Delavnica'], ['t', 'lana-event'], ['price', '5.00', 'EUR']], '', now() - 100),
      sign(owner.sk, 31923, [['d', 'ev2'], ['a', REF], ['title', 'Delavnica'], ['price', '5.00', 'EUR'], ['lana-status', 'active']], '', now() - 100),
      sign(owner.sk, 31923, [['d', 'ev3'], ['a', REF], ['title', 'Delavnica'], ['price', '5.00', 'EUR'], ['status', 'active'], ['lana-status', 'draft']], '', now() - 100),
      sign(owner.sk, 36502, [['d', 'off'], ['a', REF], ['title', 'Med'], ['price', '5.00', 'EUR'], ['status', 'inactive']], '', now() - 100),
      sign(owner.sk, 36502, [['d', 'bare'], ['a', REF], ['title', 'Med'], ['price', '5.00', 'EUR']], '', now() - 100),
    ];
    const f = makeListingFetcher([relayUrl], 2000);
    expect((await f(`31923:${owner.pk}:ev1`))?.status).toBe('published');
    expect((await f(`31923:${owner.pk}:ev2`))?.status).toBe('active');
    expect((await f(`31923:${owner.pk}:ev3`))?.status).toBe('draft');
    expect((await f(`36502:${owner.pk}:off`))?.status).toBe('inactive');
    expect((await f(`36502:${owner.pk}:bare`))?.status).toBe('active');
  });

  it('a qty the portal and the broker refuse (1e1, 0x0a, " 10", 10.0, …) is not mirrored: the paid order stays as it was (x2/p4)', async () => {
    const b = mk();
    const d = orderIdFor(b.pk);
    for (const q of ['1e1', '0x0a', ' 10', '10 ', '10.0', '+10', '010', '0', '-1', '1234567890', '']) {
      expect(parseOrderEvent(orderEvent(b, d, [['item', APPLES, q, 'kg', '5.00', 'EUR']], '52.50', now() - 60)), JSON.stringify(q)).toBeNull();
    }
    for (const q of ['1', '10', '123456789']) {
      expect(parseOrderEvent(orderEvent(b, d, [['item', APPLES, q, 'kg', '5.00', 'EUR']], '52.50', now() - 60))?.items[0].qty, q).toBe(Number(q));
    }
    const p = await paidApples();
    const e1 = row(p.d).event_id;
    expect(ingestEvent(db, orderEvent(p.buyer, p.d, [['item', APPLES, '1e1', 'kg', '5.00', 'EUR']], '52.50', p.t0 + 5), trusted)).toBeNull();
    await resolveOrders(db, { orderIds: [p.d], trusted, fetchListing: fetcher(), now: now() });
    expect(row(p.d)).toMatchObject({ event_id: e1, payment_state: 'paid', pending: 1, expected_total: '12.50' });
    expect(JSON.parse(row(p.d).items_json)[0].qty).toBe(2);
  });
});

/**
 * Round 3 of 2 Oct 2026 (x3/m1). An order-time snapshot in
 * shop_order_item_snapshots records a price but never the listing's sale
 * status, so it cannot tell an honest order from a buyer's replacement that
 * the OLDER rules paid with an off-sale listing at its old price. It is no
 * money input any more: an older 'paid' is judged by step 5 alone, exactly as
 * the portal judges it, and what step 5 does not pay is listed for Brilly.
 */
describe('round 3 — an older \'paid\' is judged by step 5 alone; the snapshot is no money input', () => {
  const REF = `30901:${owner.pk}:${UNIT}`;
  const HONEY = `36502:${owner.pk}:honey-2026`;
  const OLD = `36502:${owner.pk}:honey-2024`;
  const shop = (status: string): ListingFetcher => async (a: string) =>
    a === HONEY ? { price: '50.00', currency: 'EUR', status: 'active', createdAt: now() - 86_400, unitRef: REF }
      : a === OLD ? { price: '5.00', currency: 'EUR', status, createdAt: now() - 90_000, unitRef: REF }
        : null;
  const review = (d: string) => db.prepare('SELECT verdict, expected_total, old_paid_amount, old_paid_tx_id, cleared_at FROM shop_order_settle_review WHERE order_id = ?').get(d) as any;
  /** What origin/main left after judging the current 36520 'paid' (probe x3/m1 "OLD code after replacement"). */
  function asOriginMainLeftIt(d: string, snapshots: Array<{ a: string; price: string; createdAt: number }>) {
    const pay = db.prepare('SELECT * FROM shop_order_payments WHERE invoice_number = ?').get(d) as any;
    db.prepare(`
      UPDATE shop_orders SET payment_state = 'paid', expected_total = ?, effective_status = 'paid', pending = 1,
        paid_signer_hex = ?, paid_tx_id = ?, paid_event_id = ?, paid_amount = ?, paid_at = ?,
        paid_order_event_id = event_id, settled_order_event_id = NULL, resolved_at = ?
      WHERE order_id = ?
    `).run(pay.amount, pay.pubkey, pay.tx_id, pay.event_id, pay.amount, pay.created_at, now(), d);
    db.prepare('DELETE FROM shop_order_item_snapshots WHERE order_id = ?').run(d);
    for (const s of snapshots) {
      db.prepare(`
        INSERT INTO shop_order_item_snapshots (order_id, item_a, listing_event_id, listing_created_at, title, price, currency, source, fetched_at)
        VALUES (?, ?, ?, ?, 'Med', ?, 'EUR', 'listing', ?)
      `).run(d, s.a, crypto.randomBytes(32).toString('hex'), s.createdAt, s.price, now());
    }
    db.prepare('DELETE FROM shop_order_listing_prices').run();
  }

  it('a replacement the older rules paid with an off-sale listing (inactive, sold_out, deleted) is not paid, not pinned, listed and not fulfillable (x3/m1)', async () => {
    for (const status of ['inactive', 'sold_out', 'deleted']) {
      const buyer = mk();
      const d = orderIdFor(buyer.pk);
      const t0 = now() - 120;
      expect(ingestEvent(db, orderEvent(buyer, d, [['item', HONEY, '1', 'kg', '50.00', 'EUR']], '52.50', t0), trusted)).toBe(d);
      expect(ingestEvent(db, purchaseEvent(d, buyer.pk, crypto.randomUUID(), '52.50'), trusted)).toBe(d);
      // the buyer's replacement: 10 × honey-2024 at its old 5.00 (live at order time, off sale)
      expect(ingestEvent(db, orderEvent(buyer, d, [['item', OLD, '10', 'kg', '5.00', 'EUR']], '52.50', t0 + 5), trusted)).toBe(d);
      asOriginMainLeftIt(d, [{ a: HONEY, price: '50.00', createdAt: now() - 86_400 }, { a: OLD, price: '5.00', createdAt: now() - 90_000 }]);
      expect(activeOrderIds(db), status).toContain(d);
      for (const tick of [0, 60]) {
        await resolveOrders(db, { trusted, fetchListing: shop(status), now: now() + tick });
        expect(row(d), `${status} tick ${tick}`).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '', settled_order_event_id: null });
        expect(review(d), `${status} tick ${tick}`).toMatchObject({ verdict: 'amount_mismatch', old_paid_amount: '52.50', cleared_at: null });
      }
      const ship = await post(`/api/orders/${d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(row(d), 'shipped') });
      expect(ship.status, status).toBe(409);
    }
  });
});

/**
 * Round 3 of 2 Oct 2026 (x3/m3). A listing its merchant deleted with a NIP-09
 * KIND 5 is gone for the portal (tombstone) and the broker (listing_deletions)
 * — the order route refuses it, so an order naming it is the buyer's own
 * replacement. A relay may still serve the listing beside the KIND 5 (it does
 * not apply deletions, or someone re-broadcast it); this app must not take it
 * as a live price either. Real fetcher, loopback relay.
 */
describe('round 3 — a listing its merchant deleted (KIND 5) prices nothing, also while a relay still serves it', () => {
  const REF = `30901:${owner.pk}:${UNIT}`;
  const HONEY = `36502:${owner.pk}:honey-2026`;
  const OLD = `36502:${owner.pk}:honey-2024`;
  const honey = () => sign(owner.sk, 36502, [['d', 'honey-2026'], ['a', REF], ['title', 'Med'], ['price', '50.00', 'EUR'], ['unit', 'kg'], ['status', 'active']], '', now() - 86_400);
  const old = (createdAt = now() - 90_000) => sign(owner.sk, 36502, [['d', 'honey-2024'], ['a', REF], ['title', 'Med'], ['price', '5.00', 'EUR'], ['unit', 'kg'], ['status', 'active']], '', createdAt);

  it('a replacement naming a KIND-5-deleted listing the relay still serves is not paid, not pinned, not fulfillable (x3/m3)', async () => {
    const buyer = mk();
    const d = orderIdFor(buyer.pk);
    const t0 = now() - 120;
    const oldEv = old();
    relayEvents = [honey(), oldEv, sign(owner.sk, 5, [['a', OLD], ['k', '36502']], 'deleted', now() - 80_000)];
    const f = makeListingFetcher([relayUrl], 2000);
    expect(ingestEvent(db, orderEvent(buyer, d, [['item', HONEY, '1', 'kg', '50.00', 'EUR']], '52.50', t0), trusted)).toBe(d);
    expect(ingestEvent(db, purchaseEvent(d, buyer.pk, crypto.randomUUID(), '52.50'), trusted)).toBe(d);
    await resolveOrders(db, { orderIds: [d], trusted, fetchListing: f, now: now() });
    expect(row(d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '52.50' });
    // the buyer's replacement: 10 × the deleted honey-2024 at its last price
    expect(ingestEvent(db, orderEvent(buyer, d, [['item', OLD, '10', 'kg', '5.00', 'EUR']], '52.50', t0 + 5), trusted)).toBe(d);
    await resolveOrders(db, { orderIds: [d], trusted, fetchListing: f, now: now() });
    expect(row(d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '', settled_order_event_id: null });
    const ship = await post(`/api/orders/${d}/fulfillment`, { hex: owner.pk, event: fulfillmentEvent(row(d), 'shipped') });
    expect(ship.status).toBe(409);
    // the deletion was read for that listing, by its author and address
    expect(reqs.some(r => Array.isArray(r.kinds) && r.kinds.includes(5) && JSON.stringify(r['#a']) === JSON.stringify([OLD]) && JSON.stringify(r.authors) === JSON.stringify([owner.pk]))).toBe(true);
  });

  it('the fetcher follows NIP-09 as the broker reads it: own author only, `e` = this version, `a` up to its created_at; an unread deletion is not "none"', async () => {
    const stranger = mk();
    const oldEv = old();
    const f = () => makeListingFetcher([relayUrl], 2000);
    // a stranger's KIND 5 deletes nothing
    relayEvents = [oldEv, sign(stranger.sk, 5, [['a', OLD], ['e', oldEv.id]], '', now() - 100)];
    expect((await f()(OLD))?.price).toBe('5.00');
    // the author's KIND 5 by event id
    relayEvents = [oldEv, sign(owner.sk, 5, [['e', oldEv.id]], '', now() - 100)];
    expect(await f()(OLD)).toBeNull();
    // the author's KIND 5 by address, signed after this version
    relayEvents = [oldEv, sign(owner.sk, 5, [['a', OLD]], '', oldEv.created_at)];
    expect(await f()(OLD)).toBeNull();
    // …a version re-published after that deletion is live again
    const again = old(now() - 50);
    relayEvents = [again, sign(owner.sk, 5, [['a', OLD]], '', now() - 100)];
    expect((await f()(OLD))?.eventId).toBe(again.id);
    // a forged KIND 5 (bad signature) deletes nothing
    // (a JSON copy, as a relay delivers it: nostr-tools caches "verified" on the signed object, and a spread keeps it)
    const forged = { ...JSON.parse(JSON.stringify(sign(owner.sk, 5, [['a', OLD]], '', now() - 10))), sig: 'f'.repeat(128) };
    relayEvents = [again, forged];
    expect((await f()(OLD))?.price).toBe('5.00');
    expect(listingDeletedBy({ id: again.id, pubkey: owner.pk, kind: 36502, d: 'honey-2024', created_at: again.created_at }, [forged as any])).toBe(false);
    // the deletion read does not finish (a relay that never ends it with EOSE): no price
    const silent = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(r => silent.once('listening', r));
    silent.on('connection', (socket) => {
      socket.on('message', (raw: Buffer) => {
        const m = JSON.parse(raw.toString());
        if (m[0] !== 'REQ') return;
        const [, sub, ...filters] = m;
        if (filters.some((x: any) => Array.isArray(x.kinds) && x.kinds.includes(5))) return; // no answer to the deletion read
        socket.send(JSON.stringify(['EVENT', sub, again]));
        socket.send(JSON.stringify(['EOSE', sub]));
      });
    });
    try {
      const url = `ws://127.0.0.1:${(silent.address() as AddressInfo).port}`;
      expect(await makeListingFetcher([url], 500)(OLD)).toBeNull();
    } finally {
      await new Promise<void>(r => silent.close(() => r()));
    }
  });
});
