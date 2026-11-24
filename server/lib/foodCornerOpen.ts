/**
 * Točka obilja (mejmosefajn.org /food-corner): which orders a supplier still has
 * to bring. Read-only — nothing here changes an order, a delivery or money.
 *
 * The orders are public, signed Nostr events on the KIND 38888 relays:
 *   36601  order, by the BUYER. `a` = the seller's unit, "30901:<owner>:<unit_id>";
 *          `distribution_point` = the Točka, "30905:<pubkey>:<d>".
 *   36604  what the SUPPLIER brought to a Točka for one cycle (`a` = the Točka,
 *          `cycle_start` = the cycle's first midnight, epoch seconds).
 *   30905  the Točka itself; its first `pickup` tag names the pickup weekday.
 *
 * "Open" mirrors what the supplier sees on mejmosefajn.org/food-corner/supplier
 * (src/pages/food-corner/FoodCornerSupplier.tsx + src/lib/foodCorner.ts there):
 *   - every order sits in a weekly cycle running from the Točka's pickup weekday
 *     to the next one (local midnights), moved later by its `lead_time_weeks`;
 *     the cycle is delivered on its last pickup day;
 *   - an order counts while its cycle has not ended yet (the supplier page shows
 *     exactly that cycle and the later ones);
 *   - it stops counting once the supplier has published "Objavi dostavljeno"
 *     (36604) for that Točka and cycle AFTER the order came in, or when the
 *     buyer's latest version of the order says `status=cancelled`.
 *
 * Cycles are computed in Europe/Ljubljana: the supplier page computes them in
 * the supplier's browser, and every Točka so far is in Slovenia. The server runs
 * in UTC, which would move every cycle boundary by one or two hours and miss the
 * 36604 `cycle_start` it has to match.
 */

export const FOOD_CORNER_TZ = 'Europe/Ljubljana';
export const FOOD_CORNER_SUPPLIER_URL = 'https://mejmosefajn.org/food-corner/supplier';
export const FOOD_CORNER_ORDER_KIND = 36601;
export const FOOD_CORNER_DELIVERY_KIND = 36604;
export const FOOD_CORNER_NODE_KIND = 30905;
/** Longest "Rok dobave" a supplier can choose (twin of FOOD_CORNER_MAX_LEAD_WEEKS on mejmosefajn). */
export const FOOD_CORNER_MAX_LEAD_WEEKS = 12;
/** The supplier page falls back to Thursday when a Točka names no pickup day. */
const DEFAULT_ANCHOR_DAY = 'thursday';

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT_WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface FoodCornerEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content?: string;
  sig?: string;
}

interface CivilDate { y: number; m: number; d: number }

function tag(event: FoodCornerEvent, name: string): string {
  const found = (event.tags || []).find(t => Array.isArray(t) && t[0] === name);
  return typeof found?.[1] === 'string' ? found[1] : '';
}

/** Same rule as mejmosefajn parseLeadTimeWeeks: only a plain whole number counts, capped at 12. */
export function parseLeadTimeWeeks(raw: unknown): number {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) return 0;
  return Math.min(FOOD_CORNER_MAX_LEAD_WEEKS, Number.parseInt(text, 10));
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

function wallClock(ms: number, tz: string) {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    hh: Number(parts.hour), mm: Number(parts.minute), ss: Number(parts.second),
    wd: SHORT_WEEKDAYS[parts.weekday] ?? 0,
  };
}

/** The calendar day `ms` falls on in `tz`. */
export function civilDateIn(ms: number, tz = FOOD_CORNER_TZ): CivilDate {
  const w = wallClock(ms, tz);
  return { y: w.y, m: w.m, d: w.d };
}

