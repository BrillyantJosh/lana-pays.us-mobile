// @vitest-environment node
/**
 * POST /api/cash-sale-recorded: has the brain recorded a cash sale of a shop
 * without a company with exactly this text? (review, 23 Nov 2026)
 *
 * The till asks it about a sale it sent but never heard back about, before it
 * lets the seller start that sale again with other words or another number:
 * the brain's only guard against one cash sale recorded twice is the text.
 * So the answer is only ever what the brain said. When the brain cannot be
 * asked, or says something else, it is 503 ("cannot tell"), never "no".
 *
 * Real express server, real schema in memory, a fake brain.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'net';
import { initializeSchema } from './db/schema.js';
import { ensureExclusionTables } from './lib/personExclusion.js';
import { registerSaleNumberRoutes } from './saleNumbers.js';

const NO_COMPANY = 'a'.repeat(32);
const COMPANY = 'b'.repeat(32);
const OWNER = '1'.repeat(64);
const STAFF = '2'.repeat(64);
const STRANGER = '3'.repeat(64);
const TEXT = 'jajca (#7, 23.11.2026)';

let db: Database.Database;
let base = '';
let httpServer: any;
const quiet = { log: console.log, warn: console.warn, error: console.error };

/** What the fake brain does with the next question. */
let brain: { status: number; body: any } | 'down';
let asked: Array<{ url: string; body: any; auth: string | null }> = [];

const fakeFetch = (async (url: string, init: any) => {
  asked.push({ url, body: JSON.parse(init.body), auth: init.headers?.Authorization ?? null });
  if (brain === 'down') throw new TypeError('fetch failed');
  const b = brain;
  return { ok: b.status >= 200 && b.status < 300, status: b.status, json: async () => b.body } as Response;
}) as unknown as typeof fetch;

const event = (unitId: string, tags: string[][]) => JSON.stringify({ kind: 30901, tags: [['d', unitId], ...tags], content: '' });

beforeAll(async () => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  db = new Database(':memory:');
  initializeSchema(db);
  ensureExclusionTables(db);
  const unit = db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event, unit_type, lana_only)
    VALUES (?, 'ev', ?, 1, 'Shop', ?, ?, 'EUR', 'active', ?, NULL, 0)
  `);
  unit.run(NO_COMPANY, OWNER, OWNER, JSON.stringify([OWNER, STAFF]), event(NO_COMPANY, [['payout_account', 'none']]));
  unit.run(COMPANY, OWNER, OWNER, JSON.stringify([OWNER]), event(COMPANY, [['receiver_type', 'company']]));
  const app = express();
  app.use(express.json());
  registerSaleNumberRoutes(app, db, { brainUrl: 'http://brain.test', brainKey: 'test-key', fetchImpl: fakeFetch });
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
  db.prepare('DELETE FROM person_exclusions').run();
  brain = { status: 200, body: { duplicate: false } };
  asked = [];
});

async function ask(body: Record<string, unknown>) {
  const r = await fetch(`${base}/api/cash-sale-recorded`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as any };
}

describe('POST /api/cash-sale-recorded', () => {
  it('the brain has it: recorded, with when', async () => {
    brain = { status: 200, body: { duplicate: true, by: 'invoice', original_tx_id: 't1', original_created_at: '2026-11-23 08:00:00' } };
    const r = await ask({ unit_id: NO_COMPANY, staff_hex: OWNER, invoice_number: TEXT });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ success: true, recorded: true, original_created_at: '2026-11-23 08:00:00' });
    // The brain was asked about exactly this text on this unit, with the server's key.
    expect(asked).toEqual([{ url: 'http://brain.test/api/purchase/check-dedup', body: { unit_id: NO_COMPANY, invoice_number: TEXT }, auth: 'Bearer test-key' }]);
  });

  it('the brain does not have it: not recorded (asked by staff too)', async () => {
    const r = await ask({ unit_id: NO_COMPANY, staff_hex: STAFF, invoice_number: TEXT });
    expect(r.json).toEqual({ success: true, recorded: false });
  });

  it.each([
    ['the brain cannot be reached', 'down' as const],
    ['the brain answers an error', { status: 500, body: { error: 'check-dedup failed' } }],
    ['the brain answers something else', { status: 200, body: { ok: true } }],
    ['a hit on the photo, not on the text', { status: 200, body: { duplicate: true, by: 'receipt_image' } }],
  ])('%s: 503, never "not recorded"', async (_label, answer) => {
    brain = answer;
    const r = await ask({ unit_id: NO_COMPANY, staff_hex: OWNER, invoice_number: TEXT });
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ success: false, code: 'BRAIN_UNAVAILABLE' });
    expect(r.json.recorded).toBeUndefined();
  });

  it('a shop with a company: 409, the brain is not asked', async () => {
    const r = await ask({ unit_id: COMPANY, staff_hex: OWNER, invoice_number: TEXT });
    expect(r.status).toBe(409);
    expect(asked).toEqual([]);
  });

  it.each([
    ['somebody who is not owner or staff', { unit_id: NO_COMPANY, staff_hex: STRANGER, invoice_number: TEXT }, 403],
    ['no sale text', { unit_id: NO_COMPANY, staff_hex: OWNER }, 400],
    ['a text that is not a sale number\'s', { unit_id: NO_COMPANY, staff_hex: OWNER, invoice_number: 'INV-2026-1' }, 400],
    ['no unit', { staff_hex: OWNER, invoice_number: TEXT }, 400],
  ])('%s: %s, the brain is not asked', async (_label, body, status) => {
    const r = await ask(body);
    expect(r.status).toBe(status);
    expect(asked).toEqual([]);
  });

  it('a standing KIND 87058 decision against the person asking: refused by the gate', async () => {
    db.prepare(`INSERT INTO person_exclusions (d_tag, person_hex, active, ground, since, event_id, event_created_at) VALUES ('d-s', ?, 1, 'g', 1, 'ev', 1)`).run(STAFF);
    const r = await ask({ unit_id: NO_COMPANY, staff_hex: STAFF, invoice_number: TEXT });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('PERSON_EXCLUDED');
    expect(asked).toEqual([]);
  });
});
