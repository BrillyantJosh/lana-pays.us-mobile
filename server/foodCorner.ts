/**
 * GET /api/food-corner/open-count?hex=<owner hex>
 *
 * Kati (caretaker), The Rose, 24. 11. 2026: suppliers should learn in the till
 * that they have orders on Točka obilja (mejmosefajn.org). Brilly: "naredi
 * obvestilo v mobile.lanapays.us".
 *
 * Read-only and display-only: counts the 36601 orders the merchant's own units
 * still have to bring (see lib/foodCornerOpen.ts for what "open" means) and
 * says where to handle them. No buyer, no amount, no state change anywhere.
 *
 * Only units the hex OWNS: the supplier page on mejmosefajn.org shows a unit's
 * orders to its owner's key only, so a staff member could not act on the count.
 */

import type Database from 'better-sqlite3';
import type { Express } from 'express';
import { HEX64 } from './lib/merchantAuth.js';
import { SIMPLE_UNIT_SQL } from './lib/unitOrigin.js';
import { gate } from './lib/exclusionGate.js';
import { fetchEventsFromRelays, verifyNostrEvent } from './lib/nostr.js';
import {
  FOOD_CORNER_DELIVERY_KIND,
  FOOD_CORNER_MAX_LEAD_WEEKS,
  FOOD_CORNER_NODE_KIND,
  FOOD_CORNER_ORDER_KIND,
  FOOD_CORNER_SUPPLIER_URL,
  openFoodCornerOrders,
  type FoodCornerEvent,
} from './lib/foodCornerOpen.js';

type FetchEvents = (filter: Record<string, unknown>, relays?: string[], timeout?: number) => Promise<any[]>;

export interface FoodCornerDeps {
  fetchEvents?: FetchEvents;
  now?: () => number;
  /** How long one merchant's answer is reused; the home screen polls every minute. */
  cacheMs?: number;
}

export interface FoodCornerOpenCount {
  success: true;
  count: number;
  units: { unit_id: string; name: string; count: number }[];
  /**
   * The soonest cycle's pickup day, as the supplier and Točka lists count it.
   * The till does not show it: for an order placed after the Monday cutoff the
   * buyer on mejmosefajn.org is told the NEXT pickup, so the two disagree.
   */
  next_delivery: string | null;
  link: string;
}

const RELAY_PAGE = 500;
const MAX_PAGES = 10;
const READ_TIMEOUT_MS = 8000;

/**
 * Every event for `filter`, past the relays' 500-per-REQ cap: page back with an
 * INCLUSIVE `until` and de-duplicate. A merged page under 500 means no relay
 * was cut off (each relay answers at most 500, the merge is at least as big).
 */
export async function fetchAllPaged(fetchEvents: FetchEvents, filter: Record<string, unknown>, relays: string[]): Promise<any[]> {
  const byId = new Map<string, any>();
  let until: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const f: Record<string, unknown> = { ...filter, limit: RELAY_PAGE };
    if (until !== undefined) f.until = until;
    const events = await fetchEvents(f, relays, READ_TIMEOUT_MS);
    let added = 0;
    for (const e of events) if (e?.id && !byId.has(e.id)) { byId.set(e.id, e); added++; }
    if (events.length < RELAY_PAGE || added === 0) break;
    until = Math.min(...events.map(e => e.created_at));
  }
  return [...byId.values()];
}

