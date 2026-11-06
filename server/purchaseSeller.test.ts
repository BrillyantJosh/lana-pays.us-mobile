// @vitest-environment node
/**
 * POST /api/brain/purchase with the seller check in front of it: what the till's
 * signature says about who is selling, and what happens to the sale.
 *
 * Real check, real handler, real schema in memory, the browser's real signing code,
 * and a stub brain on its own port that records every request it gets.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'net';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { initializeSchema } from './db/schema.js';
import { brainPurchaseHandler } from './brainPurchase.js';
import { purchaseSellerCheck } from './purchaseSeller.js';
import { keepRawBody, forgetSpentTokens } from './lib/nip98.js';
import { signedAuthHeaders } from '../src/lib/signedRequest';

const PATH = '/api/brain/purchase';
const UNIT = '1e3e722ad51d39b4c91039a9112c021e';
const CUSTOMER = { customer_hex: 'c'.repeat(64), customer_wallet: 'LbtLTSACAREiT513CVNpbg6NeE5cFbrhkC', customer_name: 'Test Buyer' };

const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
function person() {
  const sk = generateSecretKey();
  return { key: toHex(sk), hex: getPublicKey(sk) };
}
const OWNER = person();
const STAFF = person();
const STRANGER = person();
const CARETAKER = person();

let db: Database.Database;
let base = '';
let httpServer: any;
let brainServer: any;
let brainUrl = '';
let brainAnswer: { status: number; body: unknown; delayMs?: number };
let lookup: { spent?: number };
const brainRequests: Array<{ path: string; body: any; authorization?: string }> = [];
const logLines: string[] = [];
const quiet = { log: console.log, warn: console.warn, error: console.error };

const forwarded = () => brainRequests.filter(r => r.path === '/api/purchase');
const row = (n: number) => db.prepare('SELECT * FROM purchase_auth_log ORDER BY id LIMIT 1 OFFSET ?').get(n) as any;
const rowCount = () => (db.prepare('SELECT COUNT(*) AS n FROM purchase_auth_log').get() as any).n as number;

/** The row is written when the response closes, a moment after the till has its answer. */
async function nthVerdict(n: number) {
  await vi.waitFor(() => expect(rowCount()).toBeGreaterThan(n), { timeout: 3000, interval: 5 });
  return row(n);
}

function mount(dbForCheck: Database.Database): express.Express {
  const app = express();
  app.use(express.json({ limit: '50kb', verify: keepRawBody }));
  app.post(PATH, purchaseSellerCheck(dbForCheck), brainPurchaseHandler(db, brainUrl, 'test-key'));
  return app;
}

async function listen(app: express.Express): Promise<{ server: any; url: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  console.log = (...a: unknown[]) => { logLines.push(a.join(' ')); };
  console.warn = () => {};
  console.error = () => {};

  const brain = express();
  brain.use(express.json());
  brain.use((req, _res, next) => {
    brainRequests.push({ path: req.path, body: req.body, authorization: req.headers.authorization });
    next();
  });
  brain.get('/api/purchase/customer-window', (req, res) => {
    res.json({ spent: lookup.spent ?? 0, count: 1, days: Number(req.query.days), currency: req.query.currency });
  });
  brain.post('/api/purchase', async (_req, res) => {
    if (brainAnswer.delayMs) await new Promise(r => setTimeout(r, brainAnswer.delayMs));
    res.status(brainAnswer.status).json(brainAnswer.body);
  });
  const b = await listen(brain);
  brainServer = b.server;
  brainUrl = b.url;

  db = new Database(':memory:');
  initializeSchema(db);

  const a = await listen(mount(db));
  httpServer = a.server;
  base = a.url;
});

afterAll(async () => {
  await new Promise(r => httpServer.close(r));
  await new Promise(r => brainServer.close(r));
  db.close();
  Object.assign(console, quiet);
});

