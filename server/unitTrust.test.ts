// @vitest-environment node
/**
 * Round 5, M-1 (5 Oct 2026): which KIND 30901 this app believes about a shop.
 *
 * Until now the heartbeat took the newest 30901 per `d` from ANY author,
 * signature unchecked, and wrote it over business_units: the shipping fee
 * and pickup an order is judged by, the owner and staff who may act for the
 * unit here, the payout fields. lana-brain closed the same hole on 23 Jul 2026
 * (a0d7cdb); this pins the port:
 *
 *   - a stranger's 30901 for a shop (same d, shipping 0, pickup, himself as
 *     owner and his own `p` as staff — so author === owner_hex holds) changes
 *     nothing: not the money terms, not who may act, and its staff's 36521s
 *     are not stored;
 *   - a forged signature, a far-future created_at and a `d` that is not the
 *     unit id are dropped;
 *   - the merchant's real update in the same tick still lands (the pin is
 *     applied per candidate, before newest-wins);
 *   - an older 30901 never replaces a newer one;
 *   - the pin survives a restart, and log-only mode never moves it;
 *   - in log-only mode the order path still refuses a unit row that is not
 *     the order's shop (moneyUnit) — it skips the order, it does not judge it.
 *
 * Everything runs against a loopback relay stub; nothing leaves 127.0.0.1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Before any import reads it: a code path that falls back to the built-in
// relay list must find a dead loopback relay, never the production ones.
vi.hoisted(() => { process.env.LANA_RELAYS_OVERRIDE = 'ws://127.0.0.1:9'; });

import Database from 'better-sqlite3';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { initializeSchema } from './db/schema.js';
import * as heartbeat from './heartbeat.js';
import * as orderSync from './lib/orderSync.js';
import { unitForMerchant } from './lib/merchantAuth.js';
import { registerOrderRoutes } from './orders.js';
import { bindingString } from './lib/orderResolver.js';

const mk = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const owner = mk(), stranger = mk(), strangersStaff = mk(), brain = mk();
const UNIT = '7'.repeat(32);
const now = () => Math.floor(Date.now() / 1000);
const APPLES = `36502:${owner.pk}:apples`;

function sign(sk: Uint8Array, kind: number, tags: string[][], content = '', createdAt = now()) {
  return finalizeEvent({ kind, tags, content, created_at: createdAt }, sk) as any;
}

/** The merchant's own shop: shipping 2.50, no pickup. */
function honestUnit(createdAt: number, fee = '2.50', extra: string[][] = []) {
  return sign(owner.sk, 30901, [
    ['d', UNIT], ['unit_id', UNIT], ['name', 'Sadovnjak'], ['owner_hex', owner.pk], ['p', owner.pk],
    ['currency', 'EUR'], ['status', 'active'], ['online_shop', 'true'], ['online_shop_shipping_fee', fee], ...extra,
  ], '', createdAt);
}

/** A stranger's 30901 for the SAME shop: shipping 0, pickup on, himself owner (author === owner_hex), his own staff. */
function strangersUnit(createdAt: number, d = UNIT) {
  return sign(stranger.sk, 30901, [
    ['d', d], ['unit_id', UNIT], ['name', 'Sadovnjak'], ['owner_hex', stranger.pk], ['p', stranger.pk], ['p', strangersStaff.pk],
    ['currency', 'EUR'], ['status', 'active'], ['online_shop', 'true'], ['online_shop_shipping_fee', '0.00'], ['online_shop_pickup', 'true'],
    ['lanapays_payout_method', 'lana'], ['lanapays_payout_wallet', 'LstrangersWallet'],
  ], '', createdAt);
}

// ── loopback relay stub: honours kinds / authors / #d, answers EOSE ──
let relayEvents: any[] = [];
let relay: WebSocketServer;
let relayUrl = '';
function matches(ev: any, f: any): boolean {
  if (Array.isArray(f.kinds) && !f.kinds.includes(ev.kind)) return false;
  if (Array.isArray(f.authors) && !f.authors.includes(ev.pubkey)) return false;
  if (Array.isArray(f['#d']) && !f['#d'].includes(ev.tags?.find((t: string[]) => t[0] === 'd')?.[1])) return false;
  return true;
}

let db: Database.Database;
const trusted = new Set([brain.pk]);
const unit = () => db.prepare('SELECT * FROM business_units WHERE unit_id = ?').get(UNIT) as any;
const sync = (relays = [relayUrl]) => (heartbeat as any).syncBusinessUnits(db, relays) as Promise<number>;

