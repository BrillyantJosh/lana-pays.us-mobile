// @vitest-environment node
/**
 * POST /api/cash-sale-number: the automatic sale number of a shop without a
 * company (KIND 30901 payout_account "none", 23 Nov 2026).
 *
 * Such a shop issues no invoices. The till sends what was sold plus this
 * number, so two sales described the same way are not refused by the brain as
 * one invoice used twice. One counter per unit, so two phones of one shop
 * never share a number; a shop with a company gets none (its invoices number
 * themselves); only the owner or staff may ask, and the KIND 87058 gate is
 * asked first.
 *
 * Real express server, real schema in memory.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'net';
import { initializeSchema } from './db/schema.js';
import { ensureExclusionTables } from './lib/personExclusion.js';
import { registerSaleNumberRoutes, allocateSaleNumber, saleNumberDate } from './saleNumbers.js';

const NO_COMPANY = 'a'.repeat(32);
const NO_COMPANY_2 = 'c'.repeat(32);
const COMPANY = 'b'.repeat(32);
const SIMPLE = 'd'.repeat(32);
const OWNER = '1'.repeat(64);
const STAFF = '2'.repeat(64);
const STRANGER = '3'.repeat(64);

let db: Database.Database;
let base = '';
let httpServer: any;
const quiet = { log: console.log, warn: console.warn, error: console.error };

const event = (unitId: string, tags: string[][]) => JSON.stringify({ kind: 30901, tags: [['d', unitId], ...tags], content: '' });

beforeAll(async () => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  db = new Database(':memory:');
  initializeSchema(db);
  ensureExclusionTables(db);
  const unit = db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event, unit_type, lana_only)
    VALUES (?, 'ev', ?, 1, 'Shop', ?, ?, 'EUR', 'active', ?, ?, ?)
  `);
  const none = [['payout_account', 'none']];
  unit.run(NO_COMPANY, OWNER, OWNER, JSON.stringify([OWNER, STAFF]), event(NO_COMPANY, none), null, 0);
  unit.run(NO_COMPANY_2, OWNER, OWNER, JSON.stringify([OWNER]), event(NO_COMPANY_2, none), null, 0);
  unit.run(COMPANY, OWNER, OWNER, JSON.stringify([OWNER]), event(COMPANY, [['receiver_type', 'company']]), null, 0);
  unit.run(SIMPLE, OWNER, OWNER, JSON.stringify([OWNER]), event(SIMPLE, [...none, ['unit_type', 'simple.lanapays.us'], ['lana_only', 'true']]), 'simple.lanapays.us', 1);

  const app = express();
  app.use(express.json());
  registerSaleNumberRoutes(app, db);
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => httpServer.once('listening', r));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(r => httpServer.close(r));
  db.close();
  Object.assign(console, quiet);
});

beforeEach(() => {
  db.prepare('DELETE FROM unit_sale_numbers').run();
  db.prepare('DELETE FROM person_exclusions').run();
});

async function ask(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}/api/cash-sale-number`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as any };
}

const lastNumber = (unitId: string) =>
  (db.prepare('SELECT last_number FROM unit_sale_numbers WHERE unit_id = ?').get(unitId) as any)?.last_number ?? null;

describe('allocateSaleNumber', () => {
  it('1, 2, 3 … for one unit, and each unit counts on its own', () => {
    expect([1, 2, 3].map(() => allocateSaleNumber(db, NO_COMPANY))).toEqual([1, 2, 3]);
    expect(allocateSaleNumber(db, NO_COMPANY_2)).toBe(1);
    expect(allocateSaleNumber(db, NO_COMPANY)).toBe(4);
  });

  it('never hands the same number out twice, however many are asked for', () => {
    const got = Array.from({ length: 250 }, () => allocateSaleNumber(db, NO_COMPANY));
    expect(new Set(got).size).toBe(250);
    expect(got[249]).toBe(250);
  });
});

describe('saleNumberDate — the day, in Slovenian time (the server runs in UTC)', () => {
  it.each([
    ['2026-11-23T08:00:00Z', '23.11.2026'],
    ['2026-11-23T22:59:59Z', '23.11.2026'],
    ['2026-11-23T23:00:00Z', '24.11.2026'], // midnight CET
    ['2026-07-01T21:59:59Z', '01.07.2026'],
    ['2026-07-01T22:00:00Z', '02.07.2026'], // midnight CEST
    ['2026-12-31T23:30:00Z', '01.01.2027'],
  ])('%s is %s', (iso, day) => {
    expect(saleNumberDate(new Date(iso))).toBe(day);
  });
});

describe('POST /api/cash-sale-number', () => {
  it('the owner of a shop without a company gets 1, then 2, with today\'s date', async () => {
    const a = await ask({ unit_id: NO_COMPANY, staff_hex: OWNER });
    const b = await ask({ unit_id: NO_COMPANY }, { 'x-lana-hex': OWNER });
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ success: true, number: 1, date: saleNumberDate() });
    expect(b.json.number).toBe(2);
  });

  it('staff of the shop count on the same counter: two phones never share a number', async () => {
    const owner = await ask({ unit_id: NO_COMPANY, staff_hex: OWNER });
    const staff = await ask({ unit_id: NO_COMPANY, staff_hex: STAFF });
    expect([owner.json.number, staff.json.number]).toEqual([1, 2]);
  });

  it('a shop with a company gets no number, and nothing is counted', async () => {
    const r = await ask({ unit_id: COMPANY, staff_hex: OWNER });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ success: false, code: 'SALE_NUMBER_NOT_USED' });
    expect(lastNumber(COMPANY)).toBeNull();
  });

  it.each([
    ['somebody who is not owner or staff', { unit_id: NO_COMPANY, staff_hex: STRANGER }],
    ['nobody named at all', { unit_id: NO_COMPANY }],
    ['a unit this till does not know', { unit_id: 'f'.repeat(32), staff_hex: OWNER }],
    ['a simple.lanapays.us unit (not this app\'s)', { unit_id: SIMPLE, staff_hex: OWNER }],
  ])('%s: 403, and nothing is counted', async (_label, body) => {
    const r = await ask(body);
    expect(r.status).toBe(403);
    expect(lastNumber(NO_COMPANY)).toBeNull();
    expect(lastNumber(SIMPLE)).toBeNull();
  });

  it.each([
    ['missing', {}],
    ['an array', { unit_id: [NO_COMPANY] }],
    ['a number', { unit_id: 1 }],
  ])('unit_id %s: 400', async (_label, body) => {
    const r = await ask({ ...body, staff_hex: OWNER });
    expect(r.status).toBe(400);
    expect(lastNumber(NO_COMPANY)).toBeNull();
  });

  it('a standing KIND 87058 decision against the person asking: refused by the gate, nothing counted', async () => {
    db.prepare(`
      INSERT INTO person_exclusions (d_tag, person_hex, active, ground, since, event_id, event_created_at)
      VALUES ('d-staff', ?, 1, 'ground', 1, 'ev', 1)
    `).run(STAFF);
    const r = await ask({ unit_id: NO_COMPANY, staff_hex: STAFF });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('PERSON_EXCLUDED');
    expect(lastNumber(NO_COMPANY)).toBeNull();
  });
});