function kind38888Relays(db: Database.Database): string[] {
  try {
    const row = db.prepare('SELECT relays FROM kind_38888 ORDER BY id DESC LIMIT 1').get() as any;
    const parsed = row ? JSON.parse(row.relays || '[]') : [];
    return Array.isArray(parsed) ? parsed.filter((r: unknown) => typeof r === 'string' && /^wss?:\/\//.test(r)) : [];
  } catch {
    return [];
  }
}

export function ownedUnits(db: Database.Database, hex: string): { unit_id: string; name: string; owner_hex: string }[] {
  if (!HEX64.test(hex || '')) return [];
  return db.prepare(`
    SELECT unit_id, name, owner_hex FROM business_units
    WHERE status = 'active' AND NOT ${SIMPLE_UNIT_SQL} AND owner_hex = ?
    ORDER BY name ASC
  `).all(hex) as any[];
}

export async function foodCornerOpenCount(
  db: Database.Database,
  hex: string,
  deps: FoodCornerDeps = {},
): Promise<FoodCornerOpenCount | { success: false; error: string }> {
  const fetchEvents = deps.fetchEvents || fetchEventsFromRelays;
  const nowMs = (deps.now || Date.now)();
  const empty: FoodCornerOpenCount = { success: true, count: 0, units: [], next_delivery: null, link: FOOD_CORNER_SUPPLIER_URL };

  const units = ownedUnits(db, hex);
  if (units.length === 0) return empty;
  const relays = kind38888Relays(db);
  if (relays.length === 0) return { success: false, error: 'NO_RELAYS' };

  const refOf = (u: { unit_id: string; owner_hex: string }) => `30901:${u.owner_hex}:${u.unit_id}`;
  const sellerRefs = units.map(refOf);
  // An order's cycle ends at most 12 weeks (lead time) + one cycle after it was
  // placed; anything older cannot be open. A day of slack for the time zone.
  const nowSec = Math.floor(nowMs / 1000);
  const since = nowSec - (FOOD_CORNER_MAX_LEAD_WEEKS * 7 + 8) * 86400;

  const [rawOrders, rawDeliveries] = await Promise.all([
    fetchAllPaged(fetchEvents, { kinds: [FOOD_CORNER_ORDER_KIND], '#a': sellerRefs, since }, relays),
    fetchAllPaged(fetchEvents, { kinds: [FOOD_CORNER_DELIVERY_KIND], authors: [hex], since }, relays),
  ]);
  const orders = rawOrders.filter(e => verifyNostrEvent(e, [FOOD_CORNER_ORDER_KIND], nowSec)) as FoodCornerEvent[];
  const deliveries = rawDeliveries.filter(e => verifyNostrEvent(e, [FOOD_CORNER_DELIVERY_KIND], nowSec)) as FoodCornerEvent[];

  // The Točke these orders go to — for their pickup weekday, which sets the cycle.
  const nodeAuthors = new Set<string>();
  for (const o of orders) {
    const ref = (o.tags.find(t => t[0] === 'distribution_point') || [])[1] || '';
    const pubkey = ref.split(':')[1] || '';
    if (ref.startsWith(`${FOOD_CORNER_NODE_KIND}:`) && HEX64.test(pubkey)) nodeAuthors.add(pubkey.toLowerCase());
  }
  const nodes = nodeAuthors.size === 0 ? [] : (await fetchAllPaged(
    fetchEvents, { kinds: [FOOD_CORNER_NODE_KIND], authors: [...nodeAuthors] }, relays,
  )).filter(e => verifyNostrEvent(e, [FOOD_CORNER_NODE_KIND], nowSec)) as FoodCornerEvent[];

  const open = openFoodCornerOrders({ orders, deliveries, nodes, sellerRefs, nowMs });
  const perUnit = new Map<string, number>();
  for (const o of open) perUnit.set(o.sellerRef, (perUnit.get(o.sellerRef) || 0) + 1);

  return {
    success: true,
    count: open.length,
    units: units
      .filter(u => perUnit.has(refOf(u)))
      .map(u => ({ unit_id: u.unit_id, name: u.name, count: perUnit.get(refOf(u)) || 0 })),
    next_delivery: open.length ? open.map(o => o.deliveryDate).sort()[0] : null,
    link: FOOD_CORNER_SUPPLIER_URL,
  };
}

export function registerFoodCornerRoutes(app: Express, db: Database.Database, deps: FoodCornerDeps = {}): void {
  const cacheMs = deps.cacheMs ?? 60_000;
  const now = deps.now || Date.now;
  const cache = new Map<string, { at: number; value: Awaited<ReturnType<typeof foodCornerOpenCount>> }>();
  const inFlight = new Map<string, Promise<Awaited<ReturnType<typeof foodCornerOpenCount>>>>();

  app.get('/api/food-corner/open-count', gate(db, req => req.query.hex), async (req, res) => {
    const hex = String(req.query.hex || '').toLowerCase();
    if (!HEX64.test(hex)) return res.status(400).json({ success: false, error: 'hex must be 64 hex characters' });

    const hit = cache.get(hex);
    if (hit && now() - hit.at < cacheMs) return res.json(hit.value);

    let pending = inFlight.get(hex);
    if (!pending) {
      pending = foodCornerOpenCount(db, hex, deps).finally(() => inFlight.delete(hex));
      inFlight.set(hex, pending);
    }
    try {
      const value = await pending;
      if (value.success) {
        cache.set(hex, { at: now(), value });
        // Keep the cache from growing without bound on a long-running server.
        if (cache.size > 5000) for (const [k, v] of cache) if (now() - v.at >= cacheMs) cache.delete(k);
      }
      res.json(value);
    } catch (error: any) {
      console.error(`Food corner count failed for ${hex.slice(0, 8)}:`, error?.message);
      res.json({ success: false, error: 'READ_FAILED' });
    }
  });
}
