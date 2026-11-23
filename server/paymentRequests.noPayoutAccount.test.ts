// @vitest-environment node
/**
 * Lana-online for a shop without a company and without a bank account
 * (KIND 30901 payout_account "none", 23 Nov 2026).
 *
 * A link is paid in LANA through the brain, and such a shop takes no LANA that
 * way. So: no link is made, an old link shows as closed from the first page
 * load, and its preview and submit are refused before the brain is asked and
 * before the atomic claim. No stored row is changed. Every other shop's link
 * works exactly as before.
 *
 * Real express server, in-memory database, a stub brain on its own port.
 * The pay limiter allows 10 preview+submit calls a minute per address: this
 * file makes fewer than that.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { initializeSchema } from './db/schema.js';
import { registerPaymentRequestRoutes } from './paymentRequests.js';
import { ensureExclusionTables } from './lib/personExclusion.js';

const NO_COMPANY = 'a'.repeat(32);
const COMPANY = 'b'.repeat(32);
const OWNER = '1'.repeat(64);
const CUSTOMER_HEX = 'f'.repeat(64);
const CUSTOMER_WALLET = 'LbtLTSACAREiT513CVNpbg6NeE5cFbrhkC';
const ALLOCATIONS = [{ investor_hex: 'b'.repeat(64), wallet: 'LN4sFqQS2w3LiFmjMRVMvYPDuU9gsJpxef', lanoshis: 500_000_000 }];

let db: Database.Database;
let base = '';
let httpServer: any;
let brainServer: any;
const brainCalls: string[] = [];
const savedEnv = { url: process.env.BRAIN_API_URL, purchase: process.env.BRAIN_PURCHASE_KEY };
const quiet = { log: console.log, warn: console.warn, error: console.error };

const event = (unitId: string, tags: string[][]) => JSON.stringify({ kind: 30901, tags: [['d', unitId], ...tags], content: '' });

beforeAll(async () => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  const brain = express();
  brain.use(express.json());
  brain.post('/api/purchase/preview-lana-recipients', (_req, res) => {
    brainCalls.push('preview');
    res.json({ success: true, data: { recipients: [{ address: ALLOCATIONS[0].wallet, amount_lanoshis: 500_000_000 }], allocations: ALLOCATIONS } });
  });
  brain.post('/api/purchase', (_req, res) => {
    brainCalls.push('purchase');
    res.json({ success: true, data: { transaction_id: 'tx_1', tx_hash: 'c'.repeat(64), summary: { lana_for_investor: 500_000_000, exchange_rate: 0.256 } } });
  });
  brainServer = brain.listen(0, '127.0.0.1');
  await new Promise<void>(r => brainServer.once('listening', r));
  process.env.BRAIN_API_URL = `http://127.0.0.1:${(brainServer.address() as AddressInfo).port}`;
  delete process.env.BRAIN_PURCHASE_KEY;

  db = new Database(':memory:');
  initializeSchema(db);
  ensureExclusionTables(db);
  const unit = db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event, unit_type, lana_only)
    VALUES (?, ?, ?, 1, ?, ?, '[]', 'EUR', 'active', ?, NULL, 0)
  `);
  unit.run(NO_COMPANY, 'e'.repeat(64), OWNER, 'Kmetija brez podjetja', OWNER,
    event(NO_COMPANY, [['payout_account', 'none'], ['margin_percent', '10'], ['lanapays_payout_wallet', CUSTOMER_WALLET]]));
  unit.run(COMPANY, 'd'.repeat(64), OWNER, 'Podjetje d.o.o.', OWNER,
    event(COMPANY, [['receiver_type', 'company'], ['bank_account', 'SI56 1920 0123 4567 892']]));

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
  if (savedEnv.url === undefined) delete process.env.BRAIN_API_URL; else process.env.BRAIN_API_URL = savedEnv.url;
  if (savedEnv.purchase === undefined) delete process.env.BRAIN_PURCHASE_KEY; else process.env.BRAIN_PURCHASE_KEY = savedEnv.purchase;
});

beforeEach(() => { brainCalls.length = 0; });

/** A request row as the merchant's tab leaves it, with a fresh preview snapshot. */
function seedRequest(unitId: string, status = 'pending', invoice = `R-${crypto.randomUUID().slice(0, 8)}`): any {
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare(`
    INSERT INTO payment_requests (id, token, unit_id, merchant_hex, unit_name, amount_fiat, currency, invoice_number,
      status, preview_json, preview_at, paid_at, tx_hash)
    VALUES (?, ?, ?, ?, 'Shop', 12.5, 'EUR', ?, ?, ?, datetime('now'), ?, ?)
  `).run(crypto.randomUUID(), token, unitId, OWNER, invoice, status,
    JSON.stringify({ recipients: [], allocations: ALLOCATIONS }),
    status === 'paid' ? '2026-11-20 10:00:00' : null, status === 'paid' ? 'c'.repeat(64) : null);
  return db.prepare('SELECT * FROM payment_requests WHERE token = ?').get(token);
}

