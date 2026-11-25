// @vitest-environment node
/**
 * Payment links of LANA neposredno (server/directLana.ts, lib/directLanaLinks.ts):
 * the seller makes a link at the till (signed), the customer pays it at home
 * from their own card (no signature: the token is the capability). A real
 * express server, an in-memory database, a fake chain read from "two agreeing
 * Electrum servers", a fake registrar and fake relays; the customer's side is
 * the real new signer (src/lib/directLanaSign.ts) with test keys. Nothing
 * leaves this process.
 *
 * What is proved: a link is ONE sale of the journal, priced from the link and
 * never from the customer's request, paid once at most (a second card, a
 * second payment after it was paid, the till paying it again: all refused);
 * cancelling never hides a payment on its way; an expired link takes no new
 * payment but a payment in flight still lands; the customer's answers never
 * show the card's address; the seller who made it is asked again at every step.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { finalizeEvent } from 'nostr-tools/pure';
import { initializeSchema } from './db/schema.js';
import { ensureExclusionTables } from './lib/personExclusion.js';
import { keepRawBody, forgetSpentTokens } from './lib/nip98.js';
import { registerDirectLanaRoutes, runDirectLanaWorker, RESEND_WINDOW_SECONDS, type DirectLanaDeps } from './directLana.js';
import { RegistrarUnavailable, type RegistrarAnswer } from './lib/directLanaRegistrar.js';
import { getAttempt } from './lib/directLanaStore.js';
import { linkById } from './lib/directLanaLinks.js';
import { type DirectLanaPlan } from './lib/directLanaCore.js';
import { readCardKey, signDirectSale } from '../src/lib/directLanaSign.js';
import { keyOf, wifOf, addressOfKey, hexOfKey } from './fixtures/directLana.js';
import { FakeChain } from './fixtures/directLanaChain.js';

// ── people, wallets, shops ──────────────────────────────────────────────────
const OWNER = keyOf(7);
const OWNER_HEX = hexOfKey(OWNER);
const SHOP_WALLET = addressOfKey(OWNER);
const STAFF = keyOf(8);
const STAFF_HEX = hexOfKey(STAFF);
const STRANGER = keyOf(9);
const CARD = keyOf(1);
const CARD_ADDRESS = addressOfKey(CARD);
const CUSTOMER_HEX = hexOfKey(keyOf(11));
const CARD2 = keyOf(2);
const CARD2_ADDRESS = addressOfKey(CARD2);
const PARAMS = keyOf(5);
const UNIT = 'nocompany-unit-1';
const COMPANY = 'company-unit-1';

let db: Database.Database;
let base = '';
let server: any;
let nowMs = Date.now();
const quiet = { log: console.log, warn: console.warn, error: console.error };

const chain = new FakeChain();
let chainReads = 0;

const registrar = new Map<string, RegistrarAnswer | 'down'>();
const registrarAsked: string[] = [];
const wallet = (type: string, owner: string | null, frozen = false): RegistrarAnswer =>
  ({ registered: true, wallet_type: type, frozen, freeze_reason: frozen ? 'frozen_max_cap' : null, owner });

const published: Array<{ id: string }> = [];
const RELAYS = ['wss://r1.example', 'wss://r2.example', 'wss://r3.example', 'wss://r4.example'];

const deps: Partial<DirectLanaDeps> = {
  withChain: async (servers, address, task) => {
    chainReads++;
    return chain.withChain(servers, address, task);
  },
  registrar: async (w) => {
    registrarAsked.push(w);
    const a = registrar.get(w);
    if (a === 'down') throw new RegistrarUnavailable('down');
    return a ?? { registered: false };
  },
  publish: async (event, relays) => {
    published.push({ id: event.id });
    return relays;
  },
  nowMs: () => nowMs,
  paramsPubkey: hexOfKey(PARAMS),
  limitPerMinute: 10_000,
};
const worker = () => runDirectLanaWorker(db, deps as DirectLanaDeps);

function store38888(rate = '0.256') {
  const ev = finalizeEvent({
    kind: 38888,
    created_at: Math.floor(Date.now() / 1000) - 60,
    tags: [
      ['d', 'main'], ['fx', 'EUR', rate], ['fx', 'USD', '0.3'],
      ['electrum', 'e1.example', '5097'], ['electrum', 'e2.example', '5097'],
      ...RELAYS.map(r => ['relay', r]),
    ],
    content: '',
  }, PARAMS);
  db.prepare('INSERT INTO kind_38888 (event_id, raw_event, relays, electrum_servers, exchange_rates) VALUES (?, ?, ?, ?, ?)')
    .run(ev.id, JSON.stringify(ev), '[]', '[]', '{}');
}

const unitEvent = (unitId: string, author: string, tags: string[][]) =>
  JSON.stringify({ kind: 30901, pubkey: author, tags: [['d', unitId], ['name', unitId], ...tags], content: '' });
const OPTION_C = (margin = '10') => [['payout_account', 'none'], ['margin_percent', margin], ['lanapays_payout_method', 'lana'], ['lanapays_payout_wallet', SHOP_WALLET]];

function seedUnits() {
  const ins = db.prepare(`
    INSERT OR REPLACE INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event, unit_type, lana_only, suspension_status)
    VALUES (?, ?, ?, 1, ?, ?, ?, 'EUR', 'active', ?, NULL, 0, 'active')
  `);
  ins.run(UNIT, 'e'.repeat(64), OWNER_HEX, 'Kmetija Novak', OWNER_HEX, JSON.stringify([OWNER_HEX, STAFF_HEX]), unitEvent(UNIT, OWNER_HEX, OPTION_C()));
  ins.run(COMPANY, 'd'.repeat(64), OWNER_HEX, 'Podjetje d.o.o.', OWNER_HEX, JSON.stringify([OWNER_HEX]),
    unitEvent(COMPANY, OWNER_HEX, [['receiver_type', 'company'], ['lanapays_payout_wallet', SHOP_WALLET]]));
}
const setUnitTags = (tags: string[][]) => db.prepare('UPDATE business_units SET raw_event = ? WHERE unit_id = ?').run(unitEvent(UNIT, OWNER_HEX, tags), UNIT);
const setSwitch = (value: string) =>
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('direct_lana_units', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
const exclude = (hex: string) => db.prepare(`INSERT INTO person_exclusions (d_tag, person_hex, active, ground, since, event_id, event_created_at) VALUES (?, ?, 1, 'a ground', 1, 'ev', 1)`).run(`d-${hex}`, hex);

// ── requests: the seller's are signed, the customer's are not ──────────────
function auth(method: string, path: string, body: string | undefined, key: Uint8Array) {
  const tags = [['u', path], ['method', method], ['nonce', crypto.randomBytes(8).toString('hex')]];
  if (body !== undefined) tags.push(['payload', crypto.createHash('sha256').update(body).digest('hex')]);
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, key);
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}
async function post(path: string, body: unknown, key: Uint8Array | null) {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = auth('POST', path, text, key);
  const res = await fetch(base + path, { method: 'POST', headers, body: text });
  return { status: res.status, data: await res.json() as any };
}
async function get(path: string, key: Uint8Array | null) {
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = auth('GET', path.split('?')[0], undefined, key);
  const res = await fetch(base + path, { headers });
  return { status: res.status, data: await res.json() as any };
}

/** The seller makes a link (signed). */
const makeLink = (extra: Record<string, unknown> = {}, key: Uint8Array | null = OWNER) =>
  post('/api/direct-lana/links', { unit_id: UNIT, amount: '10.00', currency: 'EUR', ...extra }, key);
