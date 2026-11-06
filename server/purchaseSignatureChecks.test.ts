// @vitest-environment node
/**
 * The go or no-go checks for turning on PURCHASE_SIGNATURE_REQUIRED, run from the very
 * file the README tells a person to run, on tables created by the code that creates
 * them in production. The brain's table has the columns these checks read, from
 * lana-brain/server/db/schema.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import { initializeSchema } from './db/schema.js';
import { purchaseSellerCheck } from './purchaseSeller.js';
import { installRequestLogging } from './shared/requestLogging.js';

const sqlFile = readFileSync(new URL('./scripts/purchase-signature-checks.sql', import.meta.url), 'utf8');

/** The file's blocks: a person reads them by their `.print` titles, so this does too. */
function blocks(): Array<{ title: string; sql: string }> {
  const out: Array<{ title: string; lines: string[] }> = [];
  for (const line of sqlFile.split('\n')) {
    if (line.startsWith('.print ')) out.push({ title: line.slice('.print '.length), lines: [] });
    else if (line.startsWith('.print') || line.startsWith('--') && out.length === 0) continue;
    else if (out.length > 0) out[out.length - 1].lines.push(line);
  }
  return out.map(b => ({ title: b.title, sql: b.lines.join('\n').trim() }));
}

const check = (n: number) => {
  const found = blocks().find(b => b.title.startsWith(`=== ${n}. `));
  if (!found) throw new Error(`no check ${n} in the file`);
  return found.sql;
};

const UNIT = 'aaaabbbbccccddddeeeeffff00001111';
const OTHER_UNIT = '99998888777766665555444433332222';
const OWNER = 'ab'.repeat(32);
const STAFF = 'cd'.repeat(32);
const STRANGER = 'ef'.repeat(32);
const short = (hex: string) => hex.slice(0, 12);

let db: Database.Database;
let dir: string;
const quiet = console.log;

beforeAll(() => {
  console.log = () => {};
  dir = mkdtempSync(join(tmpdir(), 'purchase-checks-'));
  db = new Database(':memory:');
  initializeSchema(db);
  purchaseSellerCheck(db);
  installRequestLogging(express(), db);

  const brain = new Database(join(dir, 'brain.db'));
  brain.exec(`CREATE TABLE transactions (
    id TEXT PRIMARY KEY, unit_id TEXT NOT NULL, payment_type TEXT NOT NULL CHECK (payment_type IN ('cash', 'lana')),
    status TEXT DEFAULT 'created', created_at TEXT DEFAULT (datetime('now')))`);
  brain.close();
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  console.log = quiet;
});