function addDays(c: CivilDate, days: number): CivilDate {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayOf(c: CivilDate): number {
  return new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
}

/** How far `tz` is ahead of UTC at instant `ms`. */
function offsetMs(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant of 00:00 on calendar day `c` in `tz` (DST never switches at midnight there). */
export function zonedMidnightMs(c: CivilDate, tz = FOOD_CORNER_TZ): number {
  const guess = Date.UTC(c.y, c.m - 1, c.d);
  let ms = guess - offsetMs(guess, tz);
  ms = guess - offsetMs(ms, tz);
  return ms;
}

export function isoDate(c: CivilDate): string {
  return `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
}

/**
 * The cycle an order belongs to — mejmosefajn foodCornerOrderCycleTime +
 * foodCornerWeekRange: the day it was placed, moved `leadWeeks` weeks on the
 * calendar, then the week from the most recent `anchorDay` (that day included)
 * to the next one. An unknown weekday name falls back to Monday, as there.
 */
export function foodCornerCycle(createdAtSec: number, leadWeeks: number, anchorDay: string, tz = FOOD_CORNER_TZ) {
  const placed = civilDateIn(createdAtSec * 1000, tz);
  const cycleDay = addDays(placed, 7 * Math.max(0, leadWeeks || 0));
  let anchor = WEEKDAY_NAMES.indexOf((anchorDay || '').trim().toLowerCase());
  if (anchor < 0) anchor = 1;
  const sinceAnchor = (weekdayOf(cycleDay) - anchor + 7) % 7;
  const start = addDays(cycleDay, -sinceAnchor);
  const end = addDays(start, 7);
  return {
    startMs: zonedMidnightMs(start, tz),
    endMs: zonedMidnightMs(end, tz),
    /** The pickup day this cycle is delivered on. */
    deliveryDate: isoDate(end),
  };
}

function parseRef(ref: string): { kind: string; pubkey: string; d: string } | null {
  const first = ref.indexOf(':');
  if (first === -1) return null;
  const second = ref.indexOf(':', first + 1);
  if (second === -1) return null;
  return { kind: ref.slice(0, first), pubkey: ref.slice(first + 1, second), d: ref.slice(second + 1) };
}

/** Newest version per (kind, author, d) — these are all addressable events. */
function latestByAddress(events: FoodCornerEvent[]): FoodCornerEvent[] {
  const byKey = new Map<string, FoodCornerEvent>();
  for (const e of events) {
    const d = tag(e, 'd');
    if (!d) continue;
    const key = `${e.kind}:${e.pubkey}:${d}`;
    const prev = byKey.get(key);
    if (!prev || e.created_at > prev.created_at) byKey.set(key, e);
  }
  return [...byKey.values()];
}

/** Pickup weekday per Točka ref "30905:<pubkey>:<d>", from the newest 30905 its own author signed. */
export function nodeAnchorDays(nodes: FoodCornerEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of latestByAddress(nodes.filter(e => e.kind === FOOD_CORNER_NODE_KIND))) {
    const pickup = (n.tags || []).find(t => Array.isArray(t) && t[0] === 'pickup');
    out.set(`${FOOD_CORNER_NODE_KIND}:${n.pubkey}:${tag(n, 'd')}`, typeof pickup?.[5] === 'string' ? pickup[5] : '');
  }
  return out;
}

export interface OpenFoodCornerOrder {
  sellerRef: string;
  nodeRef: string;
  deliveryDate: string;
}

/**
 * The orders a supplier still has to bring, for the unit refs in `sellerRefs`
 * ("30901:<owner>:<unit_id>"). Events must already be signature-checked.
 * Returns no buyer and no amount — only which unit, which Točka and the day.
 */
export function openFoodCornerOrders(input: {
  orders: FoodCornerEvent[];
  deliveries: FoodCornerEvent[];
  nodes: FoodCornerEvent[];
  sellerRefs: string[];
  nowMs: number;
  tz?: string;
}): OpenFoodCornerOrder[] {
  const tz = input.tz || FOOD_CORNER_TZ;
  const sellers = new Set(input.sellerRefs);
  const anchors = nodeAnchorDays(input.nodes);

  // Each supplier's "delivered" per (Točka, cycle start): the newest one counts.
  const delivered = new Map<string, number>();
  for (const d of input.deliveries) {
    if (d.kind !== FOOD_CORNER_DELIVERY_KIND) continue;
    const nodeRef = tag(d, 'a');
    const cycleStart = Number.parseInt(tag(d, 'cycle_start'), 10);
    if (!nodeRef || !Number.isFinite(cycleStart)) continue;
    const key = `${d.pubkey}|${nodeRef}|${cycleStart}`;
    delivered.set(key, Math.max(delivered.get(key) ?? 0, d.created_at));
  }

  const open: OpenFoodCornerOrder[] = [];
  for (const order of latestByAddress(input.orders.filter(e => e.kind === FOOD_CORNER_ORDER_KIND))) {
    const sellerRef = tag(order, 'a');
    if (!sellers.has(sellerRef)) continue;
    const seller = parseRef(sellerRef);
    if (!seller || seller.kind !== '30901') continue;
    if ((tag(order, 'status') || 'placed') === 'cancelled') continue;

    const nodeRef = tag(order, 'distribution_point');
    const anchorDay = anchors.get(nodeRef) || DEFAULT_ANCHOR_DAY;
    const cycle = foodCornerCycle(order.created_at, parseLeadTimeWeeks(tag(order, 'lead_time_weeks')), anchorDay, tz);
    if (input.nowMs >= cycle.endMs) continue;

    const deliveredAt = delivered.get(`${seller.pubkey}|${nodeRef}|${Math.floor(cycle.startMs / 1000)}`);
    if (deliveredAt !== undefined && deliveredAt >= order.created_at) continue;

    open.push({ sellerRef, nodeRef, deliveryDate: cycle.deliveryDate });
  }
  return open;
}
