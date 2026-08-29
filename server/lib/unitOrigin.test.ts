// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { isSimpleUnit, readUnitOrigin, SIMPLE_UNIT_SQL, SIMPLE_UNIT_TYPE } from './unitOrigin';

/** A KIND 30901 as each app signs it. */
function event(tags: string[][]) {
  return JSON.stringify({ kind: 30901, pubkey: 'a'.repeat(64), tags });
}

const simpleEvent = event([
  ['d', 'unit-simple'], ['unit_id', 'unit-simple'], ['name', 'Simple shop'],
  ['lana_only', 'true'], ['unit_type', SIMPLE_UNIT_TYPE],
]);
// What shop.lanapays.us publishes: neither marker.
const shopEvent = event([
  ['d', 'unit-shop'], ['unit_id', 'unit-shop'], ['name', 'Cash shop'],
]);

describe('reading a unit\'s origin', () => {
  it('recognises what this app signs', () => {
    expect(readUnitOrigin(simpleEvent)).toEqual({ unitType: SIMPLE_UNIT_TYPE, lanaOnly: true });
  });

  it('leaves a shop unit unmarked', () => {
    expect(readUnitOrigin(shopEvent)).toEqual({ unitType: null, lanaOnly: false });
  });

  it('survives an unparseable or missing event', () => {
    expect(readUnitOrigin('not json')).toEqual({ unitType: null, lanaOnly: false });
    expect(readUnitOrigin(null)).toEqual({ unitType: null, lanaOnly: false });
  });

  it('classifies a row by its columns, or by the event when they are empty', () => {
    expect(isSimpleUnit({ unit_type: SIMPLE_UNIT_TYPE })).toBe(true);
    expect(isSimpleUnit({ lana_only: 1 })).toBe(true);
    // Ingested before the columns existed:
    expect(isSimpleUnit({ raw_event: simpleEvent })).toBe(true);
    expect(isSimpleUnit({ raw_event: shopEvent })).toBe(false);
    expect(isSimpleUnit({})).toBe(false);
  });
});

describe('the SQL the app lists units with', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE business_units (
    unit_id TEXT PRIMARY KEY, owner_hex TEXT, status TEXT,
    unit_type TEXT, lana_only INTEGER DEFAULT 0, raw_event TEXT
  )`);
  const owner = 'a'.repeat(64);
  const add = db.prepare('INSERT INTO business_units VALUES (?, ?, ?, ?, ?, ?)');
  add.run('unit-simple', owner, 'active', SIMPLE_UNIT_TYPE, 1, simpleEvent);
  add.run('unit-shop', owner, 'active', null, 0, shopEvent);
  // The same card, a unit ingested before the columns existed:
  add.run('unit-legacy', owner, 'active', null, 0, simpleEvent);

  const list = () => db.prepare(
    `SELECT unit_id FROM business_units WHERE status = 'active' AND ${SIMPLE_UNIT_SQL} AND owner_hex = ? ORDER BY unit_id`
  ).all(owner) as { unit_id: string }[];

  it('hides simple.lanapays.us shops from this till', () => {
    const mine = db.prepare(
      `SELECT unit_id FROM business_units WHERE status = 'active' AND NOT ${SIMPLE_UNIT_SQL} ORDER BY unit_id`
    ).all() as { unit_id: string }[];
    expect(mine.map(u => u.unit_id)).toEqual(['unit-shop']);
  });

  it('is the exact complement of what the other app shows', () => {
    expect(list().map(u => u.unit_id)).toEqual(['unit-legacy', 'unit-simple']);
  });
});