function seed(o: {
  unitId?: string; owner?: string; staff?: string; unitStatus?: string; suspension?: string; unitType?: string | null;
  volumeUsed?: number; volumeLimit?: number; txUsed?: number; txLimit?: number; maxTx?: string;
} = {}) {
  const unitId = o.unitId ?? UNIT;
  db.prepare('DELETE FROM business_units').run();
  db.prepare('DELETE FROM fee_policies').run();
  db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status,
      suspension_status, unit_type, quota_volume_used, quota_volume_limit, quota_tx_used, quota_tx_limit, quota_currency, quota_period)
    VALUES (?, 'ev', ?, 1, 'Bio s kmetij', ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?, 'EUR', '2026-11')
  `).run(unitId, OWNER.hex, o.owner ?? OWNER.hex, o.staff ?? JSON.stringify([OWNER.hex, STAFF.hex]),
    o.unitStatus ?? 'active', o.suspension ?? 'active', o.unitType ?? null,
    o.volumeUsed ?? 400, o.volumeLimit ?? 1000, o.txUsed ?? 4, o.txLimit ?? 50);
  db.prepare(`
    INSERT INTO fee_policies (unit_id, event_id, pubkey, created_at, lana_discount_per, lanapays_us_per, max_tx_amount, max_tx_currency, status, caretaker_hex)
    VALUES (?, 'ev', 'pk', 1, '5.00', '5.00', ?, 'EUR', 'active', ?)
  `).run(unitId, o.maxTx ?? '200.00', CARETAKER.hex);
}

const cashSale = (over: Record<string, unknown> = {}) => ({
  unit_id: UNIT, payment_type: 'cash', amount: 50, currency: 'EUR', invoice_number: 'INV-1', ...CUSTOMER, ...over,
});
const lanaSale = (over: Record<string, unknown> = {}) => cashSale({ payment_type: 'lana', signed_tx_hex: 'ab'.repeat(100), ...over });

async function post(body: string, headers: Record<string, string> = {}, url = base) {
  const res = await fetch(`${url}${PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  return { status: res.status, body: await res.json() as any };
}

/** A sale signed the way the till signs it, by the browser's own code. */
const signedBy = (who: { key: string }, sale: Record<string, unknown>, opts: { nowSec?: number } = {}) => {
  const body = JSON.stringify(sale);
  return { body, headers: signedAuthHeaders(who.key, 'POST', PATH, { body, ...opts }) };
};
const sellAs = (who: { key: string }, sale: Record<string, unknown>, opts: { nowSec?: number } = {}) => {
  const s = signedBy(who, sale, opts);
  return post(s.body, s.headers);
};

beforeEach(() => {
  brainRequests.length = 0;
  logLines.length = 0;
  lookup = { spent: 0 };
  brainAnswer = { status: 200, body: { success: true, data: { transaction_id: 'tx_1' } } };
  forgetSpentTokens();
  db.prepare('DELETE FROM purchase_auth_log').run();
  db.prepare('DELETE FROM fund_capacity').run();
  db.prepare("UPDATE app_settings SET value = '0' WHERE key = 'default_max_tx_amount'").run();
  db.prepare("UPDATE app_settings SET value = '1' WHERE key = 'customer_window_days'").run();
  db.prepare("UPDATE app_settings SET value = 'false' WHERE key = 'split_happening'").run();
  seed();
});

