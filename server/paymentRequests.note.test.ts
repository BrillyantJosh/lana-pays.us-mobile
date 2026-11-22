// @vitest-environment node
/**
 * The merchant's optional NOTE on a Lana-online payment request (22 Nov 2026,
 * Brilly: "da napišeš Note tako da lahko veš na kaj se nanaša to plačilo";
 * Kati Rina: "da napišeš komu pošiljaš zahtevek").
 *
 * Pinned here, on a real express server, an in-memory database and a stub brain:
 *   - the note is cleaned (one line, no control or direction marks, at most
 *     200 characters) and stored; no note / an empty one / a non-string → null;
 *   - it comes back on the create answer, the merchant list, the signed
 *     "Online payments" overview and the payer's public /api/pay/:token view;
 *   - it is DESCRIPTIVE ONLY: the brain purchase body is byte-for-byte the same
 *     with or without a note — no `note` field, the note text nowhere in it —
 *     and amount, currency and invoice are taken from the row as before;
 *   - an existing database without the column gets it at start-up.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { initializeSchema } from './db/schema.js';
import { registerPaymentRequestRoutes } from './paymentRequests.js';
import { ensureExclusionTables } from './lib/personExclusion.js';
import { cleanRequestNote, REQUEST_NOTE_MAX } from './lib/requestNote.js';

const UNIT = 'a'.repeat(32);
const sk = generateSecretKey();
const OWNER = getPublicKey(sk);
const CUSTOMER_HEX = 'f'.repeat(64);
const CUSTOMER_WALLET = 'LbtLTSACAREiT513CVNpbg6NeE5cFbrhkC';
const ALLOCATIONS = [{ investor_hex: 'b'.repeat(64), wallet: 'LN4sFqQS2w3LiFmjMRVMvYPDuU9gsJpxef', lanoshis: 500_000_000 }];

let db: Database.Database;
let base = '';
let httpServer: any;
let brainServer: any;
const brainBodies: string[] = [];
const savedEnv = { url: process.env.BRAIN_API_URL, purchase: process.env.BRAIN_PURCHASE_KEY, peer: process.env.BRAIN_PEER_KEY };
const quiet = { log: console.log, warn: console.warn, error: console.error };

beforeAll(async () => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  const brain = express();
  brain.use(express.text({ type: '*/*' }));
  brain.post('/api/purchase', (req, res) => {
    brainBodies.push(String(req.body));
    res.json({ success: true, data: { transaction_id: crypto.randomUUID(), tx_hash: 'c'.repeat(64), summary: {} } });
  });
  brain.get('/api/peer/purchase-payouts', (_req, res) => res.json({ checked_at: new Date().toISOString(), transactions: {} }));
  brainServer = brain.listen(0, '127.0.0.1');
  await new Promise<void>(r => brainServer.once('listening', r));
  process.env.BRAIN_API_URL = `http://127.0.0.1:${(brainServer.address() as AddressInfo).port}`;
  delete process.env.BRAIN_PURCHASE_KEY;
  process.env.BRAIN_PEER_KEY = 'test-peer-key';

  db = new Database(':memory:');
  initializeSchema(db);
  ensureExclusionTables(db);
  db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event, unit_type, lana_only)
    VALUES (?, ?, ?, 1, 'Note test shop', ?, '[]', 'EUR', 'active', ?, NULL, 0)
  `).run(UNIT, 'e'.repeat(64), OWNER, OWNER, JSON.stringify({ kind: 30901, tags: [['d', UNIT]] }));

  const app = express();
  app.use(express.json());
  registerPaymentRequestRoutes(app, db);
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => httpServer.once('listening', r));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(r => httpServer.close(r));
  await new Promise(r => brainServer.close(r));
  db.close();
  Object.assign(console, quiet);
  for (const [k, v] of [['BRAIN_API_URL', savedEnv.url], ['BRAIN_PURCHASE_KEY', savedEnv.purchase], ['BRAIN_PEER_KEY', savedEnv.peer]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

async function create(invoice: string, extra: Record<string, unknown> = {}) {
  const r = await fetch(`${base}/api/payment-requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unit_id: UNIT, merchant_hex: OWNER, amount: 12.5, currency: 'EUR', invoice_number: invoice, ...extra }),
  });
  return { status: r.status, json: await r.json() as any };
}

