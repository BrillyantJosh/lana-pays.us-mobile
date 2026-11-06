// @vitest-environment node
/**
 * POST /api/brain/purchase: which limits a sale meets on its way to the brain.
 *
 * Brilly, 6 Nov 2026: the rolling per-customer window goes away. What stays for
 * a CASH sale is the per-invoice limit (an invoice above it is reduced to it,
 * with a notice) and the unit's monthly limits (volume reduces to what remains,
 * the count refuses). A LANA sale meets none of them.
 *
 * Real handler, real schema in memory, a stub brain on its own port that records
 * every request it gets. The stub is ready to answer the old customer-window
 * lookup with the customer's real spending, so if the lookup ever came back the
 * tests would see both the call and the reduced amount.
 *
 * The numbers are from production: Bio s kmetij (limit 200) recorded an invoice
 * of 188.94 as 7.56 because the same customer had paid 192.44 the evening
 * before; BiOMA (limit 100) recorded 100.00 as 36.33 after 63.67 the day before.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'net';
import { initializeSchema } from './db/schema.js';
import { brainPurchaseHandler } from './brainPurchase.js';

const UNIT = '1e3e722ad51d39b4c91039a9112c021e';
const CUSTOMER = { customer_hex: 'c'.repeat(64), customer_wallet: 'LbtLTSACAREiT513CVNpbg6NeE5cFbrhkC' };

let db: Database.Database;
let base = '';
let httpServer: any;
let brainServer: any;
let brainAnswer: { status: number; body: unknown };
let customerSpent = 0;
const brainRequests: Array<{ path: string; body: any }> = [];
const quiet = { log: console.log, warn: console.warn, error: console.error };

const forwarded = () => brainRequests.filter(r => r.path === '/api/purchase');
const windowLookups = () => brainRequests.filter(r => r.path.includes('customer-window'));

beforeAll(async () => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  const brain = express();
  brain.use(express.json());
  brain.use((req, _res, next) => { brainRequests.push({ path: req.path, body: req.body }); next(); });
  brain.get('/api/purchase/customer-window', (_req, res) => {
    res.json({ spent: customerSpent, count: 1, days: 1, currency: 'EUR' });
  });
  brain.post('/api/purchase', (_req, res) => { res.status(brainAnswer.status).json(brainAnswer.body); });
  brainServer = brain.listen(0, '127.0.0.1');
  await new Promise<void>(r => brainServer.once('listening', r));
  const brainUrl = `http://127.0.0.1:${(brainServer.address() as AddressInfo).port}`;

  db = new Database(':memory:');
  initializeSchema(db);

  const app = express();
  app.use(express.json());
  app.post('/api/brain/purchase', brainPurchaseHandler(db, brainUrl, 'test-key'));
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => httpServer.once('listening', r));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(r => httpServer.close(r));
  await new Promise(r => brainServer.close(r));
  db.close();
  Object.assign(console, quiet);
});

interface UnitOpts {
  maxTx?: string;
  status?: string;
  volumeUsed?: number;
  volumeLimit?: number;
  txUsed?: number;
  txLimit?: number;
}

/** The unit the way the heartbeat leaves it: KIND 30901 + 30903 + 30902. */
function seed(o: UnitOpts = {}) {
  db.prepare('DELETE FROM business_units').run();
  db.prepare('DELETE FROM fee_policies').run();
  db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status,
      suspension_status, quota_volume_used, quota_volume_limit, quota_tx_used, quota_tx_limit, quota_currency, quota_period)
    VALUES (?, 'ev', 'pk', 1, 'Bio s kmetij', 'o', '[]', 'EUR', 'active', ?, ?, ?, ?, ?, 'EUR', '2026-11')
  `).run(UNIT, o.status ?? 'active', o.volumeUsed ?? 400, o.volumeLimit ?? 1000, o.txUsed ?? 4, o.txLimit ?? 50);
  db.prepare(`
    INSERT INTO fee_policies (unit_id, event_id, pubkey, created_at, lana_discount_per, lanapays_us_per, max_tx_amount, max_tx_currency, status)
    VALUES (?, 'ev', 'pk', 1, '5.00', '5.00', ?, 'EUR', 'active')
  `).run(UNIT, o.maxTx ?? '200.00');
}

async function sell(body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/brain/purchase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unit_id: UNIT, currency: 'EUR', invoice_number: 'INV-1', ...body }),
  });
  return { status: res.status, body: await res.json() as any };
}

const cashSale = (amount: number) => ({ payment_type: 'cash', amount, ...CUSTOMER });

beforeEach(() => {
  brainRequests.length = 0;
  customerSpent = 0;
  brainAnswer = { status: 200, body: { success: true, data: { transaction_id: 'tx_1' } } };
  db.prepare("DELETE FROM fund_capacity").run();
  db.prepare("UPDATE app_settings SET value = '0' WHERE key = 'default_max_tx_amount'").run();
  db.prepare("UPDATE app_settings SET value = 'false' WHERE key = 'split_happening'").run();
});

describe('earlier purchases of the same customer play no part', () => {
  it('192.44 the evening before, invoice 188.94 under a limit of 200: recorded as 188.94, not 7.56', async () => {
    seed({ maxTx: '200.00' });
    customerSpent = 192.44;
    const r = await sell(cashSale(188.94));

    expect(r.status).toBe(200);
    expect(forwarded()).toHaveLength(1);
    expect(forwarded()[0].body.amount).toBe(188.94);
    expect(r.body.amount_adjusted).toBeUndefined();
  });

  it('63.67 the day before, invoice 100.00 under a limit of 100: recorded as 100.00, not 36.33', async () => {
    seed({ maxTx: '100.00', volumeUsed: 558.66, volumeLimit: 3000, txUsed: 7, txLimit: 100 });
    customerSpent = 63.67;
    const r = await sell(cashSale(100));

    expect(r.status).toBe(200);
    expect(forwarded()[0].body.amount).toBe(100);
    expect(r.body.amount_adjusted).toBeUndefined();
  });

  it('a customer who has already spent the whole limit is not refused', async () => {
    seed({ maxTx: '100.00' });
    customerSpent = 100;
    const r = await sell(cashSale(19.9));

    expect(r.status).toBe(200);
    expect(forwarded()[0].body.amount).toBe(19.9);
  });

  it('nothing is ever asked of customer-window, with a hex, a wallet or both', async () => {
    seed({ maxTx: '200.00' });
    customerSpent = 192.44;
    await sell({ payment_type: 'cash', amount: 188.94, customer_hex: CUSTOMER.customer_hex });
    await sell({ payment_type: 'cash', amount: 188.94, customer_wallet: CUSTOMER.customer_wallet });
    await sell(cashSale(188.94));

    expect(forwarded()).toHaveLength(3);
    expect(windowLookups()).toEqual([]);
  });
});

describe('the per-invoice limit stays: above it, reduced with a notice', () => {
  it('invoice 250 under a limit of 200 is recorded as 200 and the till is told', async () => {
    seed({ maxTx: '200.00' });
    const r = await sell(cashSale(250));

    expect(r.status).toBe(200);
    expect(forwarded()[0].body.amount).toBe(200);
    expect(r.body.amount_adjusted).toEqual({ original: 250, adjusted: 200, currency: 'EUR' });
  });

  it('exactly at the limit is not an adjustment', async () => {
    seed({ maxTx: '200.00' });
    const r = await sell(cashSale(200));

    expect(forwarded()[0].body.amount).toBe(200);
    expect(r.body.amount_adjusted).toBeUndefined();
  });

  it('the smallest of merchant limit, fund capacity and default wins', async () => {
    seed({ maxTx: '200.00' });
    db.prepare(`INSERT INTO fund_capacity (currency, total_available, max_single_budget, investor_count, blocked_count, fetched_at)
      VALUES ('EUR', 500, 150, 1, 0, datetime('now'))`).run();
    const byFund = await sell(cashSale(188.94));
    expect(forwarded()[0].body.amount).toBe(150);
    expect(byFund.body.amount_adjusted).toEqual({ original: 188.94, adjusted: 150, currency: 'EUR' });

    db.prepare("UPDATE app_settings SET value = '120' WHERE key = 'default_max_tx_amount'").run();
    await sell(cashSale(188.94));
    expect(forwarded()[1].body.amount).toBe(120);
  });
});

describe('the monthly limits stay', () => {
  it('remaining volume smaller than the invoice: reduced to what remains, with the notice', async () => {
    seed({ maxTx: '200.00', volumeUsed: 900, volumeLimit: 1000 });
    const r = await sell(cashSale(188.94));

    expect(r.status).toBe(200);
    expect(forwarded()[0].body.amount).toBe(100);
    expect(r.body.amount_adjusted).toEqual({ original: 188.94, adjusted: 100, currency: 'EUR' });
  });

  it('volume used up: refused, nothing reaches the brain', async () => {
    seed({ maxTx: '200.00', volumeUsed: 1000, volumeLimit: 1000 });
    const r = await sell(cashSale(188.94));

    expect(r.status).toBe(403);
    expect(r.body.error).toBe('MERCHANT_QUOTA_EXCEEDED');
    expect(forwarded()).toEqual([]);
  });

  it('transaction count reached: refused, a count cannot be reduced', async () => {
    seed({ maxTx: '200.00', txUsed: 50, txLimit: 50 });
    const r = await sell(cashSale(19.9));

    expect(r.status).toBe(403);
    expect(r.body.error).toBe('MERCHANT_QUOTA_EXCEEDED');
    expect(r.body.message).toBe('Monthly cash transaction limit reached');
    expect(forwarded()).toEqual([]);
  });

  it('one transaction left: the sale goes through', async () => {
    seed({ maxTx: '200.00', txUsed: 49, txLimit: 50 });
    const r = await sell(cashSale(19.9));

    expect(r.status).toBe(200);
    expect(forwarded()[0].body.amount).toBe(19.9);
  });

  it('quota_blocked: refused', async () => {
    seed({ status: 'quota_blocked' });
    const r = await sell(cashSale(19.9));

    expect(r.status).toBe(403);
    expect(r.body.error).toBe('MERCHANT_QUOTA_EXCEEDED');
    expect(forwarded()).toEqual([]);
  });
});

describe('the rest of a month can be less than a cent', () => {
  // A monthly counter is a sum of floats. A shop that reached its limit exactly
  // can stand at 2999.9999999999995 of 3000: not at the limit, nothing to charge.
  it('refused as the month being used up, not forwarded with an amount of 0', async () => {
    seed({ maxTx: '200.00', volumeUsed: 2999.9999999999995, volumeLimit: 3000 });
    const r = await sell(cashSale(100));

    expect(r.status).toBe(403);
    expect(r.body.error).toBe('MERCHANT_QUOTA_EXCEEDED');
    expect(forwarded()).toEqual([]);
  });
});

describe('unit_id must be one string', () => {
  // Every check here looks at a string, and the body is forwarded as it came.
  it.each([
    ['an array', [UNIT]],
    ['an object', { unit: UNIT }],
    ['a number', 1],
  ])('%s is refused, on cash and on LANA, and nothing reaches the brain', async (_label, unit_id) => {
    seed({ maxTx: '200.00' });
    const cash = await sell({ ...cashSale(10000), unit_id });
    const lana = await sell({ payment_type: 'lana', amount: 10000, signed_tx_hex: 'ab', ...CUSTOMER, unit_id });

    expect(cash.status).toBe(400);
    expect(lana.status).toBe(400);
    expect(forwarded()).toEqual([]);
  });
});

describe('a LANA sale is untouched', () => {
  const lanaSale = (amount: number) => ({ payment_type: 'lana', amount, signed_tx_hex: 'ab', ...CUSTOMER });

  it('above the invoice limit, with an earlier purchase of the same customer', async () => {
    seed({ maxTx: '200.00' });
    customerSpent = 192.44;
    const r = await sell(lanaSale(999));

    expect(r.status).toBe(200);
    expect(forwarded()[0].body.amount).toBe(999);
    expect(r.body.amount_adjusted).toBeUndefined();
    expect(windowLookups()).toEqual([]);
  });

  it('with both monthly limits used up and the unit quota_blocked', async () => {
    seed({ status: 'quota_blocked', volumeUsed: 1000, volumeLimit: 1000, txUsed: 50, txLimit: 50 });
    const r = await sell(lanaSale(999));

    expect(r.status).toBe(200);
    expect(forwarded()[0].body.amount).toBe(999);
  });
});

describe('the check run on the live server after a deploy', () => {
  // ops_mobile_cash_clamp: a POST with no customer. The reduction happens before
  // the forward, and the brain answers 400 "Missing required fields" without
  // creating a purchase. It stays safe only while no field below is added.
  it('a cash POST with no customer is reduced, forwarded without one, and answered with the brain\'s 400', async () => {
    seed({ maxTx: '200.00' });
    brainAnswer = { status: 400, body: { error: 'Missing required fields' } };
    const r = await sell({ payment_type: 'cash', amount: 10000 });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Missing required fields');
    expect(r.body.amount_adjusted).toBeUndefined();
    expect(forwarded()).toHaveLength(1);
    expect(forwarded()[0].body.amount).toBe(200);
    expect(forwarded()[0].body.customer_hex).toBeUndefined();
    expect(forwarded()[0].body.customer_wallet).toBeUndefined();
    expect(windowLookups()).toEqual([]);
  });
});