const rowOf = (token: string) => db.prepare('SELECT * FROM payment_requests WHERE token = ?').get(token) as any;
const count = () => (db.prepare('SELECT COUNT(*) AS n FROM payment_requests').get() as any).n;

async function post(path: string, body: unknown) {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
}
async function view(token: string) {
  const r = await fetch(`${base}/api/pay/${token}`);
  return { status: r.status, json: await r.json() as any };
}
const customer = { customer_hex: CUSTOMER_HEX, customer_wallet: CUSTOMER_WALLET };

describe('POST /api/payment-requests', () => {
  const create = (unitId: string) => post('/api/payment-requests', { unit_id: unitId, merchant_hex: OWNER, amount: 12.5, currency: 'EUR', invoice_number: `INV-${unitId.slice(0, 2)}` });

  it('a shop without a bank account gets no link: 409 UNIT_NO_PAYOUT_ACCOUNT, nothing stored', async () => {
    const before = count();
    const r = await create(NO_COMPANY);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ success: false, code: 'UNIT_NO_PAYOUT_ACCOUNT' });
    expect(r.json.error).toMatch(/no bank account/);
    expect(count()).toBe(before);
  });

  it('a company unit gets its link as before', async () => {
    const r = await create(COMPANY);
    expect(r.status).toBe(201);
    expect(r.json.request.status).toBe('pending');
  });
});

describe('GET /api/pay/:token — the customer\'s first page load', () => {
  it('an open link of a shop without a bank account shows as closed, and the row stays as it is', async () => {
    const row = seedRequest(NO_COMPANY);
    const r = await view(row.token);
    expect(r.status).toBe(200);
    expect(r.json.request.status).toBe('closed');
    expect(r.json.request.closedReason).toBe('UNIT_NO_PAYOUT_ACCOUNT');
    expect(rowOf(row.token).status).toBe('pending');
  });

  it('a payment already on its way (paying) shows as closed too', async () => {
    const row = seedRequest(NO_COMPANY, 'paying');
    expect((await view(row.token)).json.request.status).toBe('closed');
    expect(rowOf(row.token).status).toBe('paying');
  });

  it('a link that was paid, cancelled or expired shows as it was', async () => {
    expect((await view(seedRequest(NO_COMPANY, 'paid').token)).json.request.status).toBe('paid');
    expect((await view(seedRequest(NO_COMPANY, 'cancelled').token)).json.request.status).toBe('cancelled');
    expect((await view(seedRequest(NO_COMPANY, 'expired').token)).json.request.status).toBe('expired');
  });

  it('every other shop\'s link: the same answer as before, no new field', async () => {
    const row = seedRequest(COMPANY);
    const r = await view(row.token);
    expect(r.json.request.status).toBe('pending');
    expect(r.json.request).not.toHaveProperty('closedReason');
    expect(Object.keys(r.json.request)).toEqual([
      'unitName', 'amountFiat', 'currency', 'invoiceNumber', 'receiptUrl', 'receiptDescription', 'note', 'status',
      'createdAt', 'expiresAt', 'paidAt', 'txHash', 'paidLanaLanoshis', 'paidExchangeRate', 'indicativeRate', 'indicativeLanaLanoshis',
    ]);
  });
});

describe('POST /api/pay/:token/preview', () => {
  it('a shop without a bank account: refused before the brain is asked', async () => {
    const row = seedRequest(NO_COMPANY);
    const r = await post(`/api/pay/${row.token}/preview`, customer);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('UNIT_NO_PAYOUT_ACCOUNT');
    expect(brainCalls).toEqual([]);
    expect(rowOf(row.token).status).toBe('pending');
  });

  it('a company unit: the brain previews as before', async () => {
    const row = seedRequest(COMPANY);
    const r = await post(`/api/pay/${row.token}/preview`, customer);
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(brainCalls).toEqual(['preview']);
  });
});

describe('POST /api/pay/:token/submit', () => {
  const submit = (token: string) => post(`/api/pay/${token}/submit`, { ...customer, signed_tx_hex: 'ab'.repeat(40), allocations: ALLOCATIONS });

  it('a shop without a bank account: refused BEFORE the claim — the request stays pending, nothing is sent', async () => {
    const row = seedRequest(NO_COMPANY);
    const r = await submit(row.token);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('UNIT_NO_PAYOUT_ACCOUNT');
    expect(brainCalls).toEqual([]);
    const fresh = rowOf(row.token);
    expect(fresh.status).toBe('pending');
    expect(fresh.paying_started_at).toBeNull();
    expect(fresh.last_error).toBeNull();
  });

  it('a company unit: claimed, sent to the brain and paid, as before', async () => {
    const row = seedRequest(COMPANY);
    const r = await submit(row.token);
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(brainCalls).toEqual(['purchase']);
    expect(rowOf(row.token).status).toBe('paid');
  });
});
