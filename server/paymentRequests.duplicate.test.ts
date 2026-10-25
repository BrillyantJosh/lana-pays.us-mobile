// @vitest-environment node
/**
 * POST /api/pay/:token/submit — a brain 409 DUPLICATE_* marks the request paid
 * ONLY when the purchase it collided with is this request's own attempt.
 *
 * 25 Oct 2026 (Brilly: "Popravi"). The brain's dedup matches unit + invoice
 * number OR the receipt photo hash and never compares the amount. Step 5 used
 * to read every such 409 as "my earlier attempt went through" and flip the
 * request to paid — so a DIFFERENT earlier purchase on the unit (a till sale,
 * a misread receipt number — the Alaja case of 5 Oct) made a link look paid
 * while no money arrived. Since brain a4d6582 the 409 describes the original.
 *
 * Real express server, in-memory database, a stub brain on its own port.
 * On the code before this change every "NOT paid" case fails (the request came
 * back paid); the verified-retry case fails only on the new
 * brain_transaction_id assertion — the retry healed before and still does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { initializeSchema } from './db/schema.js';
import { registerPaymentRequestRoutes } from './paymentRequests.js';
import { ensureExclusionTables } from './lib/personExclusion.js';

const UNIT = 'a'.repeat(32);
const OWNER = '1'.repeat(64);
const CUSTOMER_HEX = 'f'.repeat(64);
const CUSTOMER_WALLET = 'LbtLTSACAREiT513CVNpbg6NeE5cFbrhkC';
const ALLOCATIONS = [{ investor_hex: 'b'.repeat(64), wallet: 'LN4sFqQS2w3LiFmjMRVMvYPDuU9gsJpxef', lanoshis: 500_000_000 }];

let db: Database.Database;
let base = '';
let httpServer: any;
let brainServer: any;
let brainAnswer: { status: number; body: unknown };
let brainCalls = 0;
const savedEnv = { url: process.env.BRAIN_API_URL, purchase: process.env.BRAIN_PURCHASE_KEY };
const quiet = { log: console.log, warn: console.warn, error: console.error };

beforeAll(async () => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  const brain = express();
  brain.use(express.json());
  brain.post('/api/purchase', (_req, res) => { brainCalls++; res.status(brainAnswer.status).json(brainAnswer.body); });
  brainServer = brain.listen(0, '127.0.0.1');
  await new Promise<void>(r => brainServer.once('listening', r));
  process.env.BRAIN_API_URL = `http://127.0.0.1:${(brainServer.address() as AddressInfo).port}`;
  delete process.env.BRAIN_PURCHASE_KEY;

  db = new Database(':memory:');
  initializeSchema(db);
  ensureExclusionTables(db);
  db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event, unit_type, lana_only)
    VALUES (?, ?, ?, 1, 'Alaja test', ?, '[]', 'EUR', 'active', ?, NULL, 0)
  `).run(UNIT, 'e'.repeat(64), OWNER, OWNER, JSON.stringify({ kind: 30901, tags: [['d', UNIT]] }));

  // A fresh app per file is enough: the submit limiter allows 10 a minute and
  // this file submits fewer than that.
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

beforeEach(() => { brainCalls = 0; });

/** A pending request with a fresh preview snapshot, as the customer's page leaves it. */
function seedRequest(invoice: string, amount = 25.1): any {
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare(`
    INSERT INTO payment_requests (id, token, unit_id, merchant_hex, unit_name, amount_fiat, currency, invoice_number,
      receipt_hash, status, preview_json, preview_at)
    VALUES (?, ?, ?, ?, 'Alaja test', ?, 'EUR', ?, ?, 'pending', ?, datetime('now'))
  `).run(crypto.randomUUID(), token, UNIT, OWNER, amount, invoice, 'h'.repeat(64),
    JSON.stringify({ recipients: [], allocations: ALLOCATIONS }));
  return db.prepare('SELECT * FROM payment_requests WHERE token = ?').get(token);
}

/** A 409 the way brain a4d6582 sends it, describing an original that matches `row`. */
function dup409(row: any, over: Record<string, unknown> = {}, error = 'DUPLICATE_INVOICE') {
  return {
    status: 409,
    body: {
      success: false, error, message: error, original_tx_id: 'tx_prev', original_created_at: row.created_at,
      original: {
        id: 'tx_prev', unit_id: row.unit_id, amount: row.amount_fiat, currency: row.currency, payment_type: 'lana',
        status: 'processing', payment_status: 'LanaTX', invoice_number: row.invoice_number,
        created_at: row.created_at, settled_at: null, ...over,
      },
    },
  };
}

