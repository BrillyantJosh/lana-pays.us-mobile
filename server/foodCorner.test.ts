// @vitest-environment node
/**
 * GET /api/food-corner/open-count — the till's notice "you have N orders on
 * Točka obilja". Read-only: a fake relay serves signed events; nothing is
 * published and no table is written.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'net';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { initializeSchema } from './db/schema.js';
import { fetchAllPaged, foodCornerOpenCount, registerFoodCornerRoutes } from './foodCorner.js';

const mk = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const owner = mk(), staff = mk(), buyer = mk(), node = mk(), forger = mk();
const UNIT_A = 'a'.repeat(32);
const UNIT_B = 'b'.repeat(32);
const UNIT_S = 'c'.repeat(32); // simple.lanapays.us — not this app's shop
const NODE_REF = `30905:${node.pk}:eko-tocka`;
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
// Tuesday 24. 11. 2026, 10:00 Ljubljana — the cycle Thu 19. 11. → Thu 26. 11.
const NOW = new Date('2026-11-24T10:00:00+01:00').getTime();

const sign = (who: { sk: Uint8Array }, kind: number, tags: string[][], at: string) =>
  finalizeEvent({ kind, tags, content: '', created_at: sec(at) }, who.sk) as any;
let seq = 0;
const order = (unitId: string, at: string, extra: string[][] = [], who = buyer) => sign(who, 36601, [
  ['d', `o-${++seq}`], ['a', `30901:${owner.pk}:${unitId}`], ['buyer_type', 'individual'],
  ['item', `36500:${owner.pk}:x`, '2', 'kg', '3.00', 'EUR'], ['total', '6.00', 'EUR'],
  ['status', 'placed'], ['fulfillment', 'distribution_point'], ['distribution_point', NODE_REF], ...extra,
], at);
const nodeEvent = sign(node, 30905, [['d', 'eko-tocka'], ['name', 'Eko točka'], ['pickup', 'p1', 'Dvorišče', '', '', 'thursday', '18:00-20:00']], '2026-09-01T10:00:00+02:00');

/** A relay that understands the filters the route sends, newest first, 500 per REQ. */
function fakeRelay(events: any[], log: Record<string, unknown>[] = []) {
  return async (filter: Record<string, any>) => {
    log.push(filter);
    const match = events.filter(e =>
      (!filter.kinds || filter.kinds.includes(e.kind))
      && (!filter.authors || filter.authors.includes(e.pubkey))
      && (!filter['#a'] || e.tags.some((t: string[]) => t[0] === 'a' && filter['#a'].includes(t[1])))
      && (filter.since === undefined || e.created_at >= filter.since)
      && (filter.until === undefined || e.created_at <= filter.until));
    return match.sort((x, y) => y.created_at - x.created_at).slice(0, filter.limit ?? 500);
  };
}