async function newLink(extra: Record<string, unknown> = {}) {
  const r = await makeLink(extra);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.link as { id: string; token: string; path: string; sale_id: string };
}
/** The customer's page. */
const view = (token: string) => get(`/api/direct-pay/${token}`, null);
const quote = (token: string, card = CARD, extra: Record<string, unknown> = {}) =>
  post(`/api/direct-pay/${token}/quote`, { public_key: readCardKey(wifOf(card)).publicKey, ...extra }, null);
const sign = (plan: DirectLanaPlan, card = CARD) => signDirectSale(readCardKey(wifOf(card)), plan);
const submit = (token: string, plan: DirectLanaPlan, signed: ReturnType<typeof sign>) =>
  post(`/api/direct-pay/${token}/submit`, { attempt_id: plan.attempt_id, raw: signed.raw, record: signed.record }, null);
async function pay(token: string, card = CARD) {
  const q = await quote(token, card);
  expect(q.status, JSON.stringify(q.data)).toBe(200);
  const s = sign(q.data.plan, card);
  const r = await submit(token, q.data.plan, s);
  return { q, s, r, plan: q.data.plan as DirectLanaPlan };
}
const cancel = (id: string, key: Uint8Array | null = OWNER) => post(`/api/direct-lana/links/${id}/cancel`, { link_id: id }, key);
const mineAndSweep = async (raw: string) => {
  chain.mine(raw, 301);
  chain.height = 301;
  return worker();
};

