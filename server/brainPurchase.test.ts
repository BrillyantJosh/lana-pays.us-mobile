// @vitest-environment node
/**
 * POST /api/brain/purchase: which limits a cash sale meets on its way to the brain.
 *
 * In order: a maximum of 0 refuses, the rest of the month folds in, the same
 * customer's window folds in, the clamp reduces, the month's volume and count are
 * checked, and the brain has the last word. A LANA sale meets none of them.
 *
 * Real handler, real schema in memory, a stub brain on its own port that records
 * every request it gets. The numbers are from production: Bio s kmetij (limit 200)
 * recorded an invoice of 188.94 as 7.56 because the same customer had paid 192.44
 * the evening before; BiOMA (limit 100) recorded 100.00 as 36.33 after 63.67 the day
 * before.
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
/** What the brain's customer-window answers: a sum spent, or a way of failing. */
let lookup: { spent?: number; status?: number; hangUp?: boolean };
const brainRequests: Array<{ path: string; body: any; query: any }> = [];
const quiet = { log: console.log, warn: console.warn, error: console.error };

const forwarded = () => brainRequests.filter(r => r.path === '/api/purchase');
const windowLookups = () => brainRequests.filter(r => r.path.includes('customer-window'));

beforeAll(async () => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  const brain = express();
  brain.use(express.json());
  brain.use((req, _res, next) => { brainRequests.push({ path: req.path, body: req.body, query: req.query }); next(); });
  brain.get('/api/purchase/customer-window', (req, res) => {
    if (lookup.hangUp) { req.socket.destroy(); return; }
    if (lookup.status) { res.status(lookup.status).json({ error: 'no' }); return; }
    res.json({ spent: lookup.spent ?? 0, count: 1, days: Number(req.query.days), currency: req.query.currency });
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
  maxTxCurrency?: string;
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
    VALUES (?, 'ev', 'pk', 1, '5.00', '5.00', ?, ?, 'active')
  `).run(UNIT, o.maxTx ?? '200.00', o.maxTxCurrency ?? 'EUR');
}

const fundCapacity = (maxSingle: number) => db.prepare(`
  INSERT INTO fund_capacity (currency, total_available, max_single_budget, investor_count, blocked_count, fetched_at)
  VALUES ('EUR', ?, ?, 0, 0, datetime('now'))
`).run(maxSingle, maxSingle);

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
  lookup = { spent: 0 };
  brainAnswer = { status: 200, body: { success: true, data: { transaction_id: 'tx_1' } } };
  db.prepare("DELETE FROM fund_capacity").run();
  db.prepare("UPDATE app_settings SET value = '0' WHERE key = 'default_max_tx_amount'").run();
  db.prepare("UPDATE app_settings SET value = '1' WHERE key = 'customer_window_days'").run();
  db.prepare("UPDATE app_settings SET value = 'false' WHERE key = 'split_happening'").run();
});

describe('the same customer\'s window', () => {
  it('192.44 the evening before, invoice 188.94 under a limit of 200: recorded as 7.56, and the till is told', async () => {
    seed({ maxTx: '200.00' });
    lookup = { spent: 192.44 };
    const r = await sell(cashSale(188.94));

    expect(r.status).toBe(200);
    expect(forwarded()).toHaveLength(1);
    expect(forwarded()[0].body.amount).toBe(7.56);
    expect(r.body.amount_adjusted).toEqual({ original: 188.94, adjusted: 7.56, currency: 'EUR' });
  });

  it('63.67 the day before, invoice 100.00 under a limit of 100: recorded as 36.33', async () => {
    seed({ maxTx: '100.00', volumeUsed: 558.66, volumeLimit: 3000, txUsed: 7, txLimit: 100 });
    lookup = { spent: 63.67 };
    const r = await sell(cashSale(100));

    expect(r.status).toBe(200);
    expect(forwarded()[0].body.amount).toBe(36.33);
    expect(r.body.amount_adjusted).toEqual({ original: 100, adjusted: 36.33, currency: 'EUR' });
  });

  it('room left for the whole invoice: it goes on whole, with no notice', async () => {
    seed({ maxTx: '200.00' });
    lookup = { spent: 63.67 };
    const r = await sell(cashSale(100));

    expect(forwarded()[0].body.amount).toBe(100);
    expect(r.body.amount_adjusted).toBeUndefined();
  });

  it.each([[200], [250]])('spent %s of a limit of 200: refused with the numbers, nothing reaches the purchase route', async (spent) => {
    seed({ maxTx: '200.00' });
    lookup = { spent };
    const r = await sell(cashSale(19.9));

    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ success: false, error: 'CUSTOMER_WINDOW_EXCEEDED', spent, limit: 200, days: 1, currency: 'EUR' });
    expect(forwarded()).toEqual([]);
  });

  it('asks the brain about this unit, this customer, this currency and the configured days', async () => {
    seed({ maxTx: '200.00' });
    db.prepare("UPDATE app_settings SET value = '3' WHERE key = 'customer_window_days'").run();
    await sell(cashSale(19.9));

    expect(windowLookups()).toHaveLength(1);
    expect(windowLookups()[0].query).toEqual({
      unit_id: UNIT, currency: 'EUR', days: '3', customer_hex: CUSTOMER.customer_hex, customer_wallet: CUSTOMER.customer_wallet,
    });
  });

  it('a wallet alone is enough to ask', async () => {
    seed({ maxTx: '200.00' });
    lookup = { spent: 192.44 };
    await sell({ payment_type: 'cash', amount: 188.94, customer_wallet: CUSTOMER.customer_wallet });

    expect(windowLookups()).toHaveLength(1);
    expect(forwarded()[0].body.amount).toBe(7.56);
  });

  it.each([
    ['the brain answers 500', { status: 500 }],
    ['the brain has no such route', { status: 404 }],
    ['the connection is cut', { hangUp: true }],
  ])('a failed lookup still sells: %s', async (_label, failure) => {
    seed({ maxTx: '200.00' });
    lookup = failure;
    const r = await sell(cashSale(188.94));

    expect(r.status).toBe(200);
    expect(forwarded()[0].body.amount).toBe(188.94);
    expect(windowLookups()).toHaveLength(1);
  });

  it('a limit in another currency is not asked about', async () => {
    seed({ maxTx: '200.00', maxTxCurrency: 'GBP' });
    lookup = { spent: 192.44 };
    await sell(cashSale(100));

    expect(windowLookups()).toEqual([]);
    expect(forwarded()[0].body.amount).toBe(100);
  });
});

describe('the per-invoice limit: above it, reduced with a notice', () => {
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
    fundCapacity(150);
    const byFund = await sell(cashSale(188.94));
    expect(forwarded()[0].body.amount).toBe(150);
    expect(byFund.body.amount_adjusted).toEqual({ original: 188.94, adjusted: 150, currency: 'EUR' });

    db.prepare("UPDATE app_settings SET value = '120' WHERE key = 'default_max_tx_amount'").run();
    await sell(cashSale(188.94));
    expect(forwarded()[1].body.amount).toBe(120);
  });
});

describe('the monthly limits', () => {
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

describe('a LANA sale is untouched', () => {
  const lanaSale = (amount: number) => ({ payment_type: 'lana', amount, signed_tx_hex: 'ab', ...CUSTOMER });

  it('above the invoice limit, with an earlier purchase of the same customer: nothing is asked', async () => {
    seed({ maxTx: '200.00' });
    lookup = { spent: 192.44 };
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
