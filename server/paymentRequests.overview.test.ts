// @vitest-environment node
/**
 * GET /api/payment-requests/overview — the "Online payments" page's one route,
 * on a real express server, an in-memory database and a stub brain.
 *
 * What is pinned here:
 *   - it believes a SIGNATURE, never a hex: no header → 401, `?hex=<owner>` → 401;
 *   - owner and staff see their units' requests; a stranger sees nothing and is
 *     refused a unit they name; inactive and simple.lanapays.us units are out;
 *     a person under a KIND 87058 decision is refused;
 *   - newest first, paged, with a total;
 *   - it WRITES NOTHING — the payment_requests table is byte-identical after a
 *     GET, even though an overdue pending request is shown as expired;
 *   - the row carries none of the capability, key or brain fields;
 *   - paid without a brain transaction is "paid_unconfirmed"; a payment in
 *     flight is "processing"; a request the watchdog re-opened is "unverified"
 *     even after it expires or is cancelled — never "waiting"; the investor
 *     status of all three is "unknown" or not applicable, never asked;
 *   - a brain that answers HTML (not deployed yet) makes every investor status
 *     "unknown", never "paid", and says so once: investor_available=false;
 *   - staff see the customer side of their unit's requests but no investor
 *     status (investor: null), and the brain is not asked about their rows;
 *   - no page-wide "checked at": only the per-row time of a real brain read.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { initializeSchema } from './db/schema.js';
import { registerPaymentRequestRoutes, WATCHDOG_RESET_ERROR } from './paymentRequests.js';
import { brainPayoutReader } from './lib/brainPayouts.js';
import { forgetSpentTokens } from './lib/nip98.js';
import { ensureExclusionTables, mergeReports } from './lib/personExclusion.js';

const PATH = '/api/payment-requests/overview';
const mk = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const owner = mk(), staff = mk(), stranger = mk(), excluded = mk();

const UNIT_A = 'a'.repeat(32);
const UNIT_B = 'b'.repeat(32);
const UNIT_I = 'd'.repeat(32); // inactive
const UNIT_S = 'c'.repeat(32); // simple.lanapays.us — never ours

const TX_A3 = '33333333-3333-4333-8333-333333333333';
const TX_B3 = '44444444-4444-4444-8444-444444444444';
const TX_I1 = '55555555-5555-4555-8555-555555555555';

let db: Database.Database;
let base = '';
let httpServer: any;
let brainServer: any;
let brainMode: 'json' | 'html' = 'json';
let brainCalls: string[] = [];
const savedEnv = { url: process.env.BRAIN_API_URL, peer: process.env.BRAIN_PEER_KEY, purchase: process.env.BRAIN_PURCHASE_KEY };

function insertUnit(unitId: string, name: string, authorized: string[], opts: { simple?: boolean; status?: string } = {}) {
  db.prepare(`
    INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event, unit_type, lana_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, ?)
  `).run(unitId, 'e'.repeat(64), owner.pk, 1, name, owner.pk, JSON.stringify(authorized), opts.status ?? 'active',
    JSON.stringify({ kind: 30901, tags: [['d', unitId]] }), opts.simple ? 'simple.lanapays.us' : null, opts.simple ? 1 : 0);
}

function insertRequest(r: {
  id: string; unit: string; status: string; created: string; invoice: string;
  expires?: string | null; brainTx?: string | null; paidAt?: string | null; txHash?: string | null; lastError?: string | null;
}) {
  db.prepare(`
    INSERT INTO payment_requests (
      id, token, unit_id, merchant_hex, unit_name, amount_fiat, currency, invoice_number, receipt_url, receipt_hash,
      status, created_at, expires_at, paid_at, brain_transaction_id, tx_hash, paid_lana_lanoshis,
      customer_hex, customer_wallet, customer_name, preview_json, last_error, seen_by_merchant
    ) VALUES (?, ?, ?, ?, ?, 12.5, 'EUR', ?, 'https://example.test/r.jpg', 'h', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    r.id, crypto.randomBytes(24).toString('base64url'), r.unit, owner.pk, `Unit ${r.unit.slice(0, 1)}`, r.invoice,
    r.status, r.created, r.expires ?? null, r.paidAt ?? null, r.brainTx ?? null, r.txHash ?? null,
    r.status === 'paid' ? 976543210 : null,
    r.status === 'paid' ? 'f'.repeat(64) : null, r.status === 'paid' ? 'LcustomerWallet' : null,
    r.status === 'paid' ? 'A Customer' : null, '{"recipients":[]}',
    r.lastError !== undefined ? r.lastError : (r.status === 'paid' && !r.brainTx ? 'assumed paid via brain dedup' : null),
  );
}

/** A NIP-98 header for GET <PATH>, signed by `who`. */
function sigHeader(who: { sk: Uint8Array }, overrides: { u?: string; method?: string } = {}) {
  const ev = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', overrides.u ?? PATH], ['method', overrides.method ?? 'GET'], ['nonce', crypto.randomBytes(16).toString('hex')]],
    content: '',
  }, who.sk);
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}