describe('who may sell', () => {
  it('the owner\'s signed sale is ok and sells', async () => {
    const r = await sellAs(OWNER, cashSale());
    expect(r.status).toBe(200);
    expect(forwarded()).toHaveLength(1);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', reason: '', status: 200, payment_type: 'cash', signer_prefix: OWNER.hex.slice(0, 12), unit_prefix: UNIT.slice(0, 12) });
  });

  it('a staff member\'s signed sale is ok and sells: the signer is not the owner', async () => {
    const r = await sellAs(STAFF, cashSale());
    expect(r.status).toBe(200);
    expect(forwarded()).toHaveLength(1);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', signer_prefix: STAFF.hex.slice(0, 12) });
  });

  it('an owner who is in no p tag is still the owner', async () => {
    seed({ staff: JSON.stringify([STAFF.hex]) });
    await sellAs(OWNER, cashSale());
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok' });
  });

  it('a staff hex stored in upper case is the same person', async () => {
    seed({ staff: JSON.stringify([STAFF.hex.toUpperCase()]) });
    await sellAs(STAFF, cashSale());
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok' });
  });

  it('an owner hex stored in upper case is the same person', async () => {
    seed({ owner: OWNER.hex.toUpperCase(), staff: '[]' });
    await sellAs(OWNER, cashSale());
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', signer_prefix: OWNER.hex.slice(0, 12) });
  });

  it('the signature decides, not the name in a header: a stranger naming the owner is judged as the stranger', async () => {
    const s = signedBy(STRANGER, cashSale());
    await post(s.body, { ...s.headers, 'x-lana-hex': OWNER.hex, 'x-till-seller': OWNER.hex });
    expect(await nthVerdict(0)).toMatchObject({
      verdict: 'not_entitled', reason: 'NOT_OWNER_OR_STAFF',
      signer_prefix: STRANGER.hex.slice(0, 12), claimed_prefix: OWNER.hex.slice(0, 12),
    });
  });

  it('a staff member naming a stranger in the header is judged as the staff member', async () => {
    const s = signedBy(STAFF, cashSale());
    await post(s.body, { ...s.headers, 'x-lana-hex': STRANGER.hex });
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', signer_prefix: STAFF.hex.slice(0, 12), claimed_prefix: STRANGER.hex.slice(0, 12) });
  });

  it('the unit\'s status is not asked: an archived unit\'s owner is still its owner', async () => {
    seed({ unitStatus: 'archived' });
    const r = await sellAs(OWNER, lanaSale());
    expect(r.status).toBe(200);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', status: 200 });
  });

  it('a suspended unit\'s owner is still its owner: the handler refuses for its own reason', async () => {
    seed({ suspension: 'suspended' });
    const r = await sellAs(OWNER, cashSale());
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('MERCHANT_SUSPENDED');
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', status: 403 });
  });

  it('where a unit was opened is not asked either', async () => {
    seed({ unitType: 'simple.lanapays.us' });
    await sellAs(OWNER, lanaSale());
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok' });
  });

  it.each([
    ['a number', 12345],
    ['an array holding a real id', ['12345']],
    ['an object', { id: '12345' }],
    ['true', true],
    ['null', null],
  ])('a unit_id that is %s never reaches the lookup, and the handler keeps its 400', async (_what, unitId) => {
    seed({ unitId: '12345' });
    const r = await sellAs(OWNER, lanaSale({ unit_id: unitId }));
    expect(r.status).toBe(400);
    expect(forwarded()).toHaveLength(0);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'not_entitled', reason: 'NO_UNIT', status: 400, unit_prefix: '' });
  });

  it('LANA is judged the same way', async () => {
    const r = await sellAs(STAFF, lanaSale());
    expect(r.status).toBe(200);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', payment_type: 'lana' });
  });

  it('an unreadable staff list leaves the owner able to sell and names no staff', async () => {
    seed({ staff: 'not json' });
    await sellAs(OWNER, cashSale());
    await sellAs(STAFF, cashSale({ invoice_number: 'INV-2' }));
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok' });
    expect(await nthVerdict(1)).toMatchObject({ verdict: 'not_entitled', reason: 'NOT_OWNER_OR_STAFF' });
  });
});