beforeAll(async () => {
  relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(r => relay.once('listening', r));
  relay.on('connection', (socket) => {
    socket.on('message', (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m[0] !== 'REQ') return;
        const [, sub, ...filters] = m;
        for (const ev of relayEvents) if (filters.some((f: any) => matches(ev, f))) socket.send(JSON.stringify(['EVENT', sub, ev]));
        socket.send(JSON.stringify(['EOSE', sub]));
      } catch { /* ignore */ }
    });
  });
  relayUrl = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(r => relay.close(() => r()));
});

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
  relayEvents = [];
  delete process.env.KIND_30901_AUTHOR_PIN;
});

afterEach(() => {
  delete process.env.KIND_30901_AUTHOR_PIN;
  db.close();
});

// ── a paid order of this shop (2 × apples at 5.00 + 2.50 shipping) ──
const listing: orderSync.ListingFetcher = async (a: string) => a === APPLES
  ? { price: '5.00', currency: 'EUR', status: 'active', createdAt: now() - 86_400, unitRef: `30901:${owner.pk}:${UNIT}` }
  : null;

async function paidOrder() {
  const buyer = mk();
  const d = `${buyer.pk.slice(0, 24)}.${crypto.randomBytes(16).toString('hex')}`;
  const t0 = now() - 300;
  const txId = crypto.randomUUID();
  const order = sign(buyer.sk, 36520, [
    ['d', d], ['a', `30901:${owner.pk}:${UNIT}`], ['p', owner.pk], ['unit_id', UNIT], ['invoice_number', d],
    ['item', APPLES, '2', 'kg', '5.00', 'EUR'], ['shipping', '2.50', 'EUR'], ['total', '12.50', 'EUR'],
    ['fulfillment', 'shipping'], ['status', 'placed'], ['pay_by', String(t0 + 1800)], ['client', 'lanaeco.shop'], ['v', '1'],
  ], '', t0);
  const purchase = sign(brain.sk, 30933, [
    ['d', txId], ['p', 'f'.repeat(64)], ['unit_id', UNIT], ['payment_type', 'lana'], ['customer_hex', 'f'.repeat(64)],
    ['merchant_hex', owner.pk], ['amount', '12.50'], ['currency', 'EUR'], ['lana_amount', '9765432100'],
    ['status', 'processing'], ['invoice_number', d], ['receipt_description', `Jabolka ×2 · ${bindingString(buyer.pk, d)}`],
  ], '', t0 + 60);
  expect(orderSync.ingestEvent(db, order, trusted)).toBe(d);
  expect(orderSync.ingestEvent(db, purchase, trusted)).toBe(d);
  await orderSync.resolveOrders(db, { orderIds: [d], trusted, fetchListing: listing, now: now() });
  const row = db.prepare('SELECT * FROM shop_orders WHERE order_id = ?').get(d) as any;
  expect(row).toMatchObject({ payment_state: 'paid', pending: 1 });
  expect(row.settled_order_event_id).toBe(row.event_id);
  return { buyer, d, txId, row };
}

/** A 36521 'shipped' for the order, signed by `signer`. */
function shippedBy(signer: { sk: Uint8Array; pk: string }, o: { buyer: { pk: string }; d: string; txId: string }) {
  return sign(signer.sk, 36521, [
    ['d', o.d], ['a', `36520:${o.buyer.pk}:${o.d}`], ['a', `30901:${owner.pk}:${UNIT}`], ['p', o.buyer.pk], ['unit_id', UNIT],
    ['status', 'shipped'], ['payment', `30933:${brain.pk}:${o.txId}`], ['v', '1'],
  ]);
}