beforeAll(async () => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  db = new Database(':memory:');
  initializeSchema(db);
  ensureExclusionTables(db);
  const app = express();
  app.use(express.json({ limit: '50kb', verify: keepRawBody }));
  registerDirectLanaRoutes(app, db, deps);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(r => server.close(r));
  console.log = quiet.log; console.warn = quiet.warn; console.error = quiet.error;
});

beforeEach(() => {
  forgetSpentTokens();
  nowMs = Date.now();
  db.exec('DELETE FROM direct_lana_links; DELETE FROM direct_lana_sales; DELETE FROM direct_lana_payees; DELETE FROM kind_38888; DELETE FROM business_units; DELETE FROM person_exclusions;');
  db.prepare("UPDATE app_settings SET value = '168' WHERE key = 'payment_request_expiry_hours'").run();
  seedUnits();
  store38888();
  setSwitch('*');
  chain.reset();
  chainReads = 0;
  chain.fund(CARD_ADDRESS, [10_000_000_000n]);
  chain.fund(CARD2_ADDRESS, [10_000_000_000n]);
  registrar.clear(); registrarAsked.length = 0;
  registrar.set(CARD_ADDRESS, wallet('Main Wallet', CUSTOMER_HEX));
  registrar.set(CARD2_ADDRESS, wallet('Wallet', hexOfKey(keyOf(12))));
  registrar.set(SHOP_WALLET, wallet('Main Wallet', OWNER_HEX));
  published.length = 0;
});

describe('the seller makes a link', () => {
  it('signed by the owner or staff: one open link with a 32-character token, the invoice, the margin and the total', async () => {
    const r = await makeLink({ invoice_number: 'R-1', note: 'Jajca\nza  soboto' });
    expect(r.status).toBe(201);
    const link = r.data.link;
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(link.path).toBe(`/pay-direct/${link.token}`);
    expect(link).toMatchObject({
      unit_id: UNIT, currency: 'EUR', invoice: '10.00', margin_percent: 10, margin: '1.00', total: '11.00', pay_cents: '1100',
      invoice_number: 'R-1', note: 'Jajca za soboto', status: 'open', payment: null,
    });
    expect(link.expires_at - link.created_at).toBe(168 * 3600);
    // Nothing is asked of the register or the chain to make a link.
    expect(registrarAsked).toEqual([]);
    expect(chainReads).toBe(0);
    expect((await makeLink({}, STAFF)).status).toBe(201);
  });

  it('unsigned: 401; a stranger: NOT_ENTITLED; nothing stored', async () => {
    expect((await makeLink({}, null)).status).toBe(401);
    expect((await makeLink({}, STRANGER)).data.code).toBe('NOT_ENTITLED');
    expect((db.prepare('SELECT COUNT(*) AS n FROM direct_lana_links').get() as any).n).toBe(0);
  });

  it('only where the till could take LANA neposredno: a shop with a company and the switch off are refused', async () => {
    expect((await makeLink({ unit_id: COMPANY })).data.code).toBe('UNIT_NOT_DIRECT');
    setSwitch('');
    expect((await makeLink()).data.code).toBe('DIRECT_LANA_OFF');
    setSwitch('*');
    db.prepare('DELETE FROM kind_38888').run();
    expect((await makeLink()).status).toBe(503);
  });

  it('a bad amount, an amount too small, an invoice number already paid or on another open link', async () => {
    expect((await makeLink({ amount: '0' })).data.code).toBe('AMOUNT_INVALID');
    expect((await makeLink({ amount: 'deset' })).data.code).toBe('AMOUNT_INVALID');
    expect((await makeLink({ amount: '0.0000001' })).data.code).toBe('AMOUNT_INVALID');
    await newLink({ invoice_number: 'R-9' });
    expect((await makeLink({ invoice_number: 'R-9' })).data.code).toBe('INVOICE_HAS_LINK');
    // Paid at the till already: the number is used.
    db.prepare("UPDATE direct_lana_links SET status = 'cancelled' WHERE invoice_number = 'R-9'").run();
    const till = await post('/api/direct-lana/quote', { unit_id: UNIT, amount: '10.00', currency: 'EUR', public_key: readCardKey(wifOf(CARD)).publicKey, invoice_number: 'R-9' }, OWNER);
    expect(till.status).toBe(200);
    const signed = sign(till.data.plan);
    expect((await post('/api/direct-lana/submit', { attempt_id: till.data.plan.attempt_id, raw: signed.raw, record: signed.record }, OWNER)).data.status).toBe('sent');
    expect((await makeLink({ invoice_number: 'R-9' })).data.code).toBe('INVOICE_USED');
    // Without a number, two links are two purchases.
    await newLink();
    await newLink();
  });
});

