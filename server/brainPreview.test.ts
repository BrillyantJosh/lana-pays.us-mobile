// @vitest-environment node
/**
 * POST /api/brain/purchase/preview: the brain's preview of a LANA sale, which
 * the till asks for BEFORE the customer's key signs anything.
 *
 * A shop without a company and without a bank account (KIND 30901
 * payout_account "none") takes no LANA through the brain, so the preview is
 * refused here and the brain is never asked. Every other request is forwarded
 * exactly as before (the handler moved out of index.ts unchanged otherwise).
 *
 * Real handler, real schema in memory, a stub brain on its own port that
 * records every request it gets.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'net';
import { initializeSchema } from './db/schema.js';
import { brainPreviewHandler } from './brainPreview.js';

const UNIT = '1e3e722ad51d39b4c91039a9112c021e';
const BODY = {
  unit_id: UNIT, customer_hex: 'c'.repeat(64), customer_wallet: 'LbtLTSACAREiT513CVNpbg6NeE5cFbrhkC',
  amount: 25.5, currency: 'EUR',
};
const PREVIEW = { success: true, data: { recipients: [{ address: 'LN4sFqQS2w3LiFmjMRVMvYPDuU9gsJpxef', amount_lanoshis: 9960937500 }], allocations: [{ investor: 'x' }] } };

let db: Database.Database;
let base = '';
let unconfigured = '';
let deadBrain = '';
let httpServer: any;
let brainServer: any;
let brainAnswer: { status: number; body: unknown } = { status: 200, body: PREVIEW };
const brainRequests: Array<{ path: string; body: any; auth: string | undefined }> = [];
const quiet = { log: console.log, warn: console.warn, error: console.error };

beforeAll(async () => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  const brain = express();
  brain.use(express.json());
  brain.post('/api/purchase/preview-lana-recipients', (req, res) => {
    brainRequests.push({ path: req.path, body: req.body, auth: req.headers.authorization });
    res.status(brainAnswer.status).json(brainAnswer.body);
  });
  brainServer = brain.listen(0, '127.0.0.1');
  await new Promise<void>(r => brainServer.once('listening', r));
  const brainUrl = `http://127.0.0.1:${(brainServer.address() as AddressInfo).port}`;

  db = new Database(':memory:');
  initializeSchema(db);

  // A port that answers nothing: opened, then closed again.
  const closed = express().listen(0, '127.0.0.1');
  await new Promise<void>(r => closed.once('listening', r));
  const closedPort = (closed.address() as AddressInfo).port;
  await new Promise(r => closed.close(r));

  const app = express();
  app.use(express.json());
  app.post('/api/brain/purchase/preview', brainPreviewHandler(db, brainUrl, 'test-key'));
  app.post('/unconfigured/preview', brainPreviewHandler(db, '', ''));
  app.post('/dead/preview', brainPreviewHandler(db, `http://127.0.0.1:${closedPort}`, 'test-key'));
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => httpServer.once('listening', r));
  const port = (httpServer.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}/api/brain/purchase/preview`;
  unconfigured = `http://127.0.0.1:${port}/unconfigured/preview`;
  deadBrain = `http://127.0.0.1:${port}/dead/preview`;
});

afterAll(async () => {
  await new Promise(r => httpServer.close(r));
  await new Promise(r => brainServer.close(r));
  db.close();
  Object.assign(console, quiet);
});

function seed(raw: string | null) {
  db.prepare('DELETE FROM business_units').run();
  db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event)
    VALUES (?, 'ev', 'pk', 1, 'Kmetija', 'o', '[]', 'EUR', 'active', ?)
  `).run(UNIT, raw);
}

const event = (tags: string[][]) => JSON.stringify({ kind: 30901, tags: [['d', UNIT], ...tags], content: '' });

async function preview(body: unknown, url = base) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}

beforeEach(() => {
  brainRequests.length = 0;
  brainAnswer = { status: 200, body: PREVIEW };
});

describe('a shop without a bank account', () => {
  it('is refused with 409 UNIT_NO_PAYOUT_ACCOUNT, in plain words, and the brain is never asked', async () => {
    seed(event([['payout_account', 'none'], ['margin_percent', '10']]));
    const r = await preview(BODY);

    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ success: false, code: 'UNIT_NO_PAYOUT_ACCOUNT' });
    expect(r.body.error).toMatch(/no bank account/);
    expect(brainRequests).toEqual([]);
  });
});

describe('every other request is forwarded as before', () => {
  it.each([
    ['a company unit', event([['receiver_type', 'company']])],
    ['no raw event stored', null],
    ['an unreadable raw event', '{not json'],
    ['payout_account with another value', event([['payout_account', 'bank']])],
  ])('%s: the same body to the brain, the brain\'s answer back', async (_label, raw) => {
    seed(raw);
    const r = await preview(BODY);

    expect(r.status).toBe(200);
    expect(r.body).toEqual(PREVIEW);
    expect(brainRequests).toHaveLength(1);
    expect(brainRequests[0].body).toEqual(BODY);
    expect(brainRequests[0].auth).toBe('Bearer test-key');
  });

  it('a unit this till does not know: the brain answers for it', async () => {
    seed(null);
    brainAnswer = { status: 400, body: { success: false, error: 'No merchant found' } };
    const r = await preview({ ...BODY, unit_id: 'f'.repeat(32) });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('No merchant found');
    expect(brainRequests).toHaveLength(1);
  });

  it('no unit_id at all is still the brain\'s own 400 to give', async () => {
    seed(null);
    brainAnswer = { status: 400, body: { error: 'Missing required fields' } };
    const { unit_id: _drop, ...body } = BODY;
    const r = await preview(body);

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Missing required fields');
    expect(brainRequests).toHaveLength(1);
  });

  it('the brain unreachable is a 502, and no brain configured a 503, as before', async () => {
    seed(null);
    const dead = await preview(BODY, deadBrain);
    expect(dead.status).toBe(502);
    expect(dead.body.error).toBe('Failed to reach Brain service');

    const none = await preview(BODY, unconfigured);
    expect(none.status).toBe(503);
    expect(none.body.error).toBe('Brain service not configured');
  });
});

describe('unit_id must be one string, as on the purchase route', () => {
  it.each([
    ['an array', [UNIT]],
    ['an object', { unit: UNIT }],
    ['a number', 1],
  ])('%s is refused with 400 and nothing reaches the brain', async (_label, unitId) => {
    seed(event([['payout_account', 'none']]));
    const r = await preview({ ...BODY, unit_id: unitId });

    expect(r.status).toBe(400);
    expect(brainRequests).toEqual([]);
  });
});
