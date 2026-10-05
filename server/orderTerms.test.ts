// @vitest-environment node
/**
 * Round 5 (5 Oct 2026), part B — the merchant app's money judgement.
 *
 * F3/F4. An honest order must not stick because the merchant raised a price
 * or the shipping fee, removed free shipping, or turned pickup off before the
 * 30933 arrived. The terms under which ONE 36520 event was exactly right are
 * kept once (shop_order_terms_seen) and judge it a second time when the
 * current terms do not — never for an older rule set's 'paid', never for a
 * buyer's replacement that was not itself once exactly the merchant's. The
 * per-item "last price seen" (shop_order_listing_prices) is gone: it priced a
 * cart from listings seen at different moments.
 *
 * F1. A listing version older than one this app has seen never prices an
 * order: shop_listing_versions remembers the newest version per address (and
 * whether its author deleted it), fed by the listing fetcher and by a read of
 * the shops' listing versions every 5th tick.
 *
 * Review. A verified payment of exactly an order's total that its terms do
 * not reach is listed for Brilly, who confirms it only for the event the
 * broker took, in one transaction that writes nothing unless the order ends
 * paid.
 *
 * Everything runs against a loopback relay stub; nothing leaves 127.0.0.1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { initializeSchema, assertOrdersSchema } from './db/schema.js';
import {
  ingestEvent, resolveOrders, syncShopOrders, makeListingFetcher, readListingVersions, knownListingVersion, orderTermsSeen,
  listSettleReview, confirmSettleReview, termsPriceOrder, ORDER_ITEM_KINDS, type ListingFetcher,
} from './lib/orderSync.js';
import { bindingString } from './lib/orderResolver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mk = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const owner = mk(), brain = mk(), stranger = mk();
const UNIT = 'c'.repeat(32);
const REF = `30901:${owner.pk}:${UNIT}`;
const now = () => Math.floor(Date.now() / 1000);
const orderIdFor = (pk: string) => `${pk.slice(0, 24)}.${crypto.randomBytes(16).toString('hex')}`;
const APPLES = `36502:${owner.pk}:apples`;
const PEARS = `36502:${owner.pk}:pears`;

function sign(sk: Uint8Array, kind: number, tags: string[][], content = '', createdAt = now()) {
  return finalizeEvent({ kind, tags, content, created_at: createdAt }, sk) as any;
}
/** A relay delivers JSON: a fresh object, without nostr-tools' cached "verified" mark. */
const wire = (ev: any) => JSON.parse(JSON.stringify(ev));

const item = (a: string, qty: number, price: string, unit = 'kg') => ['item', a, String(qty), unit, price, 'EUR'];

function orderEvent(b: { sk: Uint8Array; pk: string }, d: string, o: { items: string[][]; shipping: string; total: string; fulfillment?: string; createdAt: number }) {
  return sign(b.sk, 36520, [
    ['d', d], ['a', REF], ['p', owner.pk], ['unit_id', UNIT], ['invoice_number', d],
    ...o.items,
    ['shipping', o.shipping, 'EUR'], ['total', o.total, 'EUR'], ['fulfillment', o.fulfillment ?? 'shipping'], ['status', 'placed'],
    ['pay_by', String(o.createdAt + 1800)], ['client', 'lanaeco.shop'], ['v', '1'],
  ], '', o.createdAt);
}

function purchaseEvent(d: string, buyerPk: string, txId: string, amount: string, createdAt = now() - 60) {
  return sign(brain.sk, 30933, [
    ['d', txId], ['p', 'f'.repeat(64)], ['unit_id', UNIT], ['payment_type', 'lana'], ['customer_hex', 'f'.repeat(64)],
    ['merchant_hex', owner.pk], ['amount', amount], ['currency', 'EUR'], ['lana_amount', '9765432100'],
    ['status', 'processing'], ['invoice_number', d], ['receipt_description', `Jabolka ×2 · ${bindingString(buyerPk, d)}`],
  ], '', createdAt);
}

/** The brain's cancel republish: same d, newer. */
function cancelEvent(d: string, txId: string, amount: string, createdAt = now() - 10) {
  return sign(brain.sk, 30933, [
    ['d', txId], ['p', 'f'.repeat(64)], ['unit_id', UNIT], ['payment_type', 'lana'], ['customer_hex', 'f'.repeat(64)],
    ['merchant_hex', owner.pk], ['amount', amount], ['currency', 'EUR'], ['status', 'cancelled'], ['invoice_number', d],
  ], '', createdAt);
}

/** A merchant-signed listing as a relay serves it. */
function listingEvent(d: string, price: string, createdAt: number, extra: string[][] = []) {
  return wire(sign(owner.sk, 36502, [
    ['d', d], ['a', REF], ['title', 'Med'], ['price', price, 'EUR'], ['unit', 'kg'], ['status', 'active'], ...extra,
  ], '', createdAt));
}

// ── loopback relay stub: kinds, authors, #<tag>, since, until (inclusive), limit (newest first) ──
let relayEvents: any[] = [];
const reqs: any[] = [];
let relay: WebSocketServer;
let relayUrl = '';
function matches(ev: any, f: any): boolean {
  if (Array.isArray(f.kinds) && !f.kinds.includes(ev.kind)) return false;
  if (Array.isArray(f.authors) && !f.authors.includes(ev.pubkey)) return false;
  if (typeof f.since === 'number' && ev.created_at < f.since) return false;
  if (typeof f.until === 'number' && ev.created_at > f.until) return false;
  for (const k of Object.keys(f)) {
    if (!k.startsWith('#') || !Array.isArray(f[k])) continue;
    if (!ev.tags.some((t: string[]) => t[0] === k.slice(1) && f[k].includes(t[1]))) return false;
  }
  return true;
}

let db: Database.Database;
const trusted = new Set([brain.pk]);
let unitClock = now() - 86_400;