describe('M-1 — a stranger cannot rewrite a shop', () => {
  it("a stranger's 30901 (same d, shipping 0, pickup, himself owner, his own staff) is ignored for money and access; its 36521s are not stored", async () => {
    relayEvents = [honestUnit(now() - 1000)];
    expect(await sync()).toBe(1);
    expect(unit()).toMatchObject({ pubkey: owner.pk, owner_hex: owner.pk });
    const o = await paidOrder();

    const forged = strangersUnit(now() - 10);
    // THE TRAP: the forgery is perfectly signed and its author IS the owner_hex it names.
    expect(forged.pubkey).toBe(forged.tags.find((t: string[]) => t[0] === 'owner_hex')[1]);
    relayEvents = [honestUnit(now() - 1000), forged];
    await sync();

    const u = unit();
    expect(u).toMatchObject({ pubkey: owner.pk, owner_hex: owner.pk, lanapays_payout_method: 'fiat' });
    expect(u.author_pin).toBe(owner.pk);
    expect(JSON.parse(u.authorized_hex)).toEqual([owner.pk]);
    // money terms the order is judged by
    expect(orderSync.unitToResolver(orderSync.unitRow(db, UNIT)!)).toMatchObject({ shippingFee: '2.50', pickup: false, ownerHex: owner.pk, staffHexes: [] });
    // access
    expect(unitForMerchant(db, stranger.pk, UNIT)).toBeNull();
    expect(unitForMerchant(db, strangersStaff.pk, UNIT)).toBeNull();
    expect(unitForMerchant(db, owner.pk, UNIT)).not.toBeNull();
    // the stranger's staff cannot mark the merchant's order shipped
    expect(orderSync.ingestFulfillment(db, shippedBy(strangersStaff, o))).toBeNull();
    expect(orderSync.ingestFulfillment(db, shippedBy(stranger, o))).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM shop_order_fulfillments').get()).toEqual({ n: 0 });
    await orderSync.resolveOrders(db, { orderIds: [o.d], trusted, fetchListing: listing, now: now() });
    expect(db.prepare('SELECT payment_state, pending, effective_status FROM shop_orders WHERE order_id = ?').get(o.d))
      .toEqual({ payment_state: 'paid', pending: 1, effective_status: 'paid' });
  });

  it("the merchant's own update in the same tick still lands — a stranger's newer event does not knock it out", async () => {
    relayEvents = [honestUnit(now() - 1000)];
    await sync();
    relayEvents = [honestUnit(now() - 1000), honestUnit(now() - 50, '3.00'), strangersUnit(now() - 5)];
    await sync();
    expect(unit()).toMatchObject({ pubkey: owner.pk, owner_hex: owner.pk });
    expect(orderSync.unitToResolver(orderSync.unitRow(db, UNIT)!).shippingFee).toBe('3.00');
  });

  it('a d that is not the unit id cannot reach the shop by its unit_id tag (shadow slot)', async () => {
    relayEvents = [honestUnit(now() - 1000)];
    await sync();
    relayEvents = [honestUnit(now() - 1000), strangersUnit(now() - 10, crypto.randomBytes(16).toString('hex'))];
    await sync();
    expect(unit()).toMatchObject({ pubkey: owner.pk, owner_hex: owner.pk });
    expect(db.prepare('SELECT COUNT(*) AS n FROM business_units').get()).toEqual({ n: 1 });
  });

  it('a new shop two different keys publish is stored for neither; one key alone is trusted on first use', async () => {
    relayEvents = [honestUnit(now() - 100), strangersUnit(now() - 10)];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await sync();
      expect(unit()).toBeUndefined();
      expect(err.mock.calls.some(c => String(c[0]).includes('NOT STORED'))).toBe(true);
    } finally { err.mockRestore(); }
    relayEvents = [honestUnit(now() - 100)];
    expect(await sync()).toBe(1);
    expect(unit()).toMatchObject({ pubkey: owner.pk, author_pin: owner.pk });
  });
});

describe('M-1 — only verified events', () => {
  it('a forged signature is dropped', async () => {
    const real = honestUnit(now() - 1000);
    relayEvents = [real];
    await sync();
    // The merchant's key and tags, shipping 0, a newer date — and a signature
    // that is not over it (another event's): the id no longer matches.
    const other = honestUnit(now() - 999, '9.99');
    const body = { kind: 30901, pubkey: owner.pk, created_at: now() - 5, content: '', tags: honestUnit(0, '0.00').tags };
    const forgedSig = { ...body, id: other.id, sig: other.sig };
    const forgedId = { ...body, id: crypto.createHash('sha256').update(JSON.stringify([0, body.pubkey, body.created_at, body.kind, body.tags, body.content])).digest('hex'), sig: other.sig };
    relayEvents = [real, forgedSig, forgedId];
    await sync();
    expect(unit()).toMatchObject({ event_id: real.id, pubkey: owner.pk });
    expect(orderSync.unitToResolver(orderSync.unitRow(db, UNIT)!).shippingFee).toBe('2.50');
  });

  it('a created_at more than 300 s ahead is dropped — it would win every later sync', async () => {
    const real = honestUnit(now() - 1000);
    relayEvents = [real, honestUnit(now() + 3600, '0.00')];
    await sync();
    expect(unit()).toMatchObject({ event_id: real.id });
  });
});

describe('M-1 — newer only', () => {
  it('an older 30901 never replaces a newer one', async () => {
    const newer = honestUnit(now() - 100, '3.00');
    relayEvents = [newer];
    await sync();
    // a relay that still serves an older copy (or only it)
    relayEvents = [honestUnit(now() - 1000, '2.50')];
    await sync();
    expect(unit()).toMatchObject({ event_id: newer.id });
    expect(orderSync.unitToResolver(orderSync.unitRow(db, UNIT)!).shippingFee).toBe('3.00');
  });
});