async function get(query = '', who?: { sk: Uint8Array }) {
  const r = await fetch(`${base}${PATH}${query}`, { headers: who ? { Authorization: sigHeader(who) } : {} });
  return { status: r.status, json: await r.json() as any };
}

const snapshot = () => JSON.stringify(db.prepare('SELECT * FROM payment_requests ORDER BY id').all());

beforeAll(async () => {
  // ── stub brain: the agreed /api/peer/purchase-payouts contract ──
  const brain = express();
  brain.get('/api/peer/purchase-payouts', (req, res) => {
    brainCalls.push(String(req.query.tx || ''));
    if (req.headers.authorization !== 'Bearer test-peer-key') return res.status(401).json({ error: 'Peer API key required' });
    if (brainMode === 'html') return res.status(200).type('html').send('<!doctype html><html><body>SPA</body></html>');
    const transactions: Record<string, unknown> = {};
    for (const id of String(req.query.tx || '').split(',')) {
      if (id === TX_A3) {
        transactions[id] = { found: true, unit_id: UNIT_A, invoice_number: 'INV-A3', payment_type: 'lana', payouts: [
          { order_type: 'merchant_payment', destination_type: 'bank', status: 'paid', amount_fiat: 12.5, currency: 'EUR', updated_at: '2026-09-17 09:00:00' },
        ] };
      } else if (id === TX_B3) {
        transactions[id] = { found: true, unit_id: UNIT_B, invoice_number: 'INV-B3', payment_type: 'lana', payouts: [
          { order_type: 'merchant_payment', destination_type: 'bank', status: 'pending', amount_fiat: 12.5, currency: 'EUR', updated_at: '2026-09-17 09:00:00' },
          { order_type: 'merchant_commission', destination_type: 'bank', status: 'paid', amount_fiat: 0.5, currency: 'EUR', updated_at: '2026-09-17 10:00:00' },
        ] };
      } else {
        transactions[id] = { found: false };
      }
    }
    res.json({ checked_at: new Date().toISOString(), transactions });
  });
  brainServer = brain.listen(0, '127.0.0.1');
  await new Promise<void>(r => brainServer.once('listening', r));
  process.env.BRAIN_API_URL = `http://127.0.0.1:${(brainServer.address() as AddressInfo).port}`;
  process.env.BRAIN_PEER_KEY = 'test-peer-key';
  delete process.env.BRAIN_PURCHASE_KEY;

  db = new Database(':memory:');
  initializeSchema(db);
  ensureExclusionTables(db);
  insertUnit(UNIT_A, 'Alpha', [staff.pk, excluded.pk]);
  insertUnit(UNIT_B, 'Beta', []);
  insertUnit(UNIT_I, 'Inactive', [], { status: 'inactive' });
  insertUnit(UNIT_S, 'Simple', [], { simple: true });
  mergeReports(db, [{
    dTag: 'x1', personHex: excluded.pk, ground: 'g', since: 1700000000, untilSplit: null, eventId: 'ev1',
    active: true, eventCreatedAt: 1700000000,
  }]);

  insertRequest({ id: 'a1', unit: UNIT_A, status: 'pending', created: '2026-09-18 10:00:00', invoice: 'INV-A1', expires: '2099-01-01 00:00:00' });
  insertRequest({ id: 'a2', unit: UNIT_A, status: 'pending', created: '2026-09-17 10:00:00', invoice: 'INV-A2', expires: '2026-09-01 00:00:00' });
  insertRequest({ id: 'a3', unit: UNIT_A, status: 'paid', created: '2026-09-16 10:00:00', invoice: 'INV-A3', brainTx: TX_A3, paidAt: '2026-09-16 11:00:00', txHash: '9'.repeat(64) });
  insertRequest({ id: 'a4', unit: UNIT_A, status: 'paid', created: '2026-09-15 10:00:00', invoice: 'INV-A4', paidAt: '2026-09-15 11:00:00' });
  insertRequest({ id: 'b1', unit: UNIT_B, status: 'cancelled', created: '2026-09-18 09:00:00', invoice: 'INV-B1' });
  insertRequest({ id: 'b2', unit: UNIT_B, status: 'paying', created: '2026-09-17 09:00:00', invoice: 'INV-B2', expires: '2099-01-01 00:00:00' });
  insertRequest({ id: 'b3', unit: UNIT_B, status: 'paid', created: '2026-09-16 09:00:00', invoice: 'INV-B3', brainTx: TX_B3, paidAt: '2026-09-16 12:00:00', txHash: '8'.repeat(64) });
  insertRequest({ id: 'i1', unit: UNIT_I, status: 'paid', created: '2026-09-18 11:00:00', invoice: 'INV-I1', brainTx: TX_I1, paidAt: '2026-09-18 11:30:00' });
  insertRequest({ id: 's1', unit: UNIT_S, status: 'pending', created: '2026-09-18 12:00:00', invoice: 'INV-S1', expires: '2099-01-01 00:00:00' });

  const app = express();
  app.use(express.json());
  registerPaymentRequestRoutes(app, db);
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => httpServer.once('listening', r));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const [k, v] of [['BRAIN_API_URL', savedEnv.url], ['BRAIN_PEER_KEY', savedEnv.peer], ['BRAIN_PURCHASE_KEY', savedEnv.purchase]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await new Promise<void>(r => httpServer.close(() => r()));
  await new Promise<void>(r => brainServer.close(() => r()));
  db.close();
});