/** The shop's KIND 30901 as the heartbeat stores it, signed by the owner (moneyUnit verifies it). */
function setUnit(o: { fee?: string | null; freeFrom?: string; pickup?: boolean; currency?: string } = {}, target: Database.Database = db) {
  const tags: string[][] = [['d', UNIT], ['unit_id', UNIT], ['online_shop', 'true']];
  const fee = o.fee === undefined ? '2.50' : o.fee;
  if (fee !== null) tags.push(['online_shop_shipping_fee', fee]);
  if (o.freeFrom) tags.push(['online_shop_free_shipping_from', o.freeFrom]);
  if (o.pickup ?? true) tags.push(['online_shop_pickup', 'true']);
  const ev = sign(owner.sk, 30901, tags, '', ++unitClock);
  target.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event)
    VALUES (?, ?, ?, ?, 'Trgovina', ?, ?, ?, 'active', ?)
    ON CONFLICT(unit_id) DO UPDATE SET event_id = excluded.event_id, pubkey = excluded.pubkey, created_at = excluded.created_at,
      owner_hex = excluded.owner_hex, currency = excluded.currency, raw_event = excluded.raw_event
  `).run(UNIT, ev.id, owner.pk, ev.created_at, owner.pk, JSON.stringify([owner.pk]), o.currency ?? 'EUR', JSON.stringify(ev));
}

/** Merchant-signed listings by address (a stub fetcher); `down` = that REQ failed. */
let LISTED: Record<string, { price: string; status?: string; createdAt?: number }> = {};
function fetcher(down: string[] = []): ListingFetcher {
  return async (a: string) => {
    const l = LISTED[a];
    if (!l || down.includes(a)) return null;
    return { price: l.price, currency: 'EUR', status: l.status ?? 'active', createdAt: l.createdAt ?? now() - 86_400, unitRef: REF };
  };
}
const row = (d: string) => db.prepare('SELECT * FROM shop_orders WHERE order_id = ?').get(d) as any;
const tick = (fetchListing: ListingFetcher = fetcher(), at = now(), orderIds?: string[]) =>
  resolveOrders(db, { orderIds, trusted, fetchListing, now: at });
const verdict = (r: any) => ({
  payment_state: r.payment_state, expected_total: r.expected_total, price_changed: r.price_changed, effective_status: r.effective_status,
  pending: r.pending, paid_amount: r.paid_amount, pinned: r.settled_order_event_id === r.event_id,
});
const entry = (d: string) => db.prepare('SELECT * FROM shop_order_settle_review WHERE order_id = ?').get(d) as any;
/** The kept terms of one 36520 event as stored (plain SQL, so it also reads a database without the table: 'no table'). */
const termsRow = (eventId: string): any => {
  try { return db.prepare('SELECT * FROM shop_order_terms_seen WHERE order_event_id = ?').get(eventId) ?? null; } catch { return 'no table'; }
};

/** Place an order (judged once by `fetchListing`), return its parts. */
async function place(items: string[][], shipping: string, total: string, o: { fulfillment?: string; fetchListing?: ListingFetcher; createdAt?: number } = {}) {
  const buyer = mk();
  const d = orderIdFor(buyer.pk);
  const t0 = o.createdAt ?? now() - 300;
  expect(ingestEvent(db, orderEvent(buyer, d, { items, shipping, total, fulfillment: o.fulfillment, createdAt: t0 }), trusted)).toBe(d);
  await tick(o.fetchListing ?? fetcher(), now(), [d]);
  return { buyer, d, t0, txId: crypto.randomUUID(), eventId: row(d).event_id as string };
}
const pay = (p: { d: string; buyer: { pk: string }; txId: string }, amount: string, createdAt?: number) =>
  expect(ingestEvent(db, purchaseEvent(p.d, p.buyer.pk, p.txId, amount, createdAt), trusted)).toBe(p.d);

beforeAll(async () => {
  relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(r => relay.once('listening', r));
  relay.on('connection', (socket) => {
    socket.on('message', (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m[0] !== 'REQ') return;
        const [, sub, ...filters] = m;
        reqs.push(...filters);
        const out = new Map<string, any>();
        for (const f of filters) {
          const hits = relayEvents.filter(ev => matches(ev, f)).sort((a, b) => b.created_at - a.created_at);
          for (const ev of (typeof f.limit === 'number' ? hits.slice(0, f.limit) : hits)) out.set(ev.id, ev);
        }
        for (const ev of out.values()) socket.send(JSON.stringify(['EVENT', sub, ev]));
        socket.send(JSON.stringify(['EOSE', sub]));
      } catch { /* ignore */ }
    });
  });
  relayUrl = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  process.env.LANA_RELAYS_OVERRIDE = relayUrl;
  process.env.LANA_TRUSTED_SIGNERS_OVERRIDE = brain.pk;
  db = new Database(':memory:');
  initializeSchema(db);
});

afterAll(async () => {
  delete process.env.LANA_RELAYS_OVERRIDE;
  delete process.env.LANA_TRUSTED_SIGNERS_OVERRIDE;
  await new Promise<void>(r => relay.close(() => r()));
  db.close();
});

beforeEach(() => {
  for (const t of [
    'shop_orders', 'shop_order_payments', 'shop_order_fulfillments', 'shop_order_delivery', 'shop_order_item_snapshots',
    'shop_order_sync_state', 'shop_order_settle_review', 'shop_order_listing_prices', 'shop_order_terms_seen', 'shop_listing_versions',
  ]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* a table the code under test does not have */ }
  }
  db.prepare('DELETE FROM business_units').run();
  setUnit();
  LISTED = { [APPLES]: { price: '5.00' }, [PEARS]: { price: '50.00' } };
  relayEvents = [];
  reqs.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────

describe('F3/F4 — an honest order is paid by the terms it was placed under', () => {
  it('pickup turned off before the 30933 arrives: still paid (MW pickup)', async () => {
    const p = await place([item(APPLES, 1, '5.00')], '0.00', '5.00', { fulfillment: 'pickup' });
    expect(row(p.d)).toMatchObject({ payment_state: 'unpaid', expected_total: '5.00' });
    setUnit({ pickup: false });
    pay(p, '5.00');
    await tick();
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '5.00', paid_tx_id: p.txId });
    expect(row(p.d).settled_order_event_id).toBe(p.eventId);
    // from now on the step-5a pin holds it
    await tick(fetcher(), now() + 60);
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '5.00' });
    expect(listSettleReview(db)).toEqual([]);
  });

  it('a price rise, a fee rise, or free shipping removed before the 30933: still paid', async () => {
    const cases: Array<[string, () => Promise<{ p: Awaited<ReturnType<typeof place>>; amount: string }>, () => void]> = [
      ['price rise', async () => {
        const p = await place([item(APPLES, 2, '5.00')], '2.50', '12.50');
        LISTED[APPLES] = { price: '6.00', createdAt: now() - 30 };
        return { p, amount: '12.50' };
      }, () => { LISTED[APPLES] = { price: '5.00' }; }],
      ['fee rise', async () => {
        const p = await place([item(APPLES, 2, '5.00')], '2.50', '12.50');
        setUnit({ fee: '3.50' });
        return { p, amount: '12.50' };
      }, () => setUnit()],
      ['free shipping removed', async () => {
        setUnit({ freeFrom: '10.00' });
        const p = await place([item(APPLES, 2, '5.00')], '0.00', '10.00');
        setUnit();
        return { p, amount: '10.00' };
      }, () => setUnit()],
    ];
    for (const [label, arrange, restore] of cases) {
      try {
        const { p, amount } = await arrange();
        expect(row(p.d).payment_state, label).toBe('unpaid');
        pay(p, amount);
        await tick();
        expect(row(p.d), label).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: amount, paid_amount: amount });
        expect(row(p.d).settled_order_event_id, label).toBe(p.eventId);
      } finally { restore(); }
    }
    expect(listSettleReview(db)).toEqual([]);
  });

  it('a listing deleted or taken off sale after the order: still paid', async () => {
    for (const gone of ['deleted', 'inactive', 'sold_out'] as const) {
      const p = await place([item(APPLES, 2, '5.00')], '2.50', '12.50');
      if (gone === 'deleted') delete LISTED[APPLES]; else LISTED[APPLES] = { price: '5.00', status: gone, createdAt: now() - 30 };
      try {
        pay(p, '12.50');
        await tick();
        expect(row(p.d), gone).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50' });
      } finally { LISTED[APPLES] = { price: '5.00' }; }
    }
  });

  it('a listing REQ fails on one tick: still paid', async () => {
    const p = await place([item(APPLES, 2, '5.00')], '2.50', '12.50');
    pay(p, '12.50');
    await tick(fetcher([APPLES]));                  // the 30933 lands on the tick the REQ fails
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50' });
    await tick(fetcher(), now() + 60);
    await tick(fetcher([APPLES]), now() + 120);     // and fails again later: the pin holds
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50' });
    // the per-item "last price seen" is gone: never written (nor read) any more
    expect((db.prepare('SELECT COUNT(*) AS n FROM shop_order_listing_prices').get() as any).n).toBe(0);
  });

  it('a replacement that never matched gets no kept terms and is never paid', async () => {
    const p = await place([item(APPLES, 2, '5.00')], '2.50', '12.50');
    pay(p, '12.50');
    await tick();
    expect(row(p.d).payment_state).toBe('paid');
    // E2: 10 × pears at the buyer's 1.00 (the merchant asks 50.00), the same 12.50
    expect(ingestEvent(db, orderEvent(p.buyer, p.d, { items: [item(PEARS, 10, '1.00')], shipping: '2.50', total: '12.50', createdAt: p.t0 + 5 }), trusted)).toBe(p.d);
    const e2 = row(p.d).event_id;
    for (const [i, f] of [fetcher(), fetcher([PEARS]), fetcher()].entries()) {
      await tick(f, now() + 60 * i);
      expect(row(p.d), `tick ${i}`).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, settled_order_event_id: null });
    }
    expect(termsRow(e2)).toBeNull();
    expect(termsRow(p.eventId)).toMatchObject({ total: '12.50' }); // E1's, never read for E2
  });

  it('kept terms are coherent: with one item unknown nothing is kept, and items seen on different ticks never make a price', async () => {
    // 2 × apples 5.00 + 1 × pears 50.00 + 2.50 = 62.50
    const items = [item(APPLES, 2, '5.00'), item(PEARS, 1, '50.00')];
    const p = await place(items, '2.50', '62.50', { fetchListing: fetcher([PEARS]) });
    pay(p, '62.50');
    await tick(fetcher([APPLES]));
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '' });
    expect(termsRow(p.eventId)).toBeNull();
    // both answer: the current terms pay it
    await tick(fetcher(), now() + 60);
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '62.50' });
  });

  it('ON CONFLICT DO NOTHING keeps the first kept terms; a replacement starts with none', async () => {
    const p = await place([item(APPLES, 2, '5.00')], '2.50', '12.50');
    const first = orderTermsSeen(db, p.eventId);
    expect(first).toMatchObject({ shipping_fee: '2.50', free_from: null, pickup: 1, total: '12.50' });
    expect(JSON.parse(first!.prices_json)).toEqual([{ a: APPLES, price: '5.00', listing_created_at: expect.any(Number) }]);
    // the terms change in a way the order still matches: nothing is rewritten
    setUnit({ freeFrom: '100.00' });
    await tick(fetcher(), now() + 600, [p.d]);
    expect(orderTermsSeen(db, p.eventId)).toEqual(first);
    // E2, the same lines, stored but not judged: no kept terms of its own
    expect(ingestEvent(db, orderEvent(p.buyer, p.d, { items: [item(APPLES, 2, '5.00')], shipping: '2.50', total: '12.50', createdAt: p.t0 + 5 }), trusted)).toBe(p.d);
    const e2 = row(p.d).event_id;
    expect(orderTermsSeen(db, e2)).toBeNull();
    // the merchant raised apples before E2 was ever judged: E1's terms do not price E2
    LISTED[APPLES] = { price: '6.00', createdAt: now() - 30 };
    pay(p, '12.50');
    await tick();
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '14.50' });
    expect(orderTermsSeen(db, e2)).toBeNull();
  });

  it('the shop gone, or its currency changed: not paid', async () => {
    const a = await place([item(APPLES, 2, '5.00')], '2.50', '12.50');
    db.prepare("UPDATE business_units SET currency = 'HUF' WHERE unit_id = ?").run(UNIT);
    pay(a, '12.50');
    await tick();
    expect(row(a.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, settled_order_event_id: null });
    setUnit();

    const b = await place([item(APPLES, 2, '5.00')], '2.50', '12.50');
    pay(b, '12.50');
    db.prepare('DELETE FROM business_units WHERE unit_id = ?').run(UNIT);
    expect(await tick(fetcher(), now(), [b.d])).toBe(0);         // skipped, not judged
    expect(row(b.d)).toMatchObject({ payment_state: 'unpaid', pending: 0, settled_order_event_id: null });
  });

  it('the newest 30933 cancelled: not paid', async () => {
    const p = await place([item(APPLES, 2, '5.00')], '2.50', '12.50');
    setUnit({ fee: '3.50' });
    pay(p, '12.50');
    expect(ingestEvent(db, cancelEvent(p.d, p.txId, '12.50'), trusted)).toBe(p.d);
    await tick();
    expect(row(p.d)).toMatchObject({ payment_state: 'unpaid', pending: 0, settled_order_event_id: null });
    // paid by its kept terms first, cancelled later: un-paid
    const q = await place([item(APPLES, 2, '5.00')], '3.50', '13.50');
    setUnit({ fee: '4.00' });
    pay(q, '13.50');
    await tick();
    expect(row(q.d).payment_state).toBe('paid');
    expect(ingestEvent(db, cancelEvent(q.d, q.txId, '13.50', now()), trusted)).toBe(q.d);
    await tick(fetcher(), now() + 60);
    expect(row(q.d)).toMatchObject({ payment_state: 'unpaid', pending: 0, settled_order_event_id: null });
  });

  it('an older rule set\'s \'paid\' is never judged by kept terms', async () => {
    const p = await place([item(APPLES, 2, '5.00')], '2.50', '12.50');
    pay(p, '12.50');
    await tick();
    // as the older rules left it: 'paid', no v1.1.2 pin
    db.prepare('UPDATE shop_orders SET settled_order_event_id = NULL WHERE order_id = ?').run(p.d);
    LISTED[APPLES] = { price: '6.00', createdAt: now() - 30 };
    for (const t of [0, 60]) {
      await tick(fetcher(), now() + t);
      expect(row(p.d), `tick +${t}`).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '14.50', settled_order_event_id: null });
      expect(entry(p.d), `tick +${t}`).toMatchObject({ reason: 'legacy_paid', old_paid_tx_id: p.txId, old_paid_amount: '12.50', cleared_at: null });
    }
    // …although kept terms that would pay it exist for this very event
    expect(termsRow(p.eventId)).toMatchObject({ shipping_fee: '2.50', total: '12.50' });
  });

  it('a replacement placed during a sale is paid exactly as the pin would pay it, whichever comes first: the 30933 or the end of the sale', async () => {
    const run = async (paymentFirst: boolean) => {
      LISTED[APPLES] = { price: '5.00', createdAt: now() - 86_400 };
      const p = await place([item(APPLES, 2, '5.00')], '2.50', '12.50');
      // the sale: apples 4.00; the buyer replaces the order at the sale price
      LISTED[APPLES] = { price: '4.00', createdAt: now() - 200 };
      expect(ingestEvent(db, orderEvent(p.buyer, p.d, { items: [item(APPLES, 2, '4.00')], shipping: '2.50', total: '10.50', createdAt: p.t0 + 5 }), trusted)).toBe(p.d);
      await tick();
      expect(row(p.d).payment_state).toBe('unpaid');
      if (paymentFirst) { pay(p, '10.50'); await tick(); expect(row(p.d).payment_state).toBe('paid'); }
      LISTED[APPLES] = { price: '5.00', createdAt: now() - 100 };   // the sale ends
      if (!paymentFirst) pay(p, '10.50');
      await tick(fetcher(), now() + 60);
      await tick(fetcher(), now() + 120);
      return verdict(row(p.d));
    };
    const pin = await run(true);
    const kept = await run(false);
    expect(pin).toEqual({ payment_state: 'paid', expected_total: '10.50', price_changed: 1, effective_status: 'paid', pending: 1, paid_amount: '10.50', pinned: true });
    expect(kept).toEqual(pin);
    expect(listSettleReview(db)).toEqual([]);
  });

  it('termsPriceOrder: the order\'s own numbers are exactly the merchant\'s, in one currency', () => {
    const unit = { ownerHex: owner.pk, staffHexes: [], currency: 'EUR', shippingFee: '2.50', freeShippingFrom: '20.00', pickup: false };
    const order = (o: Partial<{ unitPrice: string; qty: number; shipping: string; total: string; currency: string; itemCurrency: string; fulfillment: string }> = {}) => ({
      d: 'x', pubkey: owner.pk, createdAt: 1, unitId: UNIT, status: 'placed', fulfillment: o.fulfillment ?? 'shipping', payBy: 2,
      items: [{ a: APPLES, qty: o.qty ?? 2, unitPrice: o.unitPrice ?? '5.00', currency: o.itemCurrency ?? 'EUR' }],
      shipping: o.shipping ?? '2.50', total: o.total ?? '12.50', currency: o.currency ?? 'EUR',
    });
    expect(termsPriceOrder(order(), unit, ['5.00'])).toBe(true);
    expect(termsPriceOrder(order({ qty: 4, shipping: '0.00', total: '20.00' }), unit, ['5.00'])).toBe(true);   // free from 20.00
    expect(termsPriceOrder(order(), unit, [null])).toBe(false);
    expect(termsPriceOrder(order(), unit, ['5.01'])).toBe(false);
    expect(termsPriceOrder(order({ total: '12.49' }), unit, ['5.00'])).toBe(false);
    expect(termsPriceOrder(order({ shipping: '0.00', total: '12.50' }), unit, ['5.00'])).toBe(false);
    expect(termsPriceOrder(order({ currency: 'HUF', itemCurrency: 'HUF' }), unit, ['5.00'])).toBe(false);
    expect(termsPriceOrder(order({ itemCurrency: 'USD' }), unit, ['5.00'])).toBe(false);
    expect(termsPriceOrder(order({ fulfillment: 'pickup', shipping: '0.00', total: '10.00' }), unit, ['5.00'])).toBe(false); // no pickup
    expect(termsPriceOrder(order({ fulfillment: 'pickup', shipping: '0.00', total: '10.00' }), { ...unit, pickup: true }, ['5.00'])).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('F1 — a listing version older than one seen never prices an order', () => {
  const HONEY = `36502:${owner.pk}:honey`;

  it('an `e`-only delete of the current version, then an older re-broadcast: prices nothing (MW1)', async () => {
    const v1 = listingEvent('honey', '5.00', now() - 200_000);
    const v2 = listingEvent('honey', '50.00', now() - 100_000);
    relayEvents = [v2];
    const p = await place([item(HONEY, 1, '50.00')], '2.50', '52.50', { fetchListing: makeListingFetcher(db, [relayUrl], 2000) });
    pay(p, '52.50');
    await tick(makeListingFetcher(db, [relayUrl], 2000));
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', expected_total: '52.50' });
    // the merchant deletes v2 by its event id only; the relays drop it; someone re-broadcasts v1
    relayEvents = [wire(sign(owner.sk, 5, [['e', v2.id]], '', now() - 50)), v1];
    expect(await makeListingFetcher(db, [relayUrl], 2000)(HONEY)).toBeNull();
    // the buyer's replacement: 10 × honey at v1's 5.00, the same 52.50
    expect(ingestEvent(db, orderEvent(p.buyer, p.d, { items: [item(HONEY, 10, '5.00')], shipping: '2.50', total: '52.50', createdAt: p.t0 + 5 }), trusted)).toBe(p.d);
    await tick(makeListingFetcher(db, [relayUrl], 2000), now() + 60);
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '', settled_order_event_id: null });
    // a relay that does not apply deletions and serves all three: v2 is deleted, v1 is older
    relayEvents = [v2, wire(sign(owner.sk, 5, [['e', v2.id]], '', now() - 50)), v1];
    expect(await makeListingFetcher(db, [relayUrl], 2000)(HONEY)).toBeNull();
    expect(knownListingVersion(db, HONEY)).toMatchObject({ event_id: v2.id, deleted: 1 });
    // the KIND 5 itself is gone from the relays later: v2 stays deleted
    relayEvents = [v2];
    expect(await makeListingFetcher(db, [relayUrl], 2000)(HONEY)).toBeNull();
  });

  it('a newer re-listing works again', async () => {
    const v2 = listingEvent('honey', '50.00', now() - 100_000);
    relayEvents = [v2, wire(sign(owner.sk, 5, [['e', v2.id]], '', now() - 50))];
    expect(await makeListingFetcher(db, [relayUrl], 2000)(HONEY)).toBeNull();
    const v3 = listingEvent('honey', '55.00', now() - 10);
    relayEvents = [v3, wire(sign(owner.sk, 5, [['e', v2.id]], '', now() - 50))];
    expect(await makeListingFetcher(db, [relayUrl], 2000)(HONEY)).toMatchObject({ price: '55.00', eventId: v3.id });
    const p = await place([item(HONEY, 1, '55.00')], '2.50', '57.50', { fetchListing: makeListingFetcher(db, [relayUrl], 2000) });
    pay(p, '57.50');
    await tick(makeListingFetcher(db, [relayUrl], 2000));
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '57.50' });
  });

  it('the version memory survives a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lana-versions-'));
    const file = path.join(dir, 'app.db');
    try {
      const v1 = listingEvent('honey', '5.00', now() - 200_000);
      const v2 = listingEvent('honey', '50.00', now() - 100_000);
      let disk = new Database(file);
      initializeSchema(disk);
      relayEvents = [v2];
      expect(await makeListingFetcher(disk, [relayUrl], 2000)(HONEY)).toMatchObject({ price: '50.00' });
      disk.close();
      disk = new Database(file);
      initializeSchema(disk);
      relayEvents = [v1];  // only the older version is served now
      expect(await makeListingFetcher(disk, [relayUrl], 2000)(HONEY)).toBeNull();
      expect(knownListingVersion(disk, HONEY)).toMatchObject({ event_id: v2.id, deleted: 0 });
      disk.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the proactive read learns a version the resolver never fetched, and the older re-broadcast is refused — it prices nothing itself', async () => {
    const JAM = `36502:${owner.pk}:jam`;
    const v1 = listingEvent('jam', '3.00', now() - 200_000);
    const v2 = listingEvent('jam', '30.00', now() - 100_000);
    const strangers = wire(sign(stranger.sk, 36502, [['d', 'jam'], ['a', REF], ['price', '0.01', 'EUR']], '', now() - 10));
    const forged = { ...listingEvent('jam', '0.02', now() - 5), sig: 'f'.repeat(128) };
    const future = listingEvent('jam', '0.03', now() + 700);
    relayEvents = [v2, strangers, forged, future];
    const ordersBefore = db.prepare('SELECT * FROM shop_orders').all();
    expect(await readListingVersions(db, [relayUrl], 2000)).toBe(1);
    expect(knownListingVersion(db, JAM)).toMatchObject({ event_id: v2.id, deleted: 0 });
    expect(db.prepare('SELECT * FROM shop_orders').all()).toEqual(ordersBefore);
    // what it asked for: our online shops' listing kinds, by their keys
    const f = reqs.find(r => Array.isArray(r.authors) && Array.isArray(r.kinds) && r.kinds.length > 1);
    expect(f).toMatchObject({ authors: [owner.pk] });
    expect([...f.kinds].sort()).toEqual([...ORDER_ITEM_KINDS].sort());
    // a second read with nothing newer changes nothing
    expect(await readListingVersions(db, [relayUrl], 2000)).toBe(0);
    // only v1 is served now: refused, and an order naming it is not paid
    relayEvents = [v1];
    expect(await makeListingFetcher(db, [relayUrl], 2000)(JAM)).toBeNull();
    const p = await place([item(JAM, 10, '3.00')], '2.50', '32.50', { fetchListing: makeListingFetcher(db, [relayUrl], 2000) });
    pay(p, '32.50');
    await tick(makeListingFetcher(db, [relayUrl], 2000));
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '' });
  });

  it('the heartbeat reads the versions on every 5th tick, before it judges', async () => {
    const BREAD = `36502:${owner.pk}:bread`;
    const v = listingEvent('bread', '3.00', now() - 100);
    relayEvents = [v];
    const first = await syncShopOrders(db, [relayUrl]);
    expect(first.fetched.listing_versions).toBe(1);
    expect(knownListingVersion(db, BREAD)?.event_id).toBe(v.id);
    for (let t = 2; t <= 5; t++) expect((await syncShopOrders(db, [relayUrl])).fetched.listing_versions, `tick ${t}`).toBeUndefined();
    expect((await syncShopOrders(db, [relayUrl])).fetched.listing_versions).toBe(0); // tick 6: read again, nothing newer
  });

  it('a shop that is not online, or whose stored 30901 is not its own signed event, is not read', async () => {
    db.prepare('DELETE FROM business_units').run();
    const offline = sign(owner.sk, 30901, [['d', UNIT], ['unit_id', UNIT], ['online_shop', 'false']], '', ++unitClock);
    db.prepare(`
      INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event)
      VALUES (?, ?, ?, ?, 'Trgovina', ?, '[]', 'EUR', 'active', ?)
    `).run(UNIT, offline.id, owner.pk, offline.created_at, owner.pk, JSON.stringify(offline));
    const other = 'b'.repeat(32);
    const claimed = sign(owner.sk, 30901, [['d', other], ['unit_id', other], ['online_shop', 'true']], '', ++unitClock);
    db.prepare(`
      INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event)
      VALUES (?, ?, ?, ?, 'Tuja', ?, '[]', 'EUR', 'active', ?)
    `).run(other, claimed.id, stranger.pk, claimed.created_at, stranger.pk, JSON.stringify(claimed));
    relayEvents = [listingEvent('jam', '30.00', now() - 100)];
    expect(await readListingVersions(db, [relayUrl], 2000)).toBe(0);
    expect(reqs).toEqual([]);
  });

  it('versions follow NIP-01 (later created_at, then the lower id) and one dated more than 600 s ahead is ignored', async () => {
    const t = now() - 1000;
    const a = listingEvent('tie', '7.00', t);
    const b = listingEvent('tie', '8.00', t); // the same second, another id
    const lower = a.id < b.id ? a : b;
    const TIE = `36502:${owner.pk}:tie`;
    relayEvents = [a, b, listingEvent('tie', '0.01', now() + 700)];
    expect((await makeListingFetcher(db, [relayUrl], 2000)(TIE))?.eventId).toBe(lower.id);
    db.prepare('DELETE FROM shop_listing_versions').run();
    await readListingVersions(db, [relayUrl], 2000);
    expect(knownListingVersion(db, TIE)?.event_id).toBe(lower.id);
    // a version 500 s ahead is a version
    const soon = listingEvent('tie', '9.00', now() + 500);
    relayEvents = [a, b, soon];
    expect((await makeListingFetcher(db, [relayUrl], 2000)(TIE))?.eventId).toBe(soon.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('review — a verified payment of the order\'s total that its terms do not reach', () => {
  /** Repriced to 6.00 BEFORE the order is first judged, the 30933 already there: no kept terms, a verified payment of 12.50. */
  async function repricedFirst(o: { amount?: string } = {}) {
    LISTED[APPLES] = { price: '6.00', createdAt: now() - 30 };
    const buyer = mk();
    const d = orderIdFor(buyer.pk);
    const t0 = now() - 300;
    expect(ingestEvent(db, orderEvent(buyer, d, { items: [item(APPLES, 2, '5.00')], shipping: '2.50', total: '12.50', createdAt: t0 }), trusted)).toBe(d);
    const p = { buyer, d, t0, txId: crypto.randomUUID() };
    pay(p, o.amount ?? '12.50');
    await tick();
    return { ...p, eventId: row(d).event_id as string };
  }
  /** Every row a confirmation could touch, as stored. */
  const everything = (d: string, ev: string) => ({
    order: row(d), entry: entry(d), terms: termsRow(ev),
    items: db.prepare('SELECT * FROM shop_order_item_snapshots WHERE order_id = ?').all(d),
  });

  /** An older rule set's 'paid' (no v1.1.2 pin) repriced to 6.00 since: step 5 lists it ('legacy_paid'). */
  async function legacyRepriced() {
    const p = await place([item(APPLES, 2, '5.00')], '2.50', '12.50');
    pay(p, '12.50');
    await tick();
    expect(row(p.d).payment_state).toBe('paid');
    db.prepare('UPDATE shop_orders SET settled_order_event_id = NULL WHERE order_id = ?').run(p.d);
    LISTED[APPLES] = { price: '6.00', createdAt: now() - 30 };
    await tick();
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', expected_total: '14.50' });
    expect(entry(p.d)).toMatchObject({ old_paid_tx_id: p.txId, old_paid_amount: '12.50', cleared_at: null });
    return p;
  }

  it('is listed with its reason and the payment as the pin — terms_mismatch; cleared once paid', async () => {
    const p = await repricedFirst();
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch', pending: 0, expected_total: '14.50' });
    const listed = listSettleReview(db);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      order_id: p.d, order_event_id: p.eventId, current_event_id: p.eventId, reason: 'terms_mismatch',
      old_paid_tx_id: p.txId, old_paid_amount: '12.50', verdict: 'amount_mismatch', expected_total: '14.50', total: '12.50', cleared_at: null,
    });
    // judged again: still one entry, listed_at unchanged
    const listedAt = entry(p.d).listed_at;
    await tick(fetcher(), now() + 60);
    expect(entry(p.d)).toMatchObject({ listed_at: listedAt, reason: 'terms_mismatch', cleared_at: null });
    // the merchant goes back to 5.00: paid, and the entry is cleared
    LISTED[APPLES] = { price: '5.00', createdAt: now() - 5 };
    await tick(fetcher(), now() + 120);
    expect(row(p.d)).toMatchObject({ payment_state: 'paid', pending: 1 });
    expect(entry(p.d).cleared_at).toBeGreaterThan(0);
    expect(listSettleReview(db)).toEqual([]);
  });

  it('not_computable when a listing is unknown; cleared when the payment is cancelled', async () => {
    const buyer = mk();
    const d = orderIdFor(buyer.pk);
    expect(ingestEvent(db, orderEvent(buyer, d, { items: [item(APPLES, 2, '5.00')], shipping: '2.50', total: '12.50', createdAt: now() - 300 }), trusted)).toBe(d);
    const p = { buyer, d, txId: crypto.randomUUID() };
    pay(p, '12.50');
    await tick(fetcher([APPLES]));
    expect(listSettleReview(db).map(e => [e.order_id, e.reason, e.expected_total])).toEqual([[d, 'not_computable', '']]);
    expect(ingestEvent(db, cancelEvent(d, p.txId, '12.50'), trusted)).toBe(d);
    await tick(fetcher([APPLES]), now() + 60);
    expect(row(d)).toMatchObject({ payment_state: 'unpaid', pending: 0 });
    expect(entry(d).cleared_at).toBeGreaterThan(0);
    expect(listSettleReview(db)).toEqual([]);
  });

  it('is not listed when the order\'s total is not the payment\'s amount', async () => {
    const p = await repricedFirst({ amount: '12.00' });
    expect(row(p.d)).toMatchObject({ payment_state: 'amount_mismatch' });
    expect(entry(p.d)).toBeUndefined();
  });

  it('confirm: refused for an event the broker did not take — nothing written; paid for the one it took', async () => {
    for (const kind of ['legacy_paid', 'terms_mismatch']) {
      LISTED[APPLES] = { price: '5.00' };
      const p = kind === 'legacy_paid' ? await legacyRepriced() : await repricedFirst();
      const before = everything(p.d, p.eventId);
      expect(await confirmSettleReview(db, p.d, p.eventId, 'a'.repeat(64), { trusted }), kind).toEqual({ ok: false, reason: 'not_taken' });
      expect(await confirmSettleReview(db, p.d, p.eventId, '', { trusted }), kind).toEqual({ ok: false, reason: 'not_taken' });
      expect(everything(p.d, p.eventId), kind).toEqual(before);
      expect(entry(p.d).reason, kind).toBe(kind);
      expect(await confirmSettleReview(db, p.d, p.eventId, p.eventId, { trusted }), kind).toEqual({ ok: true, paymentState: 'paid', expected: '12.50' });
      expect(row(p.d), kind).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50', paid_tx_id: p.txId });
      expect(row(p.d).settled_order_event_id, kind).toBe(p.eventId);
      expect(entry(p.d), kind).toMatchObject({ cleared_at: expect.any(Number), confirmed_at: expect.any(Number) });
      await tick(fetcher(), now() + 60);
      expect(row(p.d), kind).toMatchObject({ payment_state: 'paid', pending: 1, expected_total: '12.50' });
    }
  });

  it('confirm: refused when the order\'s total is not the pinned amount — nothing written', async () => {
    // an older rule set left it 'paid' by a 12.00 purchase for an order of 12.50
    const p = await place([item(APPLES, 2, '5.00')], '2.50', '12.50');
    pay(p, '12.00');
    await tick();
    const pay12 = db.prepare('SELECT * FROM shop_order_payments WHERE invoice_number = ?').get(p.d) as any;
    db.prepare(`
      UPDATE shop_orders SET payment_state = 'paid', expected_total = '12.00', effective_status = 'paid', pending = 1,
        paid_signer_hex = ?, paid_tx_id = ?, paid_event_id = ?, paid_amount = '12.00', paid_at = ?,
        paid_order_event_id = event_id, settled_order_event_id = NULL
      WHERE order_id = ?
    `).run(pay12.pubkey, pay12.tx_id, pay12.event_id, pay12.created_at, p.d);
    await tick();
    expect(entry(p.d)).toMatchObject({ old_paid_amount: '12.00', cleared_at: null });
    const before = everything(p.d, p.eventId);
    expect(await confirmSettleReview(db, p.d, p.eventId, p.eventId, { trusted })).toEqual({ ok: false, reason: 'total_mismatch' });
    expect(everything(p.d, p.eventId)).toEqual(before);
    expect(entry(p.d).reason).toBe('legacy_paid');
  });

  it('confirm that does not end paid leaves every row byte for byte as it was', async () => {
    for (const kind of ['legacy_paid', 'terms_mismatch']) {
      LISTED[APPLES] = { price: '5.00' };
      const p = kind === 'legacy_paid' ? await legacyRepriced() : await repricedFirst();
      // the brain cancelled the purchase; no tick has judged that yet
      expect(ingestEvent(db, cancelEvent(p.d, p.txId, '12.50'), trusted)).toBe(p.d);
      const before = everything(p.d, p.eventId);
      expect(await confirmSettleReview(db, p.d, p.eventId, p.eventId, { trusted }), kind).toEqual({ ok: false, reason: 'not_paid', paymentState: 'unpaid' });
      expect(everything(p.d, p.eventId), kind).toEqual(before);
      expect(before.order, kind).toMatchObject({ payment_state: 'amount_mismatch' });
    }
  });

  it('listSettleReview hides entries younger than minAgeSeconds', async () => {
    const p = await repricedFirst();
    const listedAt = entry(p.d).listed_at;
    expect(listSettleReview(db, { minAgeSeconds: 3600, now: listedAt + 3599 })).toEqual([]);
    expect(listSettleReview(db, { minAgeSeconds: 3600, now: listedAt + 3600 }).map(e => e.order_id)).toEqual([p.d]);
    expect(listSettleReview(db).map(e => e.order_id)).toEqual([p.d]);
  });

  it('server/scripts/settle-review.ts: shows the reason, hides entries under an hour old unless --all, confirm needs --taken', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lana-review-'));
    const file = path.join(dir, 'app.db');
    try {
      const disk = new Database(file);
      initializeSchema(disk);
      const ins = disk.prepare(`
        INSERT INTO shop_order_settle_review (order_id, order_event_id, old_paid_tx_id, old_paid_amount, verdict, expected_total, listed_at, cleared_at, reason)
        VALUES (?, ?, ?, '12.50', 'amount_mismatch', ?, ?, NULL, ?)
      `);
      ins.run('old-entry', 'e'.repeat(64), 'tx-old', '14.50', now() - 7200, 'terms_mismatch');
      ins.run('young-entry', 'f'.repeat(64), 'tx-young', '', now() - 60, 'not_computable');
      disk.close();
      const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', path.join(here, 'scripts/settle-review.ts'), ...args], {
        cwd: path.join(here, '..'), env: { ...process.env, LANA_DB_PATH: file, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 60_000,
      });
      const listed = cli('list');
      expect(listed.status).toBe(0);
      const rows = listed.stdout.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
      expect(rows.map(r => [r.order_id, r.reason])).toEqual([['old-entry', 'terms_mismatch']]);
      expect(listed.stdout).toContain('open entries: 1 (1 listed less than an hour ago hidden');
      const all = cli('list', '--all');
      expect(all.stdout.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l).order_id)).toEqual(['old-entry', 'young-entry']);
      const noTaken = cli('confirm', 'old-entry', 'e'.repeat(64));
      expect(noTaken.status).toBe(2);
      expect(noTaken.stderr).toContain('--taken <event_id>');
      const refused = cli('confirm', 'old-entry', 'e'.repeat(64), '--taken', 'e'.repeat(64));
      expect(refused.status).toBe(1);
      expect(JSON.parse(refused.stdout.split('\n').filter(l => l.startsWith('{')).pop()!)).toEqual({ ok: false, reason: 'order_replaced' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────

describe('a database built by origin/main code', () => {
  it('the live-order shape (1 × 4.08 EUR, pickup, sale unit g vs the listing\'s kos, 30933 processing, rejected) stays paid / rejected; nothing is listed', async () => {
    const sql = fs.readFileSync(path.join(here, 'fixtures/origin-main-live-order.sql'), 'utf8');
    const listing = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/origin-main-live-order.listing.json'), 'utf8'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lana-live-order-'));
    const file = path.join(dir, 'copy.db');
    try {
      const seed = new Database(file);
      seed.exec(sql);
      seed.close();
      const live = new Database(file);
      try {
        const asBuilt = live.prepare('SELECT order_id, payment_state, effective_status, expected_total, pending FROM shop_orders').all();
        expect(asBuilt).toEqual([{ order_id: expect.any(String), payment_state: 'paid', effective_status: 'rejected', expected_total: '4.08', pending: 0 }]);
        initializeSchema(live);
        expect(assertOrdersSchema(live)).toMatchObject({ ok: true, missing: [] });
        const signer = (live.prepare('SELECT pubkey FROM shop_order_payments').get() as any).pubkey;
        relayEvents = [listing];
        for (const t of [0, 60]) {
          await resolveOrders(live, { trusted: new Set([signer]), fetchListing: makeListingFetcher(live, [relayUrl], 2000), now: now() + t });
          const r = live.prepare('SELECT * FROM shop_orders').get() as any;
          expect(r, `tick +${t}`).toMatchObject({ payment_state: 'paid', effective_status: 'rejected', pending: 0, expected_total: '4.08', price_changed: 1 });
          expect(r.settled_order_event_id).toBe(r.event_id);
          expect(listSettleReview(live)).toEqual([]);
          expect((live.prepare('SELECT COUNT(*) AS n FROM shop_order_settle_review').get() as any).n).toBe(0);
        }
      } finally {
        live.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