describe('the customer\'s page', () => {
  it('an unknown token: one 404 for every kind of wrong token', async () => {
    for (const t of ['x'.repeat(32), 'short', '../../etc/passwd']) {
      const r = await view(encodeURIComponent(t));
      expect(r.status).toBe(404);
    }
  });

  it('shows the shop, the invoice, the margin, the total, LANA at the price of now, and nothing of anybody\'s key or card', async () => {
    const link = await newLink({ invoice_number: 'R-2', note: 'Za vrt' });
    const r = await view(link.token);
    expect(r.status).toBe(200);
    expect(r.data.link).toMatchObject({
      status: 'open', unit_name: 'Kmetija Novak', currency: 'EUR', invoice: '10.00', margin_percent: 10, total: '11.00',
      invoice_number: 'R-2', note: 'Za vrt', recipient: SHOP_WALLET, recipient_hex: OWNER_HEX, sale_id: link.sale_id,
      price: { rate: '0.256', lanoshi: '4296875000', lana: '42.96875' }, payment: null,
    });
    const text = JSON.stringify(r.data);
    expect(text).not.toContain(link.token);
    expect(text).not.toContain(STAFF_HEX);
  });

  it('closed (without why) when the shop cannot take it now: switch off, shop blocked, the seller no longer staff or excluded', async () => {
    const link = await newLink({}, );
    const byStaff = (await makeLink({}, STAFF)).data.link;
    setSwitch('');
    expect((await view(link.token)).data.link.status).toBe('closed');
    setSwitch('*');
    db.prepare("UPDATE business_units SET suspension_status = 'suspended' WHERE unit_id = ?").run(UNIT);
    expect((await view(link.token)).data.link.status).toBe('closed');
    db.prepare("UPDATE business_units SET suspension_status = 'active', authorized_hex = ? WHERE unit_id = ?").run(JSON.stringify([OWNER_HEX]), UNIT);
    expect((await view(link.token)).data.link.status).toBe('open');
    expect((await view(byStaff.token)).data.link.status).toBe('closed');
    exclude(OWNER_HEX);
    const closed = await view(link.token);
    expect(closed.data.link.status).toBe('closed');
    expect(JSON.stringify(closed.data)).not.toContain('a ground');
  });
});