beforeEach(() => {
  brainPayoutReader.reset();
  forgetSpentTokens();
  brainMode = 'json';
  brainCalls = [];
});

describe('who is asking is proved, not claimed', () => {
  it('no signature → 401', async () => {
    const r = await get();
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ success: false, error: 'SIGNATURE_REQUIRED', reason: 'MISSING' });
  });

  it('naming the owner in ?hex= is not enough → 401', async () => {
    const r = await get(`?hex=${owner.pk}`);
    expect(r.status).toBe(401);
  });

  it('a token signed for another path → 401', async () => {
    const r = await fetch(`${base}${PATH}`, { headers: { Authorization: sigHeader(owner, { u: '/api/payment-requests' }) } });
    expect(r.status).toBe(401);
    expect(((await r.json()) as any).reason).toBe('PATH_MISMATCH');
  });

  it('a person under a standing KIND 87058 decision is refused, though they are listed staff', async () => {
    const r = await get('', excluded);
    expect(r.status).toBe(403);
    expect(r.json.excluded).toBe(true);
  });
});

describe('which requests a signer sees', () => {
  it('the owner sees both active units, newest first — not the inactive or the simple one', async () => {
    const r = await get('', owner);
    expect(r.status).toBe(200);
    expect(r.json.units).toEqual([{ unit_id: UNIT_A, name: 'Alpha' }, { unit_id: UNIT_B, name: 'Beta' }]);
    expect(r.json.total).toBe(7);
    expect(r.json.requests.map((x: any) => x.id)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4']);
    // No page-wide stamp: it claimed a check even when none was made.
    expect(r.json).not.toHaveProperty('checked_at');
  });

  it('staff see the unit they are listed on, and only that one', async () => {
    const r = await get('', staff);
    expect(r.status).toBe(200);
    expect(r.json.units.map((u: any) => u.unit_id)).toEqual([UNIT_A]);
    expect(r.json.requests.map((x: any) => x.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect((await get(`?unit_id=${UNIT_B}`, staff)).status).toBe(403);
  });

  it('a stranger sees no units and no requests, and is refused a unit they name', async () => {
    const r = await get('', stranger);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ units: [], requests: [], total: 0 });
    const named = await get(`?unit_id=${UNIT_A}`, stranger);
    expect(named.status).toBe(403);
    expect(named.json.error).toBe('NOT_AUTHORIZED');
  });

  it('even the owner is refused the inactive and the simple unit by name', async () => {
    expect((await get(`?unit_id=${UNIT_I}`, owner)).status).toBe(403);
    expect((await get(`?unit_id=${UNIT_S}`, owner)).status).toBe(403);
  });

  it('one unit, paged', async () => {
    const p1 = await get(`?unit_id=${UNIT_A}&limit=2&offset=0`, owner);
    const p2 = await get(`?unit_id=${UNIT_A}&limit=2&offset=2`, owner);
    expect(p1.json.total).toBe(4);
    expect(p2.json.total).toBe(4);
    expect(p1.json.requests.map((x: any) => x.id)).toEqual(['a1', 'a2']);
    expect(p2.json.requests.map((x: any) => x.id)).toEqual(['a3', 'a4']);
    expect(p1.json.units).toHaveLength(2); // the selector still lists every unit
  });
});

describe('what a row says', () => {
  const byId = async (who = owner) => {
    const r = await get('', who);
    return Object.fromEntries(r.json.requests.map((x: any) => [x.id, x]));
  };

  it('the customer side: waiting, expired (shown, not written), paid, paid_unconfirmed, cancelled, processing', async () => {
    const rows = await byId();
    expect(rows.a1.customer_status).toBe('waiting');
    expect(rows.a2.customer_status).toBe('expired');
    expect(rows.a3.customer_status).toBe('paid');
    expect(rows.a4.customer_status).toBe('paid_unconfirmed'); // the tab and the toast say "paid" too
    expect(rows.a4.paid_at).toBe('2026-09-15 11:00:00');
    expect(rows.b1.customer_status).toBe('cancelled');
    // 'paying': the customer submitted and the brain may already have charged —
    // never "waiting for payment".
    expect(rows.b2.customer_status).toBe('processing');
    expect(rows.b2.investor.invoice.state).toBe('not_applicable');
  });

  it('a request the watchdog re-opened is "unverified" — pending, expired or cancelled — and never "waiting"', async () => {
    const extra = [
      { id: 'w1', status: 'pending', expires: '2099-01-01 00:00:00' },
      { id: 'w2', status: 'pending', expires: '2026-09-01 00:00:00' }, // overdue, not yet swept
      { id: 'w3', status: 'expired', expires: '2026-09-01 00:00:00' },
      { id: 'w4', status: 'cancelled', expires: '2099-01-01 00:00:00' },
    ];
    for (const [i, w] of extra.entries()) {
      insertRequest({ id: w.id, unit: UNIT_B, status: w.status, created: `2026-09-10 0${i}:00:00`, invoice: `INV-${w.id}`, expires: w.expires, lastError: WATCHDOG_RESET_ERROR });
    }
    // A brain refusal on a later attempt is a known failure, not a lost one.
    insertRequest({ id: 'w5', unit: UNIT_B, status: 'pending', created: '2026-09-10 05:00:00', invoice: 'INV-w5', expires: '2099-01-01 00:00:00', lastError: 'brain 409: SELF_PURCHASE' });
    try {
      const r = await get(`?unit_id=${UNIT_B}`, owner);
      const rows = Object.fromEntries(r.json.requests.map((x: any) => [x.id, x]));
      for (const id of ['w1', 'w2', 'w3', 'w4']) {
        expect(rows[id].customer_status, id).toBe('unverified');
        expect(rows[id].investor.invoice.state, id).toBe('unknown');
      }
      expect(rows.w5.customer_status).toBe('waiting');
    } finally {
      db.prepare("DELETE FROM payment_requests WHERE id IN ('w1','w2','w3','w4','w5')").run();
    }
  });

  it('the watchdog marker this page reads is the one the heartbeat writes', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const heartbeat = readFileSync(path.join(here, 'heartbeat.ts'), 'utf8');
    expect(heartbeat).toContain(`last_error = '${WATCHDOG_RESET_ERROR}'`);
  });

  it('the investor side: not applicable until the customer paid; the brain\'s answer after', async () => {
    const rows = await byId();
    expect(rows.a1.investor).toEqual({ invoice: { state: 'not_applicable', marked_paid_at: null }, reward: null, checked_at: null });
    expect(rows.a3.investor.invoice).toEqual({ state: 'marked_paid', marked_paid_at: '2026-09-17 09:00:00' });
    expect(rows.a3.investor.reward).toBeNull();
    expect(rows.b3.investor.invoice.state).toBe('waiting');
    expect(rows.b3.investor.reward).toEqual({ state: 'marked_paid', marked_paid_at: '2026-09-17 10:00:00', amount_fiat: 0.5, currency: 'EUR' });
    expect(rows.a3.tx_hash).toBe('9'.repeat(64));
    expect(rows.a3.customer_name).toBe('A Customer');
  });

  it('paid without a brain transaction → paid_unconfirmed, and the investor is unknown — never asked', async () => {
    const rows = await byId();
    expect(rows.a4.investor.invoice.state).toBe('unknown');
    expect(brainCalls).toHaveLength(1);
    expect(brainCalls[0].split(',').sort()).toEqual([TX_A3, TX_B3].sort());
  });

  it('a brain that answers its HTML shell (route not deployed yet) → every investor status unknown, said once', async () => {
    brainMode = 'html';
    const r = await get('', owner);
    const rows = Object.fromEntries(r.json.requests.map((x: any) => [x.id, x]));
    expect(rows.a3.investor.invoice.state).toBe('unknown');
    expect(rows.b3.investor.invoice.state).toBe('unknown');
    expect(rows.b3.investor.reward).toBeNull();
    expect(rows.a3.investor.checked_at).toBeNull();
    expect(rows.a3.customer_status).toBe('paid'); // the customer side does not depend on the brain
    expect(r.json.investor_available).toBe(false);
  });

  it('a brain that answers → investor_available, and each status carries the time it was read', async () => {
    const r = await get('', owner);
    expect(r.json.investor_available).toBe(true);
    const a3 = r.json.requests.find((x: any) => x.id === 'a3');
    expect(a3.investor.checked_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('staff see the customer side but not the owner\'s investor payouts or reward — and the brain is not asked', async () => {
    const r = await get('', staff);
    expect(r.status).toBe(200);
    expect(r.json.requests.map((x: any) => x.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    for (const row of r.json.requests) expect(row.investor, row.id).toBeNull();
    expect(r.json.requests.find((x: any) => x.id === 'a3').customer_status).toBe('paid');
    expect(r.json.investor_owner_only).toBe(true);
    expect(brainCalls).toHaveLength(0);

    const o = await get('', owner);
    expect(o.json.investor_owner_only).toBe(false);
    expect(o.json.requests.every((x: any) => x.investor !== null)).toBe(true);
  });

  it('carries none of the capability, key or brain fields', async () => {
    const r = await get('', owner);
    const text = JSON.stringify(r.json);
    for (const field of ['token', 'receipt_url', 'receipt_hash', 'customer_hex', 'customer_wallet', 'brain_transaction_id',
      'paid_lana_lanoshis', 'preview_json', 'last_error', 'seen_by_merchant', 'merchant_hex']) {
      expect(text, `leaked ${field}`).not.toContain(`"${field}"`);
    }
    expect(text).not.toContain(TX_A3);
    expect(text).not.toContain('f'.repeat(64));
  });
});

describe('it writes nothing', () => {
  it('the payment_requests table is byte-identical after a GET — the overdue request stays pending in the row', async () => {
    const before = snapshot();
    await get('', owner);
    await get(`?unit_id=${UNIT_A}`, staff);
    expect(snapshot()).toBe(before);
    expect((db.prepare("SELECT status FROM payment_requests WHERE id = 'a2'").get() as any).status).toBe('pending');
    expect((db.prepare('SELECT COUNT(*) AS c FROM payment_requests WHERE seen_by_merchant = 1').get() as any).c).toBe(0);
  });
});