const rowById = (id: string) => db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id) as any;

/** Pay a request through the public route, with a fresh preview snapshot in place. */
async function pay(token: string) {
  db.prepare(`UPDATE payment_requests SET preview_json = ?, preview_at = datetime('now') WHERE token = ?`)
    .run(JSON.stringify({ recipients: [], allocations: ALLOCATIONS }), token);
  const r = await fetch(`${base}/api/pay/${token}/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_hex: CUSTOMER_HEX, customer_wallet: CUSTOMER_WALLET, signed_tx_hex: 'ab'.repeat(40), allocations: ALLOCATIONS }),
  });
  return { status: r.status, json: await r.json() as any };
}

describe('cleanRequestNote', () => {
  it('keeps ordinary text as typed', () => {
    expect(cleanRequestNote('Za Kati — najem sobe, november 🌿')).toBe('Za Kati — najem sobe, november 🌿');
  });
  it('one line: line breaks and tabs become one space, ends are trimmed', () => {
    expect(cleanRequestNote('  Janez\r\n\tdelavnica  5. 12.\n')).toBe('Janez delavnica 5. 12.');
  });
  it('drops control characters and the direction marks that can reorder text on screen', () => {
    expect(cleanRequestNote('abc\u0000\u0007def')).toBe('abc def');
    expect(cleanRequestNote('pay ‮txt.exe‬ now‏﻿')).toBe('pay txt.exe now');
  });
  it('no note, an empty one, or one of only spaces → null', () => {
    for (const v of [undefined, null, '', '   ', '\n\t', '‮']) expect(cleanRequestNote(v)).toBeNull();
  });
  it('anything that is not a string → null, never "[object Object]"', () => {
    for (const v of [{ a: 1 }, ['x'], 42, true]) expect(cleanRequestNote(v)).toBeNull();
  });
  it(`cut at ${REQUEST_NOTE_MAX} characters, counting an emoji as one and never splitting it`, () => {
    expect(cleanRequestNote('x'.repeat(500))).toBe('x'.repeat(REQUEST_NOTE_MAX));
    const emoji = '🌿'.repeat(REQUEST_NOTE_MAX + 5);
    const out = cleanRequestNote(emoji)!;
    expect(Array.from(out)).toHaveLength(REQUEST_NOTE_MAX);
    expect(out).toBe('🌿'.repeat(REQUEST_NOTE_MAX));
  });
  it('a lone surrogate half is dropped', () => {
    expect(cleanRequestNote('a\uD800b')).toBe('ab');
  });
});

describe('POST /api/payment-requests stores the note', () => {
  it('cleaned, on the row and in the answer', async () => {
    const r = await create('N-1', { note: '  Za Kati\nnajem  ' });
    expect(r.status).toBe(201);
    expect(r.json.request.note).toBe('Za Kati najem');
    expect(rowById(r.json.request.id).note).toBe('Za Kati najem');
  });
  it('without a note → null (old clients keep working)', async () => {
    const r = await create('N-2');
    expect(r.status).toBe(201);
    expect(r.json.request.note).toBeNull();
    expect(rowById(r.json.request.id).note).toBeNull();
  });
  it('a too long note is cut to 200, a non-string note is ignored — the request is still made', async () => {
    const long = await create('N-3', { note: 'y'.repeat(1000) });
    expect(long.status).toBe(201);
    expect(rowById(long.json.request.id).note).toBe('y'.repeat(REQUEST_NOTE_MAX));
    const obj = await create('N-4', { note: { evil: true } });
    expect(obj.status).toBe(201);
    expect(rowById(obj.json.request.id).note).toBeNull();
  });
  it('the note changes nothing else on the row', async () => {
    const a = rowById((await create('N-5', { note: 'Janez' })).json.request.id);
    const b = rowById((await create('N-6')).json.request.id);
    for (const k of ['unit_id', 'merchant_hex', 'unit_name', 'amount_fiat', 'currency', 'status', 'receipt_description']) {
      expect(a[k], k).toEqual(b[k]);
    }
  });
});

describe('the note is shown back', () => {
  it('in the merchant list', async () => {
    const r = await fetch(`${base}/api/payment-requests?unit_id=${UNIT}&hex=${OWNER}&limit=50`);
    const json = await r.json() as any;
    const byInvoice = new Map(json.requests.map((x: any) => [x.invoice_number, x.note]));
    expect(byInvoice.get('N-1')).toBe('Za Kati najem');
    expect(byInvoice.get('N-2')).toBeNull();
  });
  it('in the signed "Online payments" overview', async () => {
    const PATH = '/api/payment-requests/overview';
    const ev = finalizeEvent({
      kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '',
      tags: [['u', PATH], ['method', 'GET'], ['nonce', crypto.randomBytes(16).toString('hex')]],
    }, sk);
    const r = await fetch(`${base}${PATH}?limit=50`, { headers: { Authorization: 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64') } });
    expect(r.status).toBe(200);
    const json = await r.json() as any;
    const byInvoice = new Map(json.requests.map((x: any) => [x.invoice_number, x.note]));
    expect(byInvoice.get('N-1')).toBe('Za Kati najem');
    expect(byInvoice.get('N-2')).toBeNull();
  });
  it('on the payer\'s public view', async () => {
    const row = db.prepare("SELECT token FROM payment_requests WHERE invoice_number = 'N-1'").get() as any;
    const r = await fetch(`${base}/api/pay/${row.token}`);
    expect((await r.json() as any).request.note).toBe('Za Kati najem');
    const none = db.prepare("SELECT token FROM payment_requests WHERE invoice_number = 'N-2'").get() as any;
    expect((await (await fetch(`${base}/api/pay/${none.token}`)).json() as any).request.note).toBeNull();
  });
});

describe('the note never reaches the brain', () => {
  it('the purchase body is the same with and without a note — no `note` field, the text nowhere in it', async () => {
    const NOTE = 'Kati Rina — ZASEBNA-OPOMBA-123';
    const withNote = (await create('B-1', { note: NOTE })).json.request;
    const without = (await create('B-1x')).json.request;
    brainBodies.length = 0;
    expect((await pay(withNote.token)).status).toBe(200);
    expect((await pay(without.token)).status).toBe(200);
    expect(brainBodies).toHaveLength(2);
    const [a, b] = brainBodies.map(s => JSON.parse(s));
    expect(brainBodies[0]).not.toContain('ZASEBNA-OPOMBA');
    expect(brainBodies[0]).not.toContain('Kati Rina');
    expect('note' in a).toBe(false);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    // Only the invoice number differs between the two requests.
    expect({ ...a, invoice_number: '' }).toEqual({ ...b, invoice_number: '' });
    expect(a.amount).toBe(12.5);
    expect(a.currency).toBe('EUR');
    expect(a.invoice_number).toBe('B-1');
  });
});

describe('an existing database without the column', () => {
  it('gets `note` at start-up, keeps its rows, and a second start-up is harmless', () => {
    const old = new Database(':memory:');
    old.exec(`CREATE TABLE payment_requests (
      id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, unit_id TEXT NOT NULL, merchant_hex TEXT NOT NULL,
      unit_name TEXT NOT NULL, amount_fiat REAL NOT NULL, currency TEXT NOT NULL, invoice_number TEXT NOT NULL,
      receipt_url TEXT, receipt_hash TEXT, receipt_type TEXT, receipt_description TEXT,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')), expires_at TEXT,
      paying_started_at TEXT, paid_at TEXT, brain_transaction_id TEXT, tx_hash TEXT, paid_lana_lanoshis INTEGER,
      paid_exchange_rate REAL, paid_split TEXT, customer_hex TEXT, customer_wallet TEXT, customer_name TEXT,
      preview_json TEXT, preview_at TEXT, last_error TEXT, last_error_at TEXT, seen_by_merchant INTEGER DEFAULT 0)`);
    old.prepare(`INSERT INTO payment_requests (id, token, unit_id, merchant_hex, unit_name, amount_fiat, currency, invoice_number)
      VALUES ('old1', 't1', ?, ?, 'Old', 3, 'EUR', 'OLD-1')`).run(UNIT, OWNER);
    initializeSchema(old);
    initializeSchema(old);
    const cols = (old.pragma('table_info(payment_requests)') as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('note');
    const row = old.prepare("SELECT * FROM payment_requests WHERE id = 'old1'").get() as any;
    expect(row.invoice_number).toBe('OLD-1');
    expect(row.note).toBeNull();
    old.close();
  });
});