describe('the customer pays a link', () => {
  it('quote → sign → send → in a block: the link is paid, the record published, the seller told once', async () => {
    const link = await newLink({ invoice_number: 'R-3' });
    const { plan, s, r } = await pay(link.token);
    // The link's sale, invoice and margin, from the link: never from the request.
    expect(plan).toMatchObject({ sale_id: link.sale_id, unit_id: UNIT, invoice_cents: '1000', margin_percent: 10, pay_cents: '1100', invoice_number: 'R-3', recipient: SHOP_WALLET });
    expect(r.status).toBe(200);
    expect(r.data.status).toBe('sent');
    expect(r.data.payer_address).toBeUndefined();
    expect(chain.broadcasts).toEqual([s.raw]);
    // The seller who made the link is the attempt's seller.
    expect(getAttempt(db, plan.attempt_id)!.seller_hex).toBe(OWNER_HEX);

    const paying = await view(link.token);
    expect(paying.data.link.status).toBe('paying');
    expect(paying.data.link.payment).toMatchObject({ attempt_id: plan.attempt_id, status: 'sent', txid: s.txid });
    expect(JSON.stringify(paying.data)).not.toContain(CARD_ADDRESS);

    await mineAndSweep(s.raw);
    const paid = await view(link.token);
    expect(paid.data.link.status).toBe('paid');
    expect(paid.data.link.payment.status).toBe('paid');
    expect(linkById(db, link.id)!.status).toBe('paid');
    expect(published.map(p => p.id)).toEqual([s.record.id]);

    const unseen = await get('/api/direct-lana/links/unseen', OWNER);
    expect(unseen.data.count).toBe(1);
    expect(unseen.data.latest[0]).toMatchObject({ id: link.id, total: '11.00', currency: 'EUR' });
    expect((await get('/api/direct-lana/links/unseen', STAFF)).data.count).toBe(1);
    expect((await get('/api/direct-lana/links/unseen', STRANGER)).data.count).toBe(0);
    expect((await get('/api/direct-lana/links/unseen', null)).status).toBe(401);
    await post('/api/direct-lana/links/seen', { unit_id: UNIT }, OWNER);
    expect((await get('/api/direct-lana/links/unseen', OWNER)).data.count).toBe(0);

    // The payment is one of the shop's direct sales, as at the till.
    const sales = await get(`/api/direct-lana/sales?unit_id=${UNIT}`, OWNER);
    expect(sales.data.sales.map((x: any) => x.attempt_id)).toEqual([plan.attempt_id]);
  });

  it('what the customer\'s request says about the amount, the margin or the sale is ignored', async () => {
    const link = await newLink();
    const q = await quote(link.token, CARD, { amount: '0.50', unit_id: COMPANY, margin_percent: 0, invoice_number: 'X', sale_id: `dls_${'9'.repeat(32)}` });
    expect(q.status).toBe(200);
    expect(q.data.plan).toMatchObject({ unit_id: UNIT, invoice_cents: '1000', margin_percent: 10, invoice_number: '', sale_id: link.sale_id });
  });

  it('the margin is the link\'s: the shop changing its margin afterwards does not change what the link costs', async () => {
    const link = await newLink();
    setUnitTags(OPTION_C('20'));
    const q = await quote(link.token);
    expect(q.data.plan).toMatchObject({ margin_percent: 10, pay_cents: '1100' });
    // A new link takes the new margin.
    const next = (await makeLink()).data.link;
    expect(next).toMatchObject({ margin_percent: 20, total: '12.00' });
  });

  it('paid once at most: a second card while the first may still be mined, anyone after it is paid, the till too', async () => {
    const link = await newLink();
    const first = await pay(link.token);
    expect(first.r.data.status).toBe('sent');
    const second = await quote(link.token, CARD2);
    expect(second.data.code).toBe('SALE_PAYMENT_PENDING');
    await mineAndSweep(first.s.raw);
    expect((await quote(link.token, CARD2)).data.code).toBe('LINK_PAID');
    expect((await quote(link.token, CARD)).data.code).toBe('LINK_PAID');
    // The till cannot pay the link's sale again either.
    const till = await post('/api/direct-lana/quote', {
      unit_id: UNIT, amount: '10.00', currency: 'EUR', public_key: readCardKey(wifOf(CARD2)).publicKey, sale_id: link.sale_id,
    }, OWNER);
    // The link says why: it is paid (the journal would refuse it too: SALE_ALREADY_PAID).
    expect(till.data.code).toBe('LINK_PAID');
    expect(chain.broadcasts).toEqual([first.s.raw]);
  });

  it('a quote signed for a sale paid meanwhile from another tab is refused before it is sent', async () => {
    const link = await newLink();
    const q1 = await quote(link.token, CARD);
    // Another tab of the same customer pays first with the second card... it cannot while q1 is only a quote:
    // a quote holds nothing. The first one sent wins; the other is refused at submit.
    const q2 = await quote(link.token, CARD2);
    expect(q2.status).toBe(200);
    const s2 = sign(q2.data.plan, CARD2);
    expect((await submit(link.token, q2.data.plan, s2)).data.status).toBe('sent');
    const s1 = sign(q1.data.plan, CARD);
    const late = await submit(link.token, q1.data.plan, s1);
    expect(late.status).toBe(409);
    expect(chain.broadcasts).toEqual([s2.raw]);
  });

  it('every check of the till refuses before anything is sent: an unregistered or frozen card, too little LANA, the owner paying himself', async () => {
    const link = await newLink();
    registrar.delete(CARD_ADDRESS);
    expect((await quote(link.token)).data.code).toBe('PAYER_NOT_REGISTERED');
    registrar.set(CARD_ADDRESS, wallet('Main Wallet', CUSTOMER_HEX, true));
    expect((await quote(link.token)).data.code).toBe('PAYER_FROZEN');
    registrar.set(CARD_ADDRESS, wallet('Lana8Wonder', CUSTOMER_HEX));
    expect((await quote(link.token)).data.code).toBe('PAYER_TYPE_NOT_ALLOWED');
    registrar.set(CARD_ADDRESS, wallet('Main Wallet', OWNER_HEX));
    expect((await quote(link.token)).data.code).toBe('SELF_PAYMENT');
    registrar.set(CARD_ADDRESS, 'down');
    expect((await quote(link.token)).status).toBe(503);
    registrar.set(CARD_ADDRESS, wallet('Main Wallet', CUSTOMER_HEX));
    chain.reset();
    chain.fund(CARD_ADDRESS, [1000n]);
    expect((await quote(link.token)).data.code).toBe('INSUFFICIENT_FUNDS');
    expect(chain.broadcasts).toEqual([]);
  });

  it('the seller who made the link is asked again: no longer staff → closed; excluded → "this shop cannot take payments", without a ground', async () => {
    const byStaff = (await makeLink({}, STAFF)).data.link;
    db.prepare('UPDATE business_units SET authorized_hex = ? WHERE unit_id = ?').run(JSON.stringify([OWNER_HEX]), UNIT);
    expect((await quote(byStaff.token)).data.code).toBe('LINK_CLOSED');
    db.prepare('UPDATE business_units SET authorized_hex = ? WHERE unit_id = ?').run(JSON.stringify([OWNER_HEX, STAFF_HEX]), UNIT);
    exclude(STAFF_HEX);
    const q = await quote(byStaff.token);
    expect(q.status).toBe(403);
    expect(q.data.code).toBe('MERCHANT_UNAVAILABLE');
    expect(JSON.stringify(q.data)).not.toContain('a ground');
    expect(registrarAsked).toEqual([]);
  });

  it('the customer excluded by KIND 87058: told about themselves; nothing sent', async () => {
    const link = await newLink();
    exclude(hexOfKey(CARD));
    const q = await quote(link.token);
    expect(q.status).toBe(403);
    expect(q.data.code).toBe('PERSON_EXCLUDED');
    expect(chain.broadcasts).toEqual([]);
  });

  it('a payment that hangs: the identical bytes again within 30 minutes, then only a replacement with the same card', async () => {
    const link = await newLink();
    chain.mode = 'odd';
    const { plan, s, r } = await pay(link.token);
    expect(r.data.status).toBe('unknown');
    chain.mode = 'accept';
    const again = await post(`/api/direct-pay/${link.token}/resend`, { attempt_id: plan.attempt_id }, null);
    expect(again.status).toBe(200);
    expect(again.data.resend).toBe('accepted');
    expect(again.data.payer_address).toBeUndefined();
    expect(chain.broadcasts).toEqual([s.raw, s.raw]);

    // Another link's attempt cannot be sent again through this link.
    const other = await newLink();
    expect((await post(`/api/direct-pay/${other.token}/resend`, { attempt_id: plan.attempt_id }, null)).status).toBe(404);

    nowMs += (RESEND_WINDOW_SECONDS + 5) * 1000;
    expect((await post(`/api/direct-pay/${link.token}/resend`, { attempt_id: plan.attempt_id }, null)).data.code).toBe('RESEND_TOO_LATE');
  });

  it('a replacement after every server refused a sent payment spends one of its coins, so only one can be mined', async () => {
    const link = await newLink();
    chain.mode = 'refuse';
    const { plan, r } = await pay(link.token);
    expect(r.data.status).toBe('refused');
    expect(r.data.sent).toBe(true);
    chain.mode = 'accept';
    // Another card may not pay beside it.
    expect((await quote(link.token, CARD2)).data.code).toBe('SALE_PAYMENT_PENDING');
    const q = await quote(link.token, CARD);
    expect(q.status).toBe(200);
    expect(q.data.replaces).toEqual([plan.attempt_id]);
    const shared = q.data.plan.inputs.filter((i: any) => plan.inputs.some(o => o.txid === i.txid && o.vout === i.vout));
    expect(shared.length).toBeGreaterThan(0);
    const s2 = sign(q.data.plan, CARD);
    expect((await submit(link.token, q.data.plan, s2)).data.status).toBe('sent');
    expect(getAttempt(db, plan.attempt_id)!.status).toBe('superseded');
  });
});