async function submit(token: string) {
  const r = await fetch(`${base}/api/pay/${token}/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_hex: CUSTOMER_HEX, customer_wallet: CUSTOMER_WALLET, signed_tx_hex: 'ab'.repeat(40), allocations: ALLOCATIONS }),
  });
  return { status: r.status, json: await r.json() as any };
}

const rowOf = (token: string) => db.prepare('SELECT * FROM payment_requests WHERE token = ?').get(token) as any;

async function expectStaysUnpaid(row: any, reason: string, error = 'DUPLICATE_INVOICE') {
  const r = await submit(row.token);
  expect(brainCalls).toBe(1);
  expect(r.status).toBe(409);
  expect(r.json).toMatchObject({ success: false, error, reason });
  expect(r.json.alreadyPaid).toBeUndefined();
  expect(String(r.json.message)).toMatch(/stays unpaid/);
  // The public page learns nothing about the other purchase.
  expect(r.json.original).toBeUndefined();
  expect(JSON.stringify(r.json)).not.toContain('tx_prev');
  const fresh = rowOf(row.token);
  expect(fresh.status).toBe('pending');
  expect(fresh.paid_at).toBeNull();
  expect(fresh.brain_transaction_id).toBeNull();
  expect(String(fresh.last_error)).toContain(reason);
}

describe('brain 409 DUPLICATE_* during submit', () => {
  it('the original is this request (same unit, amount, invoice, after creation) → paid, alreadyPaid', async () => {
    const row = seedRequest('TRG1-L0001-52009');
    brainAnswer = dup409(row);
    const r = await submit(row.token);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ success: true, alreadyPaid: true });
    const fresh = rowOf(row.token);
    expect(fresh.status).toBe('paid');
    expect(fresh.brain_transaction_id).toBe('tx_prev');
    expect(String(fresh.last_error)).toContain('DUPLICATE_INVOICE');
  });

  it('a colliding DIFFERENT purchase (other amount — the Alaja 10,90 € vs 25,10 € case) is NOT paid', async () => {
    const row = seedRequest('TRG1-L0001-520');
    brainAnswer = dup409(row, { amount: 10.9, payment_type: 'cash' });
    await expectStaysUnpaid(row, 'AMOUNT_MISMATCH');
  });

  it('an original on ANOTHER unit is NOT paid', async () => {
    const row = seedRequest('INV-UNIT');
    brainAnswer = dup409(row, { unit_id: 'b'.repeat(32) });
    await expectStaysUnpaid(row, 'UNIT_MISMATCH');
  });

  it('a 409 WITHOUT the original (older brain) is NOT paid', async () => {
    const row = seedRequest('INV-OLD');
    brainAnswer = { status: 409, body: { success: false, error: 'DUPLICATE_INVOICE', original_tx_id: 'tx_prev' } };
    await expectStaysUnpaid(row, 'NO_ORIGINAL');
  });

  it('the same receipt photo under ANOTHER invoice number is another purchase — NOT paid', async () => {
    const row = seedRequest('INV-PHOTO');
    brainAnswer = dup409(row, { invoice_number: 'INV-EARLIER' }, 'DUPLICATE_RECEIPT_IMAGE');
    await expectStaysUnpaid(row, 'INVOICE_MISMATCH', 'DUPLICATE_RECEIPT_IMAGE');
  });

  it('a same-amount till sale made BEFORE this request existed is another purchase — NOT paid', async () => {
    const row = seedRequest('INV-EARLY');
    brainAnswer = dup409(row, { created_at: '2026-10-05 08:50:00', payment_type: 'cash' });
    await expectStaysUnpaid(row, 'ORIGINAL_PREDATES_ORDER');
  });

  it('other currency, failed original, or an unverified broadcast: NOT paid', async () => {
    for (const [over, reason] of [
      [{ currency: 'GBP' }, 'CURRENCY_MISMATCH'],
      [{ status: 'failed' }, 'STATUS_NOT_LIVE'],
      [{ payment_status: 'BroadcastUnverified' }, 'PAYMENT_NOT_CONFIRMED'],
    ] as Array<[Record<string, unknown>, string]>) {
      brainCalls = 0;
      const row = seedRequest(`INV-${reason}`);
      brainAnswer = dup409(row, over);
      await expectStaysUnpaid(row, reason);
    }
  });
});