describe('M-1 — the pin', () => {
  it('survives a restart, and log-only mode (KIND_30901_AUTHOR_PIN=0) takes the stranger but never moves the pin', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-pin-'));
    const file = path.join(dir, 'pin.db');
    try {
      db.close();
      db = new Database(file);
      initializeSchema(db);
      relayEvents = [honestUnit(now() - 1000)];
      await sync();
      expect(unit().author_pin).toBe(owner.pk);

      // log-only: the stranger's event is taken as before — the pin stays
      process.env.KIND_30901_AUTHOR_PIN = '0';
      relayEvents = [honestUnit(now() - 1000), strangersUnit(now() - 10)];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try { await sync(); } finally { warn.mockRestore(); }
      expect(unit()).toMatchObject({ pubkey: stranger.pk, author_pin: owner.pk });
      delete process.env.KIND_30901_AUTHOR_PIN;

      // restart: the backfill never rewrites a pin that exists
      db.close();
      db = new Database(file);
      initializeSchema(db);
      expect(unit()).toMatchObject({ pubkey: stranger.pk, author_pin: owner.pk });
      // enforced again: the stranger's next edit is refused; the merchant's newer one restores the shop
      const strangersNext = strangersUnit(now() - 5);
      relayEvents = [strangersNext];
      await sync();
      expect(unit().event_id).not.toBe(strangersNext.id);
      relayEvents = [honestUnit(now() - 1)];
      await sync();
      expect(unit()).toMatchObject({ pubkey: owner.pk, owner_hex: owner.pk, author_pin: owner.pk });
    } finally {
      try { db.close(); } catch { /* closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
      db = new Database(':memory:'); // for afterEach
    }
  });

  it("in log-only mode the order path still refuses the stranger's unit row: the order is skipped, not judged, and his 36521 is not stored", async () => {
    relayEvents = [honestUnit(now() - 1000)];
    await sync();
    const o = await paidOrder();
    process.env.KIND_30901_AUTHOR_PIN = '0';
    relayEvents = [honestUnit(now() - 1000), strangersUnit(now() - 10)];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await sync();
      expect(unit()).toMatchObject({ pubkey: stranger.pk });
      expect(orderSync.ingestFulfillment(db, shippedBy(strangersStaff, o))).toBeNull();
      expect(db.prepare('SELECT COUNT(*) AS n FROM shop_order_fulfillments').get()).toEqual({ n: 0 });
      await orderSync.resolveOrders(db, { orderIds: [o.d], trusted, fetchListing: listing, now: now() });
    } finally { warn.mockRestore(); }
    const after = db.prepare('SELECT * FROM shop_orders WHERE order_id = ?').get(o.d) as any;
    expect(after).toMatchObject({ payment_state: 'paid', pending: 1, effective_status: 'paid', resolved_at: o.row.resolved_at });
    expect(after.settled_order_event_id).toBe(after.event_id);

    // …and the stranger, owner of the row now, cannot ship it through the route either
    const app = express();
    app.use(express.json());
    registerOrderRoutes(app, db);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/orders/${o.d}/fulfillment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hex: stranger.pk, event: shippedBy(stranger, o) }),
      });
      expect(res.status).toBe(409);
      expect((await res.json() as any).error).toBe('UNIT_NOT_VERIFIED');
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
    expect(db.prepare('SELECT * FROM shop_orders WHERE order_id = ?').get(o.d)).toEqual(after);
    expect(db.prepare('SELECT COUNT(*) AS n FROM shop_order_fulfillments').get()).toEqual({ n: 0 });
  });

  it('a unit row whose stored 30901 is not a verified event of the order\'s shop is no money input', () => {
    const real = honestUnit(now() - 1000);
    const row = { unit_id: UNIT, name: 'x', owner_hex: owner.pk, pubkey: owner.pk, authorized_hex: '[]', currency: 'EUR', raw_event: JSON.stringify(real) };
    expect(orderSync.moneyUnit(row, owner.pk)).toBe(row);
    expect(orderSync.moneyUnit(row, stranger.pk)).toBeNull();                                         // another shop's key
    expect(orderSync.moneyUnit({ ...row, raw_event: JSON.stringify({ ...real, sig: '0'.repeat(128) }) }, owner.pk)).toBeNull();
    expect(orderSync.moneyUnit({ ...row, raw_event: JSON.stringify({ kind: 30901, pubkey: owner.pk, tags: real.tags, content: '' }) }, owner.pk)).toBeNull();
    expect(orderSync.moneyUnit({ ...row, unit_id: '8'.repeat(32) }, owner.pk)).toBeNull();          // d is another unit
    expect(orderSync.moneyUnit({ ...row, pubkey: stranger.pk }, owner.pk)).toBeNull();
    expect(orderSync.moneyUnit(null, owner.pk)).toBeNull();
  });
});
