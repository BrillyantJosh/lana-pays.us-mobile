/**
 * Which app a business unit belongs to.
 *
 * A merchant's card can own several units: one opened on shop.lanapays.us and
 * used from this till, one opened on simple.lanapays.us. They are all KIND
 * 30901 events under the same owner, so listing "the units of this card" hands
 * each app the other's shops — a LANA-only shop appearing among the cash ones
 * here, and a cash till appearing in the LANA-only app.
 *
 * A unit registered through simple.lanapays.us is marked twice, at signing
 * time (lana-pays-simple/src/components/onboarding/BusinessUnitStep.tsx):
 *
 *   ['lana_only', 'true']
 *   ['unit_type', 'simple.lanapays.us']
 *
 * Both are checked, because shop's own edit form emits neither: a merchant who
 * later edits such a shop there would otherwise publish a replacement event
 * that silently moves the unit into this app. For the same reason the stored
 * columns are sticky — see the ingest in server/heartbeat.ts.
 *
 * This file is a mirror of the one in lana-pays-simple; the two apps must
 * agree on the boundary, so keep them identical apart from these comments.
 */

export const SIMPLE_UNIT_TYPE = 'simple.lanapays.us';

type Tagged = { tags?: unknown } | string | null | undefined;

/** Tags of a KIND 30901, whether it arrives parsed or as the stored raw JSON. */
function tagsOf(event: Tagged): string[][] {
  if (!event) return [];
  try {
    const parsed = typeof event === 'string' ? JSON.parse(event) : event;
    return Array.isArray(parsed?.tags) ? parsed.tags : [];
  } catch {
    return [];
  }
}

export function readUnitOrigin(rawEvent: Tagged): { unitType: string | null; lanaOnly: boolean } {
  const tags = tagsOf(rawEvent);
  const tag = (name: string) => tags.find(t => Array.isArray(t) && t[0] === name)?.[1];
  const unitType = tag('unit_type') || null;
  return { unitType, lanaOnly: String(tag('lana_only') || '').toLowerCase() === 'true' };
}

/** True when this unit was registered through simple.lanapays.us — i.e. NOT ours. */
export function isSimpleUnit(row: { unit_type?: string | null; lana_only?: number | null; raw_event?: string | null }): boolean {
  if (row.unit_type === SIMPLE_UNIT_TYPE || row.lana_only === 1) return true;
  // Rows ingested before the columns existed still carry the tags in the event.
  const { unitType, lanaOnly } = readUnitOrigin(row.raw_event);
  return unitType === SIMPLE_UNIT_TYPE || lanaOnly;
}

/**
 * SQL for "units that belong to simple.lanapays.us" — this app lists the
 * complement, NOT SIMPLE_UNIT_SQL. The raw_event fallback keeps rows
 * ingested before the columns existed visible without a backfill having to run
 * first, and costs nothing on a table this size.
 *
 * Every column is COALESCEd because SQL three-valued logic would otherwise make
 * this useless here: with a NULL unit_type the whole expression is NULL, and
 * `NOT NULL` is NULL — so the negation this app relies on would match no rows
 * at all and the till would show an empty list instead of its own shops.
 */
export const SIMPLE_UNIT_SQL = `(
  COALESCE(unit_type, '') = '${SIMPLE_UNIT_TYPE}'
  OR COALESCE(lana_only, 0) = 1
  OR COALESCE(raw_event, '') LIKE '%"unit_type","${SIMPLE_UNIT_TYPE}"%'
  OR COALESCE(raw_event, '') LIKE '%"lana_only","true"%'
)`;
