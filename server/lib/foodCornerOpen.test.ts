// @vitest-environment node
/**
 * Točka obilja: which orders a supplier still has to bring.
 *
 * The cycle rule is mejmosefajn's, so it runs mejmosefajn's own vectors:
 * server/fixtures/foodCornerLeadTime.vectors.json is a byte-identical copy of
 * mejmosefajnver3 scripts/foodCornerLeadTime.vectors.json (also shared with
 * being3). The cycle starts below are the real ones the supplier page wrote
 * into its KIND 36604 events (relays, 24. 11. 2026).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  foodCornerCycle,
  openFoodCornerOrders,
  parseLeadTimeWeeks,
  type FoodCornerEvent,
} from './foodCornerOpen.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(fs.readFileSync(path.resolve(here, '../fixtures/foodCornerLeadTime.vectors.json'), 'utf8'));
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const WEEK_MS = 7 * 86400 * 1000;

describe('parseLeadTimeWeeks (mejmosefajn vectors)', () => {
  for (const [raw, want] of vectors.parseLeadTimeWeeks) {
    it(`${JSON.stringify(raw)} → ${want}`, () => expect(parseLeadTimeWeeks(raw)).toBe(want));
  }
});

describe('foodCornerCycle (mejmosefajn cycle vectors, Europe/Ljubljana)', () => {
  for (const v of vectors.cycleOffset) {
    it(v.why, () => {
      const current = foodCornerCycle(sec(v.now), 0, v.anchor);
      const order = foodCornerCycle(sec(v.placed), v.lead, v.anchor);
      const offset = -Math.round((order.startMs - current.startMs) / WEEK_MS) || 0;
      expect(offset).toBe(v.offset);
    });
  }

  it('starts on the same second the supplier page wrote into 36604 (Thursday 12. 11. 2026, CET)', () => {
    // An order of Monday 16. 11. at 10:00 → cycle Thu 12. 11. → Thu 19. 11.; the
    // supplier published its "delivered" for cycle_start 1794438000 on 18. 11.
    const c = foodCornerCycle(sec('2026-11-16T10:00:00+01:00'), 0, 'thursday');
    expect(c.startMs / 1000).toBe(1794438000);
    expect(c.deliveryDate).toBe('2026-11-19');
  });

  it('starts on the same second as a summer-time 36604 (Thursday 22. 10. 2026, CEST)', () => {
    const c = foodCornerCycle(sec('2026-10-26T09:00:00+01:00'), 0, 'thursday');
    expect(c.startMs / 1000).toBe(1792620000);
    // The cycle crosses the switch to winter time: it is 7 days and 1 hour long.
    expect(c.endMs - c.startMs).toBe(WEEK_MS + 3600 * 1000);
  });

  it('puts a Thursday 00:30 order in the NEW cycle, which the server clock (UTC) would not', () => {
    const c = foodCornerCycle(sec('2026-11-26T00:30:00+01:00'), 0, 'thursday');
    expect(c.deliveryDate).toBe('2026-12-03');
  });

  it('moves an order with a two-week lead time two cycles later', () => {
    const c = foodCornerCycle(sec('2026-11-23T10:00:00+01:00'), 2, 'thursday');
    expect(c.deliveryDate).toBe('2026-12-10');
  });
});

// ── openFoodCornerOrders ──────────────────────────────────────────────────

const OWNER = 'a'.repeat(64);
const OTHER_OWNER = 'b'.repeat(64);
const BUYER = 'c'.repeat(64);
const NODE_PK = 'd'.repeat(64);
const MY_UNIT = `30901:${OWNER}:unit1`;
const MY_SECOND_UNIT = `30901:${OWNER}:unit2`;
const OTHER_UNIT = `30901:${OTHER_OWNER}:unit9`;
const NODE = `30905:${NODE_PK}:eko-tocka`;
const FRIDAY_NODE = `30905:${NODE_PK}:petek`;

let n = 0;
const order = (o: { seller?: string; node?: string; at: string; d?: string; status?: string; lead?: string; buyer?: string }): FoodCornerEvent => ({
  id: String(++n).padStart(64, '0'),
  pubkey: o.buyer || BUYER,
  created_at: sec(o.at),
  kind: 36601,
  tags: [
    ['d', o.d || `o-${n}`],
    ['a', o.seller || MY_UNIT],
    ['total', '12.00', 'EUR'],
    ['status', o.status || 'placed'],
    ['distribution_point', o.node ?? NODE],
    ...(o.lead ? [['lead_time_weeks', o.lead]] : []),
  ],
});
const delivery = (o: { by?: string; node?: string; cycleStart: number; at: string }): FoodCornerEvent => ({
  id: String(++n).padStart(64, '0'),
  pubkey: o.by || OWNER,
  created_at: sec(o.at),
  kind: 36604,
  tags: [['d', `x-${n}`], ['a', o.node || NODE], ['cycle_start', String(o.cycleStart)], ['delivered', 'l', '3', 'kg']],
});
const node = (d: string, pickupDay: string): FoodCornerEvent => ({
  id: String(++n).padStart(64, '0'),
  pubkey: NODE_PK,
  created_at: sec('2026-09-01T10:00:00+02:00'),
  kind: 30905,
  tags: [['d', d], ['name', d], ['pickup', 'p1', 'Pri hiši', '', '', pickupDay, '18:00-20:00']],
});

// Tuesday 24. 11. 2026, 10:00 — the current cycle is Thu 19. 11. → Thu 26. 11.
const NOW = new Date('2026-11-24T10:00:00+01:00').getTime();
const CYCLE_19_11 = 1795042800; // Thu 19. 11. 2026 00:00 CET
const nodes = [node('eko-tocka', 'thursday'), node('petek', 'friday')];
const run = (orders: FoodCornerEvent[], deliveries: FoodCornerEvent[] = [], sellerRefs = [MY_UNIT, MY_SECOND_UNIT]) =>
  openFoodCornerOrders({ orders, deliveries, nodes, sellerRefs, nowMs: NOW });

describe('openFoodCornerOrders', () => {
  it('counts this cycle\'s orders for my units and nobody else\'s', () => {
    const open = run([
      order({ at: '2026-11-20T09:00:00+01:00' }),
      order({ at: '2026-11-23T17:00:00+01:00', seller: MY_SECOND_UNIT }),
      order({ at: '2026-11-23T17:00:00+01:00', seller: OTHER_UNIT }),
    ]);
    expect(open.map(o => o.sellerRef).sort()).toEqual([MY_UNIT, MY_SECOND_UNIT].sort());
    expect(open.every(o => o.deliveryDate === '2026-11-26')).toBe(true);
  });

  it('drops orders whose cycle has ended', () => {
    expect(run([order({ at: '2026-11-18T20:00:00+01:00' })])).toEqual([]);
  });

  it('keeps an order whose lead time puts it in a later cycle', () => {
    const open = run([order({ at: '2026-11-12T09:00:00+01:00', lead: '2' })]);
    expect(open).toHaveLength(1);
    expect(open[0].deliveryDate).toBe('2026-12-03');
  });

  it('reads only the newest version of an order: cancelled is not open', () => {
    const open = run([
      order({ at: '2026-11-20T09:00:00+01:00', d: 'o-same' }),
      order({ at: '2026-11-21T09:00:00+01:00', d: 'o-same', status: 'cancelled' }),
    ]);
    expect(open).toEqual([]);
  });

  it('stops counting once I published "delivered" for that point and cycle after the order', () => {
    const orders = [order({ at: '2026-11-20T09:00:00+01:00' })];
    expect(run(orders, [delivery({ cycleStart: CYCLE_19_11, at: '2026-11-25T08:00:00+01:00' })])).toEqual([]);
  });

  it('still counts an order that came in after my "delivered"', () => {
    const orders = [order({ at: '2026-11-23T17:00:00+01:00' })];
    expect(run(orders, [delivery({ cycleStart: CYCLE_19_11, at: '2026-11-22T08:00:00+01:00' })])).toHaveLength(1);
  });

  it('ignores a "delivered" by someone else, for another point, or for another cycle', () => {
    const orders = [order({ at: '2026-11-20T09:00:00+01:00' })];
    expect(run(orders, [
      delivery({ by: OTHER_OWNER, cycleStart: CYCLE_19_11, at: '2026-11-25T08:00:00+01:00' }),
      delivery({ node: FRIDAY_NODE, cycleStart: CYCLE_19_11, at: '2026-11-25T08:00:00+01:00' }),
      delivery({ cycleStart: CYCLE_19_11 - 7 * 86400, at: '2026-11-25T08:00:00+01:00' }),
    ])).toHaveLength(1);
  });

  it('uses the point\'s own pickup day: a Friday point delivers on Friday', () => {
    const open = run([order({ at: '2026-11-24T08:00:00+01:00', node: FRIDAY_NODE })]);
    expect(open).toHaveLength(1);
    expect(open[0].deliveryDate).toBe('2026-11-27');
  });

  it('falls back to Thursday for an order without a point, like the supplier page', () => {
    const open = run([order({ at: '2026-11-24T08:00:00+01:00', node: '' })]);
    expect(open).toHaveLength(1);
    expect(open[0].deliveryDate).toBe('2026-11-26');
  });

  it('returns no buyer and no amount', () => {
    const [o] = run([order({ at: '2026-11-20T09:00:00+01:00' })]);
    expect(Object.keys(o).sort()).toEqual(['deliveryDate', 'nodeRef', 'sellerRef']);
  });
});