let db: Database.Database;
beforeAll(() => {
  db = new Database(':memory:');
  initializeSchema(db);
  const unit = (id: string, name: string, staffHex: string[], simple = false) => db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event, unit_type, lana_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', 'active', '{}', ?, ?)
  `).run(id, `ev-${id}`, owner.pk, 1, name, owner.pk, JSON.stringify(staffHex), simple ? 'simple.lanapays.us' : null, simple ? 1 : 0);
  unit(UNIT_A, 'Kmetija A', [owner.pk, staff.pk]);
  unit(UNIT_B, 'Kmetija B', [owner.pk]);
  unit(UNIT_S, 'Simple S', [owner.pk], true);
  db.prepare(`INSERT INTO kind_38888 (event_id, relays) VALUES ('ev', ?)`).run(JSON.stringify(['wss://relay.example']));
});
afterAll(() => db.close());

describe('foodCornerOpenCount', () => {
  it('counts the open orders of the units this hex owns, per unit, with the delivery day', async () => {
    const events = [
      nodeEvent,
      order(UNIT_A, '2026-11-20T09:00:00+01:00'),
      order(UNIT_A, '2026-11-23T17:00:00+01:00'),
      order(UNIT_B, '2026-11-24T08:00:00+01:00', [['lead_time_weeks', '1']]),
      order(UNIT_A, '2026-11-17T09:00:00+01:00'), // last cycle, delivered 19. 11.
      order(UNIT_S, '2026-11-23T09:00:00+01:00'), // a simple.lanapays.us unit
    ];
    const res = await foodCornerOpenCount(db, owner.pk, { fetchEvents: fakeRelay(events), now: () => NOW });
    expect(res).toEqual({
      success: true,
      count: 3,
      units: [
        { unit_id: UNIT_A, name: 'Kmetija A', count: 2 },
        { unit_id: UNIT_B, name: 'Kmetija B', count: 1 },
      ],
      next_delivery: '2026-11-26',
      link: 'https://mejmosefajn.org/food-corner/supplier',
    });
  });

  it('says nothing about the buyer or the money', async () => {
    const res = await foodCornerOpenCount(db, owner.pk, {
      fetchEvents: fakeRelay([nodeEvent, order(UNIT_A, '2026-11-20T09:00:00+01:00')]), now: () => NOW,
    });
    const text = JSON.stringify(res);
    expect(text).not.toContain(buyer.pk);
    expect(text).not.toContain('6.00');
  });

  it('shows nothing to staff: the supplier page answers only the owner\'s key', async () => {
    const res = await foodCornerOpenCount(db, staff.pk, {
      fetchEvents: fakeRelay([nodeEvent, order(UNIT_A, '2026-11-20T09:00:00+01:00')]), now: () => NOW,
    });
    expect(res).toMatchObject({ success: true, count: 0, units: [] });
  });

  it('does not count an order whose signature does not hold', async () => {
    const forged = { ...order(UNIT_A, '2026-11-20T09:00:00+01:00'), sig: 'f'.repeat(128) };
    const res = await foodCornerOpenCount(db, owner.pk, { fetchEvents: fakeRelay([nodeEvent, forged]), now: () => NOW });
    expect(res).toMatchObject({ success: true, count: 0 });
  });

  it('drops an order once the owner published "delivered" (36604) for its point and cycle', async () => {
    const o = order(UNIT_A, '2026-11-20T09:00:00+01:00');
    const delivered = sign(owner, 36604, [['d', 'eko-tocka__1795042800'], ['a', NODE_REF], ['cycle_start', '1795042800']], '2026-11-24T09:00:00+01:00');
    const byForger = sign(forger, 36604, [['d', 'eko-tocka__1795042800'], ['a', NODE_REF], ['cycle_start', '1795042800']], '2026-11-24T09:00:00+01:00');
    expect(await foodCornerOpenCount(db, owner.pk, { fetchEvents: fakeRelay([nodeEvent, o, byForger]), now: () => NOW }))
      .toMatchObject({ count: 1 });
    expect(await foodCornerOpenCount(db, owner.pk, { fetchEvents: fakeRelay([nodeEvent, o, delivered]), now: () => NOW }))
      .toMatchObject({ count: 0, next_delivery: null });
  });

  it('asks the relays only for its own units\' orders, its own deliveries and the points named', async () => {
    const log: Record<string, any>[] = [];
    await foodCornerOpenCount(db, owner.pk, {
      fetchEvents: fakeRelay([nodeEvent, order(UNIT_A, '2026-11-20T09:00:00+01:00')], log), now: () => NOW,
    });
    const orders = log.find(f => f.kinds[0] === 36601)!;
    expect(orders['#a'].sort()).toEqual([`30901:${owner.pk}:${UNIT_A}`, `30901:${owner.pk}:${UNIT_B}`].sort());
    expect(orders.since).toBeGreaterThan(Math.floor(NOW / 1000) - 100 * 86400);
    expect(log.find(f => f.kinds[0] === 36604)!.authors).toEqual([owner.pk]);
    expect(log.find(f => f.kinds[0] === 30905)!.authors).toEqual([node.pk]);
  });

  it('answers "unknown" rather than 0 when no KIND 38888 relays are known', async () => {
    const empty = new Database(':memory:');
    initializeSchema(empty);
    empty.prepare(`INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, status) VALUES ('u', 'e', ?, 1, 'U', ?, 'active')`).run(owner.pk, owner.pk);
    expect(await foodCornerOpenCount(empty, owner.pk, { fetchEvents: fakeRelay([]), now: () => NOW }))
      .toEqual({ success: false, error: 'NO_RELAYS' });
    empty.close();
  });
});

describe('fetchAllPaged', () => {
  it('pages past the relays\' 500-per-REQ cap with an inclusive until', async () => {
    const many = Array.from({ length: 1203 }, (_, i) => ({ id: `id${i}`, kind: 36601, pubkey: 'p', created_at: 1000 + Math.floor(i / 3), tags: [] }));
    const got = await fetchAllPaged(fakeRelay(many) as any, { kinds: [36601] }, ['wss://r']);
    expect(got).toHaveLength(1203);
  });
});

describe('GET /api/food-corner/open-count', () => {
  let base = '';
  let server: any;
  let calls = 0;
  beforeAll(async () => {
    const app = express();
    const relay = fakeRelay([nodeEvent, order(UNIT_A, '2026-11-20T09:00:00+01:00')]);
    registerFoodCornerRoutes(app, db, { fetchEvents: async (f) => { calls++; return relay(f); }, now: () => NOW });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>(r => server.close(() => r())));

  it('refuses a hex that is not 64 hex characters', async () => {
    const r = await fetch(`${base}/api/food-corner/open-count?hex=nope`);
    expect(r.status).toBe(400);
  });

  it('answers the count and reuses it for a minute instead of asking the relays again', async () => {
    const first = await (await fetch(`${base}/api/food-corner/open-count?hex=${owner.pk}`)).json();
    const before = calls;
    const second = await (await fetch(`${base}/api/food-corner/open-count?hex=${owner.pk}`)).json();
    expect(first).toMatchObject({ success: true, count: 1 });
    expect(second).toEqual(first);
    expect(calls).toBe(before);
  });
});