describe('phase 1: every verdict is written down and no sale is refused for it', () => {
  it('an unsigned request is logged and still sells, as before', async () => {
    const r = await post(JSON.stringify(cashSale()), { 'x-lana-hex': OWNER.hex });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, data: { transaction_id: 'tx_1' } });
    expect(forwarded()).toHaveLength(1);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'unsigned', reason: 'MISSING', status: 200, signer_prefix: '', claimed_prefix: OWNER.hex.slice(0, 12) });
  });

  it('a signer who is neither owner nor staff is logged and still sells', async () => {
    const r = await sellAs(STRANGER, cashSale());
    expect(r.status).toBe(200);
    expect(forwarded()).toHaveLength(1);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'not_entitled', reason: 'NOT_OWNER_OR_STAFF', status: 200, signer_prefix: STRANGER.hex.slice(0, 12) });
  });

  it('the unit\'s caretaker is not a seller unless also on the unit', async () => {
    const r = await sellAs(CARETAKER, cashSale());
    expect(r.status).toBe(200);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'not_entitled', reason: 'NOT_OWNER_OR_STAFF' });
  });

  it.each([
    ['the amount', { amount: 49 }],
    ['the unit', { unit_id: 'another-unit-0000000000000000' }],
    ['the customer', { customer_hex: 'd'.repeat(64) }],
    ['the wallet', { customer_wallet: 'LfDJmg13pwCjG3u6T6GH4Y3MUEdRuj68Nd' }],
    ['the invoice number', { invoice_number: 'INV-2' }],
  ])('%s changed after signing: bad signature, and the sale still goes in this phase', async (_what, change) => {
    const s = signedBy(OWNER, cashSale());
    const changed = JSON.stringify({ ...JSON.parse(s.body), ...change });
    await post(changed, s.headers);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'bad_signature', reason: 'PAYLOAD_MISMATCH', signer_prefix: '' });
  });

  it('the signature covers the bytes that arrived, not a re-serialisation of them', async () => {
    const sale = cashSale();
    const spaced = JSON.stringify(sale, null, 2);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(sale).reverse()));
    await post(spaced, signedAuthHeaders(OWNER.key, 'POST', PATH, { body: spaced }));
    await post(reordered, signedAuthHeaders(OWNER.key, 'POST', PATH, { body: reordered }));
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok' });
    expect(await nthVerdict(1)).toMatchObject({ verdict: 'ok' });
    expect(forwarded()[0].body).toEqual(sale);
  });

  it('the same sale in other bytes than the ones signed does not match', async () => {
    const sale = cashSale();
    await post(JSON.stringify(sale, null, 2), signedAuthHeaders(OWNER.key, 'POST', PATH, { body: JSON.stringify(sale) }));
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'bad_signature', reason: 'PAYLOAD_MISMATCH' });
  });

  it('a token for another path is a bad signature', async () => {
    const body = JSON.stringify(cashSale());
    await post(body, signedAuthHeaders(OWNER.key, 'POST', '/api/brain/purchase/preview', { body }));
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'bad_signature', reason: 'PATH_MISMATCH' });
  });

  it('a token with no body bound to it is a bad signature', async () => {
    await post(JSON.stringify(cashSale()), signedAuthHeaders(OWNER.key, 'POST', PATH));
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'bad_signature', reason: 'PAYLOAD_MISSING' });
  });

  it('a retry of the same sale passes: the same bytes signed again in the same second', async () => {
    const sale = cashSale();
    const first = await sellAs(OWNER, sale);
    const second = await sellAs(OWNER, sale);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(forwarded()).toHaveLength(2);
    expect(forwarded()[0].body).toEqual(forwarded()[1].body);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok' });
    expect(await nthVerdict(1)).toMatchObject({ verdict: 'ok' });
  });

  it('the same token twice is logged the second time, and still goes in this phase', async () => {
    const s = signedBy(OWNER, cashSale());
    await post(s.body, s.headers);
    await post(s.body, s.headers);
    expect(forwarded()).toHaveLength(2);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok' });
    expect(await nthVerdict(1)).toMatchObject({ verdict: 'bad_signature', reason: 'REPLAYED' });
  });

  it('a wrong device clock is named with how far off it is, and still sells', async () => {
    const now = Math.floor(Date.now() / 1000);
    const r = await sellAs(OWNER, cashSale(), { nowSec: now - 600 });
    expect(r.status).toBe(200);
    const v = await nthVerdict(0);
    expect(v).toMatchObject({ verdict: 'bad_signature', reason: 'STALE' });
    expect(Math.abs(v.skew_sec + 600)).toBeLessThanOrEqual(2);
  });

  it('garbage in the header is a bad signature, not a crash', async () => {
    await post(JSON.stringify(cashSale()), { Authorization: 'Bearer something-else' });
    await post(JSON.stringify(cashSale({ invoice_number: 'INV-2' })), { Authorization: 'Nostr %%%' });
    expect(forwarded()).toHaveLength(2);
    expect((await nthVerdict(0)).reason).toBe('MALFORMED');
    expect((await nthVerdict(1)).verdict).toBe('bad_signature');
  });

  it('a unit nobody here knows: not entitled, the LANA sale goes on, the cash sale keeps its 404', async () => {
    const lana = await sellAs(OWNER, lanaSale({ unit_id: 'unknown-unit' }));
    const cash = await sellAs(OWNER, cashSale({ unit_id: 'unknown-unit' }));
    expect(lana.status).toBe(200);
    expect(cash.status).toBe(404);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'not_entitled', reason: 'UNKNOWN_UNIT', status: 200, unit_prefix: 'unknown-unit' });
    expect(await nthVerdict(1)).toMatchObject({ verdict: 'not_entitled', reason: 'UNKNOWN_UNIT', status: 404 });
  });

  it('no unit named: not entitled', async () => {
    await sellAs(OWNER, lanaSale({ unit_id: '' }));
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'not_entitled', reason: 'NO_UNIT' });
  });

  it('a name with accents and a body that is not ASCII sign and verify byte for byte', async () => {
    const r = await sellAs(OWNER, cashSale({ customer_name: 'Živa Šuštaršič 日本 🌱', receipt_description: 'Krema za roke — 2×' }));
    expect(r.status).toBe(200);
    expect(forwarded()[0].body.customer_name).toBe('Živa Šuštaršič 日本 🌱');
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok' });
  });

  it('the status the till got is written down: 200 is a recorded sale, the rest is not', async () => {
    brainAnswer = { status: 409, body: { success: false, error: 'DUPLICATE_INVOICE' } };
    const r = await sellAs(OWNER, cashSale());
    expect(r.status).toBe(409);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', status: 409 });
  });

  it('a till that left before the answer is written down as 0', async () => {
    brainAnswer = { status: 200, body: { success: true }, delayMs: 300 };
    const s = signedBy(OWNER, cashSale());
    const gone = new AbortController();
    const asked = fetch(`${base}${PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...s.headers }, body: s.body, signal: gone.signal });
    await vi.waitFor(() => expect(brainRequests.length).toBeGreaterThan(0), { timeout: 3000, interval: 5 });
    gone.abort();
    await expect(asked).rejects.toThrow();
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', status: 0 });
  });
});

describe('the marker and the name beside it only help read the record', () => {
  const NEW_BUNDLE = { 'x-till-signs': '1' };

  it('this code with its signature: marker 1', async () => {
    const s = signedBy(STAFF, cashSale());
    await post(s.body, { ...s.headers, ...NEW_BUNDLE });
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', till_marker: 1 });
    expect(logLines.find(l => l.startsWith('[purchase-auth]'))).toContain(' marker=1 ');
  });

  it('this code whose signing failed: marker 1, and the seller named past the 8 hours', async () => {
    await post(JSON.stringify(cashSale()), { ...NEW_BUNDLE, 'x-till-seller': STAFF.hex });
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'unsigned', till_marker: 1, claimed_prefix: STAFF.hex.slice(0, 12), signer_prefix: '' });
  });

  it('a tab on older code inside its 8 hours: marker 0, and it names its seller', async () => {
    await post(JSON.stringify(cashSale()), { 'x-lana-hex': STAFF.hex });
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'unsigned', till_marker: 0, claimed_prefix: STAFF.hex.slice(0, 12) });
    expect(logLines.find(l => l.startsWith('[purchase-auth]'))).toContain(' marker=0 ');
  });

  it('a tab on older code past its 8 hours: marker 0, nobody named, and it still sells', async () => {
    const r = await post(JSON.stringify(cashSale()));
    expect(r.status).toBe(200);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'unsigned', reason: 'MISSING', till_marker: 0, claimed_prefix: '', status: 200 });
  });

  it('only the exact marker counts', async () => {
    await post(JSON.stringify(cashSale()), { 'x-till-signs': '0' });
    await post(JSON.stringify(cashSale({ invoice_number: 'INV-2' })), { 'x-till-signs': 'yes' });
    expect((await nthVerdict(0)).till_marker).toBe(0);
    expect((await nthVerdict(1)).till_marker).toBe(0);
  });

  it('the marker never changes a verdict: a request with it and no signature is unsigned', async () => {
    await post(JSON.stringify(cashSale()), NEW_BUNDLE);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'unsigned', till_marker: 1 });
  });

  it('the marker never changes a verdict: a good signature without it is ok', async () => {
    const s = signedBy(OWNER, cashSale());
    await post(s.body, s.headers);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', till_marker: 0 });
  });

  it('the marker never changes a verdict: a stranger sending it is judged as the stranger', async () => {
    const s = signedBy(STRANGER, cashSale());
    await post(s.body, { ...s.headers, ...NEW_BUNDLE });
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'not_entitled', reason: 'NOT_OWNER_OR_STAFF', till_marker: 1 });
  });

  it('a name that is not a hex is not written down', async () => {
    await post(JSON.stringify(cashSale()), { ...NEW_BUNDLE, 'x-till-seller': 'verdict=ok' });
    expect(await nthVerdict(0)).toMatchObject({ claimed_prefix: '' });
  });
});

describe('what is written down', () => {
  it('one line and one row per request, with nothing about the customer in either', async () => {
    const sale = cashSale({ amount: 73.25, invoice_number: 'SECRET-INVOICE', customer_name: 'Test Buyer', receipt_description: 'Krema' });
    await sellAs(OWNER, sale);
    await nthVerdict(0);
    const lines = logLines.filter(l => l.startsWith('[purchase-auth]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`[purchase-auth] verdict=ok reason=- status=200 type=cash marker=0 unit=${UNIT.slice(0, 12)} signer=${OWNER.hex.slice(0, 12)} claimed=${OWNER.hex.slice(0, 12)}`);
    const everything = lines[0] + JSON.stringify(row(0));
    for (const secret of [CUSTOMER.customer_hex.slice(0, 12), CUSTOMER.customer_wallet, 'Test Buyer', '73.25', 'SECRET-INVOICE', 'Krema', 'Nostr ', 'test-key']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('what a client puts in a field cannot break a line of the log', async () => {
    await post(JSON.stringify(lanaSale({ unit_id: 'a\nverdict=ok b', payment_type: 'x\ny' })), { 'x-lana-hex': 'verdict=ok' });
    await nthVerdict(0);
    const line = logLines.find(l => l.startsWith('[purchase-auth]'))!;
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('type=other');
    expect(line).toContain('unit=averdictok');
    expect(line).toContain('claimed=-');
  });

  it('a skew is in the line when there is one', async () => {
    await sellAs(OWNER, cashSale(), { nowSec: Math.floor(Date.now() / 1000) + 3600 });
    await nthVerdict(0);
    expect(logLines.find(l => l.startsWith('[purchase-auth]'))).toMatch(/reason=STALE .* skew=36\d\d$/);
  });

  it('the purge runs on its own every 500 rows, and keeps what is younger than 60 days', async () => {
    db.prepare(`INSERT INTO sqlite_sequence (name, seq) SELECT 'purchase_auth_log', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'purchase_auth_log')`).run();
    db.prepare("UPDATE sqlite_sequence SET seq = 497 WHERE name = 'purchase_auth_log'").run();
    db.prepare(`INSERT INTO purchase_auth_log (ts, verdict, status) VALUES (datetime('now', '-61 days'), 'old', 200), (datetime('now', '-59 days'), 'young', 200)`).run();
    await sellAs(OWNER, cashSale());
    await vi.waitFor(() => expect((db.prepare("SELECT COUNT(*) AS n FROM purchase_auth_log WHERE verdict = 'ok'").get() as any).n).toBe(1), { timeout: 3000, interval: 5 });
    const left = (db.prepare('SELECT verdict FROM purchase_auth_log ORDER BY id').all() as any[]).map(r => r.verdict);
    expect(left).toEqual(['young', 'ok']);
  });

  it('the purge also keeps the table to its last 100 000 rows, however young', async () => {
    db.prepare(`INSERT INTO purchase_auth_log (verdict, status) VALUES ('oldest', 200)`).run();
    db.prepare("UPDATE sqlite_sequence SET seq = 200499 WHERE name = 'purchase_auth_log'").run();
    await sellAs(OWNER, cashSale());
    await vi.waitFor(() => expect((db.prepare("SELECT COUNT(*) AS n FROM purchase_auth_log WHERE verdict = 'ok'").get() as any).n).toBe(1), { timeout: 3000, interval: 5 });
    expect((db.prepare('SELECT verdict FROM purchase_auth_log ORDER BY id').all() as any[]).map(r => r.verdict)).toEqual(['ok']);
  });
});

describe('writing it down never gets in the way', () => {
  it('a table that cannot be created does not stop the server starting, and the sale still goes', async () => {
    const broken = new Proxy(db, {
      get(target: any, prop) {
        if (prop === 'exec') return () => { throw new Error('disk is full'); };
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('purchase_auth_log')) throw new Error('no such table');
            return target.prepare(sql);
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    expect(() => purchaseSellerCheck(broken)).not.toThrow();
    const noTable = await listen(mount(broken));
    try {
      const s = signedBy(OWNER, cashSale());
      const r = await post(s.body, s.headers, noTable.url);
      expect(r.status).toBe(200);
      expect(forwarded()).toHaveLength(1);
      await vi.waitFor(() => expect(logLines.some(l => l.startsWith('[purchase-auth] verdict=ok'))).toBe(true), { timeout: 3000, interval: 5 });
    } finally {
      await new Promise(r => noTable.server.close(r));
    }
  });

  it('a table that cannot be written: the sale still goes, and the line is still there', async () => {
    db.exec('DROP TABLE purchase_auth_log');
    try {
      const r = await sellAs(OWNER, cashSale());
      expect(r.status).toBe(200);
      expect(forwarded()).toHaveLength(1);
      await vi.waitFor(() => expect(logLines.some(l => l.startsWith('[purchase-auth] verdict=ok'))).toBe(true), { timeout: 3000, interval: 5 });
    } finally {
      purchaseSellerCheck(db); // creates the table again for the tests after this one
    }
  });

  it('a check that throws is written down as such, and the sale still goes', async () => {
    const failing = new Proxy(db, {
      get(target: any, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('owner_hex, authorized_hex')) throw new Error('database is busy');
            return target.prepare(sql);
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const flaky = await listen(mount(failing));
    try {
      const s = signedBy(OWNER, cashSale());
      const r = await post(s.body, s.headers, flaky.url);
      expect(r.status).toBe(200);
      expect(forwarded()).toHaveLength(1);
      expect(await nthVerdict(0)).toMatchObject({ verdict: 'check_failed', reason: 'ERROR', status: 200 });
    } finally {
      await new Promise(r => flaky.server.close(r));
    }
  });
});

describe('the limits are where they were', () => {
  it('per invoice: over the limit is reduced to it after the check, whatever was signed', async () => {
    seed({ maxTx: '100.00', volumeUsed: 0, volumeLimit: 0, txUsed: 0, txLimit: 0 });
    const r = await sellAs(OWNER, cashSale({ amount: 188.94 }));
    expect(r.status).toBe(200);
    expect(forwarded()[0].body.amount).toBe(100);
    expect(r.body.amount_adjusted).toEqual({ original: 188.94, adjusted: 100, currency: 'EUR' });
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok' });
  });

  it('the same customer\'s window: spent up, refused by the handler, with the verdict beside it', async () => {
    seed({ maxTx: '200.00' });
    lookup = { spent: 200 };
    const r = await sellAs(OWNER, cashSale({ amount: 10 }));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('CUSTOMER_WINDOW_EXCEEDED');
    expect(forwarded()).toHaveLength(0);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', status: 403 });
  });

  it('the same customer\'s window: reduced to what is left', async () => {
    seed({ maxTx: '200.00' });
    lookup = { spent: 192.44 };
    const r = await sellAs(OWNER, cashSale({ amount: 188.94 }));
    expect(r.status).toBe(200);
    expect(forwarded()[0].body.amount).toBe(7.56);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', status: 200 });
  });

  it('the month: volume used up, refused by the handler', async () => {
    seed({ volumeUsed: 1000, volumeLimit: 1000 });
    const r = await sellAs(OWNER, cashSale({ amount: 10 }));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('MERCHANT_QUOTA_EXCEEDED');
    expect(forwarded()).toHaveLength(0);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', status: 403 });
  });

  it('the month: transaction count used up, refused by the handler', async () => {
    seed({ txUsed: 50, txLimit: 50 });
    const r = await sellAs(OWNER, cashSale({ amount: 10 }));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('MERCHANT_QUOTA_EXCEEDED');
    expect(forwarded()).toHaveLength(0);
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', status: 403 });
  });
});

describe('the brain sees what it saw before', () => {
  it('the server\'s own key, never the till\'s token, and the body as the handler left it', async () => {
    const s = signedBy(OWNER, cashSale());
    await post(s.body, s.headers);
    expect(forwarded()[0].authorization).toBe('Bearer test-key');
    expect(forwarded()[0].body).toEqual(JSON.parse(s.body));
    expect(await nthVerdict(0)).toMatchObject({ verdict: 'ok', status: 200 });
  });
});

describe('the wiring in index.ts', () => {
  const indexTs = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  it('the route runs the check after the rate limit and the gate, right before the handler', () => {
    const line = indexTs.split('\n').find(l => l.trimStart().startsWith("app.post('/api/brain/purchase',"));
    expect(line).toBeTruthy();
    expect(line).toMatch(/purchaseLimiter, gateNames\(db, purchaseNames\), purchaseSellerCheck\(db\), brainPurchaseHandler\(/);
  });

  it('the body parser keeps the exact bytes, or no token could ever match, and its limit is what it was', () => {
    expect(indexTs).toContain("app.use(express.json({ limit: '50kb', verify: keepRawBody }));");
  });

  it('says at boot what it does with a verdict', () => {
    expect(indexTs).toContain('logPurchaseCheckState();');
  });
});