describe('cancelling and expiry', () => {
  it('cancel: an open link closes, its unsigned quote can no longer be sent, a stranger cannot cancel', async () => {
    const link = await newLink();
    const q = await quote(link.token);
    expect((await cancel(link.id, STRANGER)).data.code).toBe('NOT_ENTITLED');
    const c = await cancel(link.id);
    expect(c.status).toBe(200);
    expect(c.data.link.status).toBe('cancelled');
    expect((await view(link.token)).data.link.status).toBe('cancelled');
    expect((await quote(link.token)).data.code).toBe('LINK_CANCELLED');
    const late = await submit(link.token, q.data.plan, sign(q.data.plan));
    expect(late.status).toBe(409);
    expect(chain.broadcasts).toEqual([]);
  });

  it('never while a payment of it may still be mined: cancelling would hide it', async () => {
    const link = await newLink();
    const { s } = await pay(link.token);
    const c = await cancel(link.id);
    expect(c.status).toBe(409);
    expect(c.data.code).toBe('SALE_PAYMENT_PENDING');
    await mineAndSweep(s.raw);
    expect((await cancel(link.id)).data.code).toBe('LINK_PAID');
    expect(linkById(db, link.id)!.status).toBe('paid');
  });

  it('an expired link takes no new payment; one sent before its time still lands and makes it paid', async () => {
    const quiet1 = await newLink();
    const busy = await newLink();
    const { s } = await pay(busy.token);
    nowMs += (168 * 3600 + 60) * 1000;
    expect((await view(quiet1.token)).data.link.status).toBe('expired');
    expect((await quote(quiet1.token)).data.code).toBe('LINK_EXPIRED');
    // The busy one stays "being paid" past its time: only the chain decides.
    expect((await view(busy.token)).data.link.status).toBe('paying');
    expect((await quote(busy.token, CARD2)).data.code).toBe('SALE_PAYMENT_PENDING');
    await mineAndSweep(s.raw);
    expect((await view(busy.token)).data.link.status).toBe('paid');
  });

  it('a validity of 0 hours: the link never expires', async () => {
    db.prepare("UPDATE app_settings SET value = '0' WHERE key = 'payment_request_expiry_hours'").run();
    const link = await newLink();
    expect(link).toMatchObject({ expires_at: null });
    nowMs += 400 * 24 * 3600 * 1000;
    expect((await view(link.token)).data.link.status).toBe('open');
  });

  it('the seller\'s list: newest first, with each link\'s status and payment', async () => {
    const a = await newLink({ invoice_number: 'A' });
    const b = await newLink({ invoice_number: 'B' });
    await pay(b.token);
    const list = await get(`/api/direct-lana/links?unit_id=${UNIT}`, STAFF);
    expect(list.status).toBe(200);
    expect(list.data.links.map((l: any) => [l.invoice_number, l.status])).toEqual([['B', 'paying'], ['A', 'open']]);
    expect(list.data.links[0].payment.status).toBe('sent');
    expect(list.data.links[1].id).toBe(a.id);
    expect((await get(`/api/direct-lana/links?unit_id=${UNIT}`, STRANGER)).data.code).toBe('NOT_ENTITLED');
  });
});