function unit(unitId: string, o: { owner?: string; staff?: string; status?: string; unitType?: string | null; name?: string } = {}) {
  db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, unit_type)
    VALUES (?, 'ev', ?, 1, ?, ?, ?, 'EUR', ?, ?)
  `).run(unitId, OWNER, o.name ?? 'Shop', o.owner ?? OWNER, o.staff ?? JSON.stringify([OWNER, STAFF]), o.status ?? 'active', o.unitType ?? null);
}

type Row = { verdict: string; reason?: string; status?: number; marker?: 0 | 1; unit?: string; claimed?: string; signer?: string; ts?: string };
function logged(r: Row) {
  db.prepare(`
    INSERT INTO purchase_auth_log (ts, verdict, reason, status, payment_type, till_marker, unit_prefix, signer_prefix, claimed_prefix, skew_sec)
    VALUES (COALESCE(?, datetime('now')), ?, ?, ?, 'cash', ?, ?, ?, ?, NULL)
  `).run(r.ts ?? null, r.verdict, r.reason ?? '', r.status ?? 200, r.marker ?? 0, short(r.unit ?? UNIT), short(r.signer ?? ''), short(r.claimed ?? ''));
}

const noGoList = () => db.prepare(check(1)).all() as any[];

beforeEach(() => {
  for (const t of ['purchase_auth_log', 'request_logs', 'business_units']) db.prepare(`DELETE FROM ${t}`).run();
  unit(UNIT);
  unit(OTHER_UNIT, { owner: STRANGER, staff: JSON.stringify([STRANGER]) });
});

describe('the file itself', () => {
  it('has the four checks, and only reads', () => {
    expect(blocks().map(b => b.title.slice(0, 6))).toEqual(['=== 1.', '=== 2.', '=== 3.', '=== 4.']);
    expect(sqlFile).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|VACUUM)\b/i);
  });

  it('the README tells a person where to find it and how to read it', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('## Signed purchase requests: when refusing may be turned on');
    expect(readme).toContain('### Go or no-go');
    expect(readme).toContain('< server/scripts/purchase-signature-checks.sql');
    expect(readme).toContain('PURCHASE_SIGNATURE_REQUIRED');
  });

  it('the code that holds the setting points at the README', () => {
    expect(readFileSync(new URL('./purchaseSeller.ts', import.meta.url), 'utf8')).toContain('README.md, "Signed purchase requests"');
    expect(readFileSync(new URL('../docker-compose.prod.yml', import.meta.url), 'utf8')).toContain('"Signed purchase');
  });
});

describe('check 1: every request that was not ok, read by the rules', () => {
  it.each<[string, Row[], string, string]>([
    ['a phone with a wrong clock', [{ verdict: 'bad_signature', reason: 'STALE', marker: 1, claimed: STAFF }], 'acceptable', 'NAMES SOMEONE ON THIS UNIT'],
    ['a repeated token with an ok after it', [{ verdict: 'bad_signature', reason: 'REPLAYED', marker: 1, claimed: STAFF }, { verdict: 'ok', marker: 1, claimed: STAFF, signer: STAFF }], 'acceptable', 'NAMES SOMEONE ON THIS UNIT'],
    ['a repeated token with no ok after it', [{ verdict: 'ok', marker: 1, claimed: STAFF, signer: STAFF }, { verdict: 'bad_signature', reason: 'REPLAYED', marker: 1, claimed: STAFF }], 'look by hand', 'NAMES SOMEONE ON THIS UNIT'],
    ['a body that does not match, from this code', [{ verdict: 'bad_signature', reason: 'PAYLOAD_MISMATCH', marker: 1, claimed: STAFF }], 'NO-GO', 'NAMES SOMEONE ON THIS UNIT'],
    ['a signature that does not hold, from this code, naming nobody here', [{ verdict: 'bad_signature', reason: 'BAD_SIG', marker: 1, claimed: STRANGER }], 'NO-GO', 'names someone else'],
    ['a signature that does not hold, no marker, naming someone on the unit', [{ verdict: 'bad_signature', reason: 'BAD_SIG', marker: 0, claimed: OWNER }], 'NO-GO', 'NAMES SOMEONE ON THIS UNIT'],
    ['a header that is not a token, no marker, naming nobody', [{ verdict: 'bad_signature', reason: 'MALFORMED', marker: 0 }], 'look by hand', 'nobody named'],
    ['the check itself failing', [{ verdict: 'check_failed', reason: 'ERROR', marker: 1, claimed: STAFF }], 'NO-GO', 'NAMES SOMEONE ON THIS UNIT'],
    ['this code failing to sign, naming the staff member', [{ verdict: 'unsigned', reason: 'MISSING', marker: 1, claimed: STAFF }], 'NO-GO', 'NAMES SOMEONE ON THIS UNIT'],
    ['this code failing to sign, naming someone else', [{ verdict: 'unsigned', reason: 'MISSING', marker: 1, claimed: STRANGER }], 'look by hand', 'names someone else'],
    ['this code failing to sign, naming nobody', [{ verdict: 'unsigned', reason: 'MISSING', marker: 1 }], 'look by hand', 'nobody named'],
    ['an older tab naming the owner, not reloaded yet', [{ verdict: 'unsigned', reason: 'MISSING', marker: 0, claimed: OWNER }], 'wait for a reload', 'NAMES SOMEONE ON THIS UNIT'],
    ['an older tab naming someone on the unit after that person reloaded', [{ verdict: 'ok', marker: 1, claimed: STAFF, signer: STAFF }, { verdict: 'unsigned', reason: 'MISSING', marker: 0, claimed: STAFF }], 'NO-GO', 'NAMES SOMEONE ON THIS UNIT'],
    ['an older tab past its 8 hours, or not a till', [{ verdict: 'unsigned', reason: 'MISSING', marker: 0 }], 'acceptable', 'nobody named'],
    ['no marker, naming someone who is not on the unit', [{ verdict: 'unsigned', reason: 'MISSING', marker: 0, claimed: STRANGER }], 'acceptable', 'names someone else'],
    ['a good signature from someone not on the unit', [{ verdict: 'not_entitled', reason: 'NOT_OWNER_OR_STAFF', marker: 1, claimed: STRANGER, signer: STRANGER }], 'look by hand', 'names someone else'],
    ['the owner of another unit at this one', [{ verdict: 'not_entitled', reason: 'NOT_OWNER_OR_STAFF', marker: 1, unit: UNIT, claimed: STRANGER, signer: STRANGER }], 'look by hand', 'names someone else'],
  ])('%s', (_label, rows, reading, who) => {
    for (const r of rows) logged(r);
    const list = noGoList();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ reading, who });
  });

  it('a hex stored in upper case is still someone on the unit', () => {
    db.prepare('DELETE FROM business_units').run();
    unit(UNIT, { owner: OWNER.toUpperCase(), staff: JSON.stringify([OWNER.toUpperCase(), STAFF.toUpperCase()]) });
    logged({ verdict: 'unsigned', reason: 'MISSING', claimed: OWNER });
    logged({ verdict: 'unsigned', reason: 'MISSING', claimed: STAFF });
    expect(noGoList().map(r => r.who)).toEqual(['NAMES SOMEONE ON THIS UNIT', 'NAMES SOMEONE ON THIS UNIT']);
  });

  it.each([
    ['lower case', OWNER],
    ['upper case', OWNER.toUpperCase()],
  ])('an owner who is in no p tag is still someone on the unit, stored in %s', (_case, stored) => {
    db.prepare('DELETE FROM business_units').run();
    unit(UNIT, { owner: stored, staff: '[]' });
    logged({ verdict: 'unsigned', reason: 'MISSING', claimed: OWNER });
    expect(noGoList()[0].who).toBe('NAMES SOMEONE ON THIS UNIT');
  });

  it('every status is on the list, not only the sales that went through', () => {
    for (const status of [200, 0, 401, 403, 409, 500]) logged({ verdict: 'unsigned', reason: 'MISSING', marker: 1, claimed: STAFF, status });
    const list = noGoList();
    expect(list.map(r => r.status).sort((a, b) => a - b)).toEqual([0, 200, 401, 403, 409, 500]);
    expect(list.every(r => r.reading === 'NO-GO')).toBe(true);
  });

  it('ok rows and rows older than 7 days are not on it', () => {
    logged({ verdict: 'ok', marker: 1, claimed: STAFF, signer: STAFF });
    logged({ verdict: 'unsigned', reason: 'MISSING', marker: 1, claimed: STAFF, ts: "2000-01-01 00:00:00" });
    expect(noGoList()).toEqual([]);
  });

  it('rows of one kind are counted together, and no-go comes first', () => {
    logged({ verdict: 'unsigned', reason: 'MISSING', marker: 0 });
    logged({ verdict: 'unsigned', reason: 'MISSING', marker: 0 });
    logged({ verdict: 'check_failed', reason: 'ERROR', marker: 1, claimed: STAFF });
    const list = noGoList();
    expect(list).toHaveLength(2);
    expect(list[0].reading).toBe('NO-GO');
    expect(list[1]).toMatchObject({ reading: 'acceptable', n: 2 });
  });

  it('shows the marker, and who the signature proved beside who was named', () => {
    logged({ verdict: 'not_entitled', reason: 'NOT_OWNER_OR_STAFF', marker: 1, claimed: OWNER, signer: STRANGER });
    expect(noGoList()[0]).toMatchObject({ marker: 1, claimed_prefix: short(OWNER), signer_prefix: short(STRANGER) });
  });
});

describe('check 2: lost rows', () => {
  const answered = (status: number, path = '/api/brain/purchase', method = 'POST', ts?: string) =>
    db.prepare(`INSERT INTO request_logs (ts, method, path, status, duration_ms, ip) VALUES (COALESCE(?, datetime('now')), ?, ?, ?, 5, 'x')`).run(ts ?? null, method, path, status);
  const counts = () => db.prepare(check(2)).get() as { route_200: number; logged_200: number };

  it('match when every sale has its row', () => {
    answered(200); answered(200);
    logged({ verdict: 'ok', signer: OWNER }); logged({ verdict: 'unsigned' });
    expect(counts()).toEqual({ route_200: 2, logged_200: 2 });
  });

  it('differ when a sale has no row', () => {
    answered(200); answered(200);
    logged({ verdict: 'ok', signer: OWNER });
    expect(counts()).toEqual({ route_200: 2, logged_200: 1 });
  });

  it('count only this route, only 200, only the last 24 hours', () => {
    answered(403);
    answered(200, '/api/brain/purchase/preview');
    answered(200, '/api/brain/purchase', 'GET');
    answered(200, '/api/brain/purchase', 'POST', '2000-01-01 00:00:00');
    logged({ verdict: 'ok', status: 409, signer: OWNER });
    logged({ verdict: 'ok', ts: '2000-01-01 00:00:00', signer: OWNER });
    expect(counts()).toEqual({ route_200: 0, logged_200: 0 });
  });
});

describe('check 3: staff lists', () => {
  const bad = () => (db.prepare(check(3)).get() as { bad_staff_lists: number }).bad_staff_lists;

  it('0 when every list is a list', () => {
    expect(bad()).toBe(0);
    unit('empty-list-unit-000', { staff: '[]' });
    expect(bad()).toBe(0);
  });

  it.each([
    ['not JSON', 'not json'],
    ['an empty string', ''],
    ['an object', '{"a":1}'],
    ['a string', '"abc"'],
    ['a number', '5'],
  ])('%s is counted, and the query does not fail on it', (_what, staff) => {
    unit('bad-list-unit-0000', { staff });
    expect(bad()).toBe(1);
  });
});

describe('check 4: units that sold and have no ok row', () => {
  const coverage = () => {
    const sql = check(4).replace("'file:/opt/apps/lana-brain/data/lana-brain.db?mode=ro'", `'${join(dir, 'brain.db')}'`);
    const [attach, ...rest] = sql.split(';\n');
    db.exec(`${attach};`);
    try {
      return db.prepare(rest.join(';\n')).all() as any[];
    } finally {
      db.exec('DETACH DATABASE brain');
    }
  };
  const sold = (unitId: string, paymentType: 'cash' | 'lana', createdAt?: string) => {
    const brain = new Database(join(dir, 'brain.db'));
    brain.prepare(`INSERT INTO transactions (id, unit_id, payment_type, created_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')))`)
      .run(`t${Math.random()}`, unitId, paymentType, createdAt ?? null);
    brain.close();
  };

  beforeEach(() => {
    const brain = new Database(join(dir, 'brain.db'));
    brain.exec('DELETE FROM transactions');
    brain.close();
  });

  it('points at the brain\'s database, read-only', () => {
    expect(check(4)).toContain("ATTACH 'file:/opt/apps/lana-brain/data/lana-brain.db?mode=ro' AS brain;");
  });

  it('a unit that sold with an ok row is not listed', () => {
    sold(UNIT, 'cash');
    logged({ verdict: 'ok', signer: OWNER });
    expect(coverage()).toEqual([]);
  });

  it('a unit that sold with no ok row is listed, with what it sold', () => {
    sold(UNIT, 'cash'); sold(UNIT, 'cash'); sold(UNIT, 'lana');
    logged({ verdict: 'unsigned', claimed: OWNER });
    expect(coverage()).toEqual([expect.objectContaining({ unit_id: UNIT, cash: 2, lana: 1, on_this_till: 'status active' })]);
  });

  it('says where a listed unit lives, to help explain it', () => {
    unit('simple-unit-000000', { unitType: 'simple.lanapays.us' });
    unit('archived-unit-0000', { status: 'archived' });
    sold('simple-unit-000000', 'lana');
    sold('archived-unit-0000', 'cash');
    sold('no-such-unit-00000', 'lana');
    const byUnit = Object.fromEntries(coverage().map(r => [r.unit_id, r.on_this_till]));
    expect(byUnit).toEqual({
      'simple-unit-000000': 'simple site',
      'archived-unit-0000': 'status archived',
      'no-such-unit-00000': 'not a unit on this till',
    });
  });

  it('a sale older than 60 days is not listed', () => {
    sold(UNIT, 'cash', '2000-01-01 00:00:00');
    expect(coverage()).toEqual([]);
  });
});