describe('review fixes (25 Nov 2026): nobody holding the link can block it, fill the database or learn about others', () => {
  it('a stranger\'s quote with another card never takes the customer\'s quote away; the first one sent wins', async () => {
    const link = await newLink();
    const mine = await quote(link.token, CARD);
    for (let i = 0; i < 3; i++) expect((await quote(link.token, CARD2)).status).toBe(200);
    expect(getAttempt(db, mine.data.plan.attempt_id)!.status).toBe('quoted');
    const r = await submit(link.token, mine.data.plan, sign(mine.data.plan));
    expect(r.data.status).toBe('sent');
    // The stranger's quotes cannot be sent beside it.
    const theirs = (db.prepare("SELECT plan_json FROM direct_lana_sales WHERE sale_id = ? AND payer_address = ? AND status = 'quoted'").get(link.sale_id, CARD2_ADDRESS) as any);
    const late = JSON.parse(theirs.plan_json) as DirectLanaPlan;
    expect((await submit(link.token, late, sign(late, CARD2))).status).toBe(409);
    expect(chain.broadcasts.length).toBe(1);
    // The same card asking again replaces its own quote only.
    const again = await quote(link.token, CARD2);
    expect(again.status).toBe(409);
  });

  it('at most 30 quotes per link in ten minutes; then "too many tries" (429), nothing stored', async () => {
    const link = await newLink();
    for (let i = 0; i < 30; i++) expect((await quote(link.token, i % 2 ? CARD : CARD2)).status).toBe(200);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM direct_lana_sales').get() as any).n;
    const r = await quote(link.token, CARD);
    expect(r.status).toBe(429);
    expect(r.data.code).toBe('TOO_MANY_TRIES');
    expect((db.prepare('SELECT COUNT(*) AS n FROM direct_lana_sales').get() as any).n).toBe(n);
    nowMs += 11 * 60 * 1000;
    expect((await quote(link.token, CARD)).status).toBe(200);
  });

  it('an expired quote keeps no coin\'s raw bytes after the sweep; a sent payment keeps all of them', async () => {
    const link = await newLink();
    const unsent = await quote(link.token, CARD2);
    const { plan } = await pay(link.token, CARD);
    nowMs += 130 * 1000;
    await worker();
    const gone = getAttempt(db, unsent.data.plan.attempt_id)!;
    expect(gone.status).toBe('expired');
    expect(JSON.parse(gone.plan_json).inputs.every((c: any) => c.raw === '')).toBe(true);
    const kept = getAttempt(db, plan.attempt_id)!;
    expect(JSON.parse(kept.plan_json).inputs.every((c: any) => /^[0-9a-f]+$/.test(c.raw))).toBe(true);
  });

  it('a card\'s exclusion is never said with its ground to whoever holds a link, not even with a made-up token', async () => {
    const link = await newLink();
    exclude(hexOfKey(CARD));
    for (const token of [link.token, 'y'.repeat(32)]) {
      const r = await quote(token, CARD);
      expect(r.status).toBe(403);
      expect(r.data.code).toBe('PERSON_EXCLUDED');
      for (const leak of ['ground', 'eventId', 'since', 'untilSplit', 'excluded']) expect(r.data[leak], leak).toBeUndefined();
    }
    // The card's registrar owner, found by the quote itself.
    db.prepare('DELETE FROM person_exclusions').run();
    exclude(CUSTOMER_HEX);
    const r = await quote(link.token, CARD);
    expect(r.data.code).toBe('PERSON_EXCLUDED');
    expect(JSON.stringify(r.data)).not.toContain('a ground');
  });

  it('a quote never says what else the card is paying at this shop', async () => {
    const till = await post('/api/direct-lana/quote', { unit_id: UNIT, amount: '5.00', currency: 'EUR', public_key: readCardKey(wifOf(CARD)).publicKey }, OWNER);
    const s = sign(till.data.plan);
    expect((await post('/api/direct-lana/submit', { attempt_id: till.data.plan.attempt_id, raw: s.raw, record: s.record }, OWNER)).data.status).toBe('sent');
    const link = await newLink();
    const r = await quote(link.token, CARD);
    expect(r.data.code).toBe('CARD_PAYMENT_PENDING');
    expect(r.data.pending_attempt_id).toBeUndefined();
    expect(r.data.pending_sale_id).toBeUndefined();
  });

  it('past its time a quote of the link is never sent, and an expired link can still be cancelled', async () => {
    const link = await newLink();
    nowMs += (168 * 3600 - 10) * 1000;
    const q = await quote(link.token);
    expect(q.status).toBe(200);
    nowMs += 20 * 1000;
    const r = await submit(link.token, q.data.plan, sign(q.data.plan));
    expect(r.status).toBe(409);
    expect(r.data.code).toBe('LINK_EXPIRED');
    expect(chain.broadcasts).toEqual([]);
    const c = await cancel(link.id);
    expect(c.status).toBe(200);
    expect(c.data.link.status).toBe('cancelled');
  });

  it('cancelled while the customer looks at the confirm screen: the page is told "cancelled", not "the offer ran out"', async () => {
    const link = await newLink();
    const q = await quote(link.token);
    await cancel(link.id);
    const r = await submit(link.token, q.data.plan, sign(q.data.plan));
    expect(r.status).toBe(409);
    expect(r.data.code).toBe('LINK_CANCELLED');
    expect(chain.broadcasts).toEqual([]);
  });

  it('the till cannot pay a cancelled link\'s sale either', async () => {
    const link = await newLink();
    chain.mode = 'refuse';
    await pay(link.token, CARD);
    // Every server refused it after it was sent; once the chain shows it can never be mined, cancel.
    db.prepare("UPDATE direct_lana_sales SET status = 'failed' WHERE sale_id = ?").run(link.sale_id);
    expect((await cancel(link.id)).data.link.status).toBe('cancelled');
    chain.mode = 'accept';
    const till = await post('/api/direct-lana/quote', {
      unit_id: UNIT, amount: '10.00', currency: 'EUR', public_key: readCardKey(wifOf(CARD2)).publicKey, sale_id: link.sale_id,
    }, OWNER);
    expect(till.status).toBe(409);
    expect(till.data.code).toBe('LINK_CANCELLED');
  });

  it('the page can ask about its own payment by id; the seller\'s notice counts paid links per shop', async () => {
    const link = await newLink();
    const { plan, s } = await pay(link.token);
    const v = await get(`/api/direct-pay/${link.token}?attempt=${plan.attempt_id}`, null);
    expect(v.data.link.asked).toMatchObject({ attempt_id: plan.attempt_id, status: 'sent' });
    const other = await newLink();
    expect((await get(`/api/direct-pay/${other.token}?attempt=${plan.attempt_id}`, null)).data.link.asked).toBeNull();
    await mineAndSweep(s.raw);
    const unseen = await get('/api/direct-lana/links/unseen', OWNER);
    expect(unseen.data.by_unit).toEqual({ [UNIT]: 1 });
  });
});
