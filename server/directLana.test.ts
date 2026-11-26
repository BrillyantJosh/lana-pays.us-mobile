// @vitest-environment node
/**
 * LANA neposredno through its routes and its sweep (server/directLana.ts):
 * a real express server, an in-memory database, a fake chain read from "two
 * agreeing Electrum servers", a fake registrar and fake relays. The till side
 * is the real new signer (src/lib/directLanaSign.ts) with test keys. Nothing
 * leaves this process: no relay, no Electrum, no registrar, no brain.
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
import { ChainUnavailable, type WithChain, type ChainRead, type Utxo, type BroadcastAnswer } from './lib/directLanaChain.js';
import { RegistrarUnavailable, type RegistrarAnswer } from './lib/directLanaRegistrar.js';
import { parseLanaTx, txidOfRaw } from './lib/directLanaTx.js';
import { move, getAttempt, beginValidating, refuseBeforeSending, directDedupHit } from './lib/directLanaStore.js';
import { directLanaView, unitRow } from './lib/directLanaUnit.js';
import { addressScript, bytesToHex, type DirectLanaPlan } from './lib/directLanaCore.js';
import { readCardKey, signDirectSale } from '../src/lib/directLanaSign.js';
import { keyOf, wifOf, addressOfKey, hexOfKey, previousTx } from './fixtures/directLana.js';

// ── people, wallets, shops ──────────────────────────────────────────────────
const OWNER = keyOf(7);
const OWNER_HEX = hexOfKey(OWNER);
const SHOP_WALLET = addressOfKey(OWNER);
const STAFF = keyOf(8);
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

// ── a fake chain: the same answer from both "servers" ───────────────────────
type Address = { confirmed: bigint; pending: bigint; utxos: Utxo[]; history: { txid: string; height: number }[] };
const chain = {
  addresses: new Map<string, Address>(),
  raws: new Map<string, string>(),
  mempool: new Set<string>(),
  height: 300,
  mode: 'accept' as 'accept' | 'odd' | 'refuse' | 'down',
  tipMoves: false,
  broadcasts: [] as string[],
  reads: 0,
};
const addr = (a: string): Address => {
  if (!chain.addresses.has(a)) chain.addresses.set(a, { confirmed: 0n, pending: 0n, utxos: [], history: [] });
  return chain.addresses.get(a)!;
};
let salt = 10;
/** Give an address confirmed coins, each from its own previous transaction. */
function fund(address: string, values: bigint[], height = 100) {
  const a = addr(address);
  for (const v of values) {
    const prev = previousTx(address, [v], 1000, salt++);
    chain.raws.set(prev.txid, prev.raw);
    a.utxos.push({ txid: prev.txid, vout: 0, value: v.toString(), height });
    a.history.push({ txid: prev.txid, height });
    a.confirmed += v;
  }
}
/** A payment the fake servers accepted: its coins leave the unspent list, it waits for a block. */
function enterMempool(raw: string) {
  const txid = txidOfRaw(raw);
  const tx = parseLanaTx(raw);
  chain.raws.set(txid, raw);
  chain.mempool.add(txid);
  for (const [address, a] of chain.addresses) {
    const spent = a.utxos.filter(u => tx.inputs.some(i => i.prevTxid === u.txid && i.vout === u.vout));
    if (!spent.length) continue;
    a.utxos = a.utxos.filter(u => !spent.includes(u));
    a.pending -= spent.reduce((n, u) => n + BigInt(u.value), 0n);
    if (!a.history.some(h => h.txid === txid)) a.history.push({ txid, height: 0 });
    void address;
  }
}
/** The payment is in block `height`: the payer's coins are gone for good, its change is a coin. */
function mine(raw: string, height = chain.height) {
  const txid = txidOfRaw(raw);
  const tx = parseLanaTx(raw);
  chain.raws.set(txid, raw);
  chain.mempool.delete(txid);
  for (const [address, a] of chain.addresses) {
    const own = bytesToHex(addressScript(address));
    const spent = a.utxos.filter(u => tx.inputs.some(i => i.prevTxid === u.txid && i.vout === u.vout));
    const spentValue = spent.reduce((n, u) => n + BigInt(u.value), 0n);
    const wasPending = a.history.some(h => h.txid === txid && h.height === 0);
    a.utxos = a.utxos.filter(u => !spent.includes(u));
    tx.outputs.forEach((o, vout) => {
      if (o.script === own) {
        a.utxos.push({ txid, vout, value: o.lanoshis.toString(), height });
        a.confirmed += o.lanoshis;
      }
    });
    const inputsHere = tx.inputs.some(i => chain.raws.has(i.prevTxid) && parseLanaTx(chain.raws.get(i.prevTxid)!).outputs[i.vout]?.script === own);
    if (inputsHere) {
      const prevValue = tx.inputs.reduce((n, i) => {
        const prev = chain.raws.get(i.prevTxid);
        const out = prev ? parseLanaTx(prev).outputs[i.vout] : undefined;
        return out?.script === own ? n + out.lanoshis : n;
      }, 0n);
      a.confirmed -= prevValue;
      if (wasPending) a.pending += prevValue;
      void spentValue;
    }
    if (inputsHere || tx.outputs.some(o => o.script === own)) {
      a.history = a.history.filter(h => h.txid !== txid);
      a.history.push({ txid, height });
    }
  }
}
const withChain: WithChain = async (servers, address, task) => {
  chain.reads++;
  if (servers.length < 2 || chain.mode === 'down') throw new ChainUnavailable('Electrum sources disagree');
  const a = addr(address);
  const read: ChainRead = {
    snapshot: {
      confirmed: a.confirmed.toString(), pending: a.pending.toString(),
      history: a.history.map(h => ({ ...h })), utxos: a.utxos.map(u => ({ ...u })), height: chain.height,
    },
    raw: async (id) => {
      const r = chain.raws.get(id);
      if (!r) throw new Error('unknown transaction');
      return r;
    },
    broadcast: async (raw): Promise<BroadcastAnswer[]> => {
      chain.broadcasts.push(raw);
      if (chain.mode === 'accept') { enterMempool(raw); return ['accepted', 'accepted']; }
      if (chain.mode === 'odd') return ['unknown', 'unknown'];
      return ['refused', 'refused'];
    },
    holds: async (txid) => [chain.mempool.has(txid), chain.mempool.has(txid)],
    tipUnchanged: async () => !chain.tipMoves,
  };
  return task(read);
};

// ── a fake registrar ─────────────────────────────────────────────────────────
const registrar = new Map<string, RegistrarAnswer | 'down'>();
const registrarAsked: string[] = [];
const wallet = (type: string, owner: string | null, frozen = false): RegistrarAnswer =>
  ({ registered: true, wallet_type: type, frozen, freeze_reason: frozen ? 'frozen_max_cap' : null, owner });

// ── fake relays ──────────────────────────────────────────────────────────────
const published: Array<{ id: string; sig: string; relays: string[] }> = [];
let relaysAccepting: string[] | null = null;
const RELAYS = ['wss://r1.example', 'wss://r2.example', 'wss://r3.example', 'wss://r4.example'];

const deps: Partial<DirectLanaDeps> = {
  withChain,
  registrar: async (w) => {
    registrarAsked.push(w);
    const a = registrar.get(w);
    if (a === 'down') throw new RegistrarUnavailable('down');
    return a ?? { registered: false };
  },
  publish: async (event, relays) => {
    published.push({ id: event.id, sig: event.sig, relays });
    return relaysAccepting ? relays.filter(r => relaysAccepting!.includes(r)) : relays;
  },
  nowMs: () => nowMs,
  paramsPubkey: hexOfKey(PARAMS),
  limitPerMinute: 10_000,
};

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

function seedUnits() {
  const ins = db.prepare(`
    INSERT OR REPLACE INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event, unit_type, lana_only, suspension_status)
    VALUES (?, ?, ?, 1, ?, ?, ?, 'EUR', 'active', ?, NULL, 0, 'active')
  `);
  ins.run(UNIT, 'e'.repeat(64), OWNER_HEX, 'Kmetija Novak', OWNER_HEX, JSON.stringify([OWNER_HEX, hexOfKey(STAFF)]),
    unitEvent(UNIT, OWNER_HEX, [['payout_account', 'none'], ['margin_percent', '10'], ['lanapays_payout_method', 'lana'], ['lanapays_payout_wallet', SHOP_WALLET]]));
  ins.run(COMPANY, 'd'.repeat(64), OWNER_HEX, 'Podjetje d.o.o.', OWNER_HEX, JSON.stringify([OWNER_HEX]),
    unitEvent(COMPANY, OWNER_HEX, [['receiver_type', 'company'], ['lanapays_payout_wallet', SHOP_WALLET]]));
}

// ── signed requests ──────────────────────────────────────────────────────────
function auth(method: string, path: string, body: string | undefined, key: Uint8Array) {
  const tags = [['u', path], ['method', method], ['nonce', crypto.randomBytes(8).toString('hex')]];
  if (body !== undefined) tags.push(['payload', crypto.createHash('sha256').update(body).digest('hex')]);
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, key);
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}
async function post(path: string, body: unknown, key: Uint8Array | null = OWNER) {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = auth('POST', path, text, key);
  const res = await fetch(base + path, { method: 'POST', headers, body: text });
  return { status: res.status, data: await res.json() as any };
}
async function get(path: string, key: Uint8Array | null = OWNER) {
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = auth('GET', path.split('?')[0], undefined, key);
  const res = await fetch(base + path, { headers });
  return { status: res.status, data: await res.json() as any };
}

const quote = (extra: Record<string, unknown> = {}, card = CARD) =>
  post('/api/direct-lana/quote', { unit_id: UNIT, amount: '10.00', currency: 'EUR', public_key: readCardKey(wifOf(card)).publicKey, ...extra });

/** What the till does after a quote: sign it with the card key, then send it. */
function sign(plan: DirectLanaPlan, card = CARD) {
  return signDirectSale(readCardKey(wifOf(card)), plan);
}
const submit = (plan: DirectLanaPlan, signed: ReturnType<typeof sign>) =>
  post('/api/direct-lana/submit', { attempt_id: plan.attempt_id, raw: signed.raw, record: signed.record });

async function paySent(extra: Record<string, unknown> = {}, card = CARD) {
  const q = await quote(extra, card);
  expect(q.status, JSON.stringify(q.data)).toBe(200);
  const s = sign(q.data.plan, card);
  const r = await submit(q.data.plan, s);
  return { q, s, r, plan: q.data.plan as DirectLanaPlan };
}

const row = (id: string) => getAttempt(db, id)!;

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
  db.exec('DELETE FROM direct_lana_sales; DELETE FROM direct_lana_payees; DELETE FROM kind_38888; DELETE FROM business_units; DELETE FROM person_exclusions;');
  seedUnits();
  store38888();
  chain.addresses.clear(); chain.raws.clear(); chain.mempool.clear(); chain.broadcasts.length = 0;
  chain.mode = 'accept'; chain.tipMoves = false; chain.height = 300; chain.reads = 0;
  fund(CARD_ADDRESS, [10_000_000_000n]);
  fund(CARD2_ADDRESS, [10_000_000_000n]);
  registrar.clear(); registrarAsked.length = 0;
  registrar.set(CARD_ADDRESS, wallet('Main Wallet', CUSTOMER_HEX));
  registrar.set(CARD2_ADDRESS, wallet('Wallet', hexOfKey(keyOf(12))));
  registrar.set(SHOP_WALLET, wallet('Main Wallet', OWNER_HEX));
  published.length = 0;
  relaysAccepting = null;
});

describe('the price', () => {
  it('10.00 € + 10 % = 11.00 € = 42.96875 LANA at 0.256, as exact strings', async () => {
    const { status, data } = await get(`/api/direct-lana/price?unit_id=${UNIT}&amount=10.00`);
    expect(status).toBe(200);
    expect(data).toMatchObject({
      invoice: '10.00', margin_percent: 10, margin: '1.00', total: '11.00', pay_cents: '1100',
      lanoshi: '4296875000', lana: '42.96875', rate: '0.256', currency: 'EUR', recipient: SHOP_WALLET,
    });
  });

  it('needs the seller\'s signature, from the shop\'s owner or staff', async () => {
    expect((await get(`/api/direct-lana/price?unit_id=${UNIT}&amount=10`, null)).status).toBe(401);
    expect((await get(`/api/direct-lana/price?unit_id=${UNIT}&amount=10`, STRANGER)).data.code).toBe('NOT_ENTITLED');
    expect((await get(`/api/direct-lana/price?unit_id=${UNIT}&amount=10`, STAFF)).status).toBe(200);
  });
});

describe('a shop with a company can never reach this path', () => {
  it('price and quote are refused for it; nothing is asked of the registrar or the chain', async () => {
    expect((await get(`/api/direct-lana/price?unit_id=${COMPANY}&amount=10`)).data.code).toBe('UNIT_NOT_DIRECT');
    const q = await quote({ unit_id: COMPANY });
    expect(q.status).toBe(409);
    expect(q.data.code).toBe('UNIT_NOT_DIRECT');
    expect(registrarAsked).toEqual([]);
    expect(chain.reads).toBe(0);
  });

  it('its till answer carries no direct_lana at all; a shop without a company carries it', () => {
    expect(directLanaView(db, unitRow(db, UNIT), { pubkey: hexOfKey(PARAMS) })).toEqual({ enabled: true, reason: null });
  });
});

describe('no switch (Brilly, 26 Nov 2026): every shop without a company takes it', () => {
  it('a fresh database has no switch, and the shop quotes with nothing set anywhere', async () => {
    const fresh = new Database(':memory:');
    initializeSchema(fresh);
    expect(fresh.prepare("SELECT value FROM app_settings WHERE key = 'direct_lana_units'").get()).toBeUndefined();
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'direct_lana_units'").get()).toBeUndefined();
    expect((await quote()).status).toBe(200);
    expect(directLanaView(db, unitRow(db, UNIT), { pubkey: hexOfKey(PARAMS) })).toEqual({ enabled: true, reason: null });
  });

  it('the old setting, left "off" in a database, turns nothing off: the next start drops it', async () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('direct_lana_units', '')").run();
    expect((await quote()).status).toBe(200);
    expect(directLanaView(db, unitRow(db, UNIT), { pubkey: hexOfKey(PARAMS) })).toEqual({ enabled: true, reason: null });
    initializeSchema(db);
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'direct_lana_units'").get()).toBeUndefined();
  });
});

describe('a whole sale: quote, sign, send, settle, publish', () => {
  it('sent when a server answers with the txid; paid in a block; the identical record published to 3+ relays', async () => {
    const { plan, s, r } = await paySent();
    expect(r.status).toBe(200);
    expect(r.data.status).toBe('sent');
    expect(r.data.txid).toBe(s.txid);
    expect(chain.broadcasts).toEqual([s.raw]);
    // Kept before it was sent: the exact bytes and the signed record.
    const kept = row(plan.attempt_id);
    expect(kept.raw_tx).toBe(s.raw);
    expect(JSON.parse(kept.record_json!).id).toBe(s.record.id);
    // Not published while only sent.
    await runDirectLanaWorker(db, { ...deps, ...{} } as DirectLanaDeps);
    expect(published).toEqual([]);

    mine(s.raw, 301);
    chain.height = 301;
    const pass = await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(pass.settled).toContain(`${plan.attempt_id}:paid`);
    expect(row(plan.attempt_id).status).toBe('paid');
    expect(row(plan.attempt_id).paid_height).toBe(301);
    expect(published.length).toBe(1);
    expect(published[0]).toMatchObject({ id: s.record.id, sig: s.record.sig });
    expect(row(plan.attempt_id).record_published).toBe(1);
    // The shop's wallet is read again once the payment is in a block.
    expect(registrarAsked.filter(w => w === SHOP_WALLET).length).toBeGreaterThanOrEqual(3);
  });

  it('the KIND 9350 record names the card as sender and the shop\'s owner, wallet and name as recipient', async () => {
    const { s } = await paySent({ invoice_number: 'R-7' });
    const body = JSON.parse(s.record.content);
    expect(s.record.pubkey).toBe(hexOfKey(CARD));
    expect(body.sender).toEqual({ hex: hexOfKey(CARD), wallet: CARD_ADDRESS });
    expect(body.recipient).toEqual({ hex: OWNER_HEX, wallet: SHOP_WALLET, name: 'Kmetija Novak' });
    expect(body.description).toContain('Invoice no.: R-7');
    expect(body.description).toContain(`Unit: Kmetija Novak (${UNIT})`);
  });

  it('never stores a key: no WIF, no private key bytes anywhere in the journal', async () => {
    await paySent();
    const dump = JSON.stringify(db.prepare('SELECT * FROM direct_lana_sales').all());
    expect(dump).not.toContain(wifOf(CARD));
    expect(dump).not.toContain(bytesToHex(CARD));
  });
});

describe('every check refuses before anything is sent', () => {
  const refusedAtQuote = async (codeWanted: string, status?: number) => {
    const q = await quote();
    expect(q.data.code, JSON.stringify(q.data)).toBe(codeWanted);
    if (status) expect(q.status).toBe(status);
    expect(chain.broadcasts).toEqual([]);
  };

  it('a registrar that does not answer: 503, nothing sent', async () => {
    registrar.set(CARD_ADDRESS, 'down');
    await refusedAtQuote('REGISTRAR_UNAVAILABLE', 503);
    registrar.set(CARD_ADDRESS, wallet('Main Wallet', CUSTOMER_HEX));
    registrar.set(SHOP_WALLET, 'down');
    await refusedAtQuote('REGISTRAR_UNAVAILABLE', 503);
  });

  it('the card: not registered, frozen, owner unknown, a type that may not pay', async () => {
    registrar.delete(CARD_ADDRESS);
    await refusedAtQuote('PAYER_NOT_REGISTERED');
    registrar.set(CARD_ADDRESS, wallet('Main Wallet', CUSTOMER_HEX, true));
    await refusedAtQuote('PAYER_FROZEN');
    registrar.set(CARD_ADDRESS, wallet('Main Wallet', null));
    await refusedAtQuote('PAYER_OWNER_UNKNOWN');
    for (const type of ['Lana8Wonder', 'Lana.Discount', 'Knights', 'Something new']) {
      registrar.set(CARD_ADDRESS, wallet(type, CUSTOMER_HEX));
      await refusedAtQuote('PAYER_TYPE_NOT_ALLOWED');
    }
    for (const type of ['Main Wallet', 'Wallet', 'Retail', 'LanaPays.Us']) {
      registrar.set(CARD_ADDRESS, wallet(type, CUSTOMER_HEX));
      expect((await quote()).status, type).toBe(200);
    }
  });

  it('the shop\'s wallet: not registered, frozen (and remembered), not a Main Wallet, not the owner\'s', async () => {
    registrar.delete(SHOP_WALLET);
    await refusedAtQuote('PAYEE_NOT_REGISTERED');
    registrar.set(SHOP_WALLET, wallet('Main Wallet', OWNER_HEX, true));
    await refusedAtQuote('PAYEE_FROZEN');
    expect(directLanaView(db, unitRow(db, UNIT), { pubkey: hexOfKey(PARAMS) })).toEqual({ enabled: false, reason: 'PAYEE_FROZEN' });
    registrar.set(SHOP_WALLET, wallet('LanaPays.Us', OWNER_HEX));
    // The frozen mark stays until a fresh answer says otherwise (the sweep asks again).
    await refusedAtQuote('PAYEE_FROZEN');
    db.prepare('UPDATE direct_lana_payees SET checked_at = 0').run();
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    await refusedAtQuote('PAYEE_TYPE_NOT_ALLOWED');
    registrar.set(SHOP_WALLET, wallet('Main Wallet', CUSTOMER_HEX));
    await refusedAtQuote('PAYEE_OWNER_MISMATCH');
  });

  it('the shop\'s owner paying the own shop', async () => {
    registrar.set(CARD_ADDRESS, wallet('Wallet', OWNER_HEX));
    await refusedAtQuote('SELF_PAYMENT');
  });

  it('a KIND 87058 decision against the card or against its registrar owner', async () => {
    const exclude = (hex: string) => db.prepare(`INSERT INTO person_exclusions (d_tag, person_hex, active, ground, since, event_id, event_created_at) VALUES (?, ?, 1, 'g', 1, 'ev', 1)`).run(`d-${hex}`, hex);
    exclude(hexOfKey(CARD));
    const q1 = await quote();
    expect(q1.status).toBe(403);
    expect(q1.data.code).toBe('PERSON_EXCLUDED');
    db.prepare('DELETE FROM person_exclusions').run();
    exclude(CUSTOMER_HEX);
    const q2 = await quote();
    expect(q2.status).toBe(403);
    expect(q2.data.code).toBe('PERSON_EXCLUDED');
    expect(chain.broadcasts).toEqual([]);
  });

  it('no price, an amount too small, a currency that is not the shop\'s', async () => {
    db.prepare('DELETE FROM kind_38888').run();
    await refusedAtQuote('RATE_UNAVAILABLE', 503);
    store38888();
    expect((await quote({ amount: '0.00' })).data.code).toBe('AMOUNT_INVALID');
    expect((await quote({ amount: '10.005' })).data.code).toBe('AMOUNT_INVALID');
    expect((await quote({ currency: 'USD' })).data.code).toBe('CURRENCY_MISMATCH');
  });

  it('a KIND 38888 not signed by the pinned key is no price', async () => {
    const forged = finalizeEvent({ kind: 38888, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'main'], ['fx', 'EUR', '0.001']], content: '' }, STRANGER);
    db.prepare('INSERT INTO kind_38888 (event_id, raw_event) VALUES (?, ?)').run(forged.id, JSON.stringify(forged));
    await refusedAtQuote('RATE_UNAVAILABLE');
  });

  it('two servers that do not agree, or a block arriving mid-read', async () => {
    chain.mode = 'down';
    await refusedAtQuote('CHAIN_UNAVAILABLE', 503);
    chain.mode = 'accept';
    chain.tipMoves = true;
    await refusedAtQuote('WALLET_STATE_CHANGED');
  });

  it('not enough confirmed LANA, fee included', async () => {
    addr(CARD_ADDRESS).utxos = [];
    addr(CARD_ADDRESS).confirmed = 0n;
    fund(CARD_ADDRESS, [4_296_875_000n]);
    await refusedAtQuote('INSUFFICIENT_FUNDS');
  });
});

describe('at submit, everything is asked again', () => {
  it('a price change between quote and submit: RATE_CHANGED, refused, nothing sent', async () => {
    const q = await quote();
    db.prepare('DELETE FROM kind_38888').run();
    store38888('0.3');
    const r = await submit(q.data.plan, sign(q.data.plan));
    expect(r.status).toBe(409);
    expect(r.data).toMatchObject({ code: 'RATE_CHANGED', status: 'refused', sent: false });
    expect(chain.broadcasts).toEqual([]);
  });

  it('a registrar gone quiet between quote and submit: refused, nothing sent', async () => {
    const q = await quote();
    registrar.set(SHOP_WALLET, 'down');
    const r = await submit(q.data.plan, sign(q.data.plan));
    expect(r.data).toMatchObject({ code: 'REGISTRAR_UNAVAILABLE', status: 'refused', sent: false });
    expect(chain.broadcasts).toEqual([]);
  });

  it('a quote past its 120 s', async () => {
    const q = await quote();
    nowMs += 121_000;
    const r = await submit(q.data.plan, sign(q.data.plan));
    expect(r.data.code).toBe('QUOTE_EXPIRED');
    expect(row(q.data.attempt_id).status).toBe('expired');
    expect(chain.broadcasts).toEqual([]);
  });

  it('other bytes than the plan, or another record: refused, the quote stays as it was', async () => {
    const q = await quote();
    const s = sign(q.data.plan);
    // The lock time changed: other bytes than the plan's.
    const tampered = s.raw.slice(0, -1) + (s.raw.endsWith('0') ? '1' : '0');
    expect((await submit(q.data.plan, { ...s, raw: tampered })).data.code).toBe('TX_INVALID');
    // Signed by another card for the same plan: refused before it is signed at all.
    expect(() => sign(q.data.plan, CARD2)).toThrow(/CARD_MISMATCH/);
    const record = { ...s.record, content: s.record.content.replace('Kmetija', 'Kmetijo') };
    expect((await submit(q.data.plan, { ...s, record })).data.code).toBe('RECORD_INVALID');
    expect(row(q.data.attempt_id).status).toBe('quoted');
    expect(chain.broadcasts).toEqual([]);
  });

  it('a coin spent meanwhile', async () => {
    const q = await quote();
    addr(CARD_ADDRESS).utxos = [];
    const r = await submit(q.data.plan, sign(q.data.plan));
    expect(r.data.code === 'WALLET_STATE_CHANGED' || r.data.code === 'CHAIN_PENDING').toBe(true);
    expect(chain.broadcasts).toEqual([]);
  });

  it('a shop wallet changed meanwhile', async () => {
    const q = await quote();
    const other = addressOfKey(keyOf(13));
    db.prepare('UPDATE business_units SET raw_event = ? WHERE unit_id = ?').run(
      unitEvent(UNIT, OWNER_HEX, [['payout_account', 'none'], ['margin_percent', '10'], ['lanapays_payout_method', 'lana'], ['lanapays_payout_wallet', other]]), UNIT);
    const r = await submit(q.data.plan, sign(q.data.plan));
    expect(r.data.code).toBe('WALLET_CHANGED');
    expect(chain.broadcasts).toEqual([]);
  });
});

describe('after sending: only the chain decides', () => {
  it('a reply that is not exactly the txid: unknown, never sent', async () => {
    chain.mode = 'odd';
    const { r, plan } = await paySent();
    expect(r.data.status).toBe('unknown');
    expect(row(plan.attempt_id).sent).toBe(1);
  });

  it('every server refused it and none holds it: refused, sent = 1, the card is held', async () => {
    chain.mode = 'refuse';
    const { r, plan } = await paySent();
    expect(r.data).toMatchObject({ status: 'refused', sent: true, code: 'BROADCAST_REFUSED' });
    chain.mode = 'accept';
    const again = await quote();
    expect(again.data.code).toBe('CARD_PAYMENT_PENDING');
    expect(again.data.pending_attempt_id).toBe(plan.attempt_id);
  });

  it('unknown stays unknown while its coins are unspent, however long: never resolved by time', async () => {
    chain.mode = 'odd';
    const { plan } = await paySent();
    for (const days of [1, 30, 365]) {
      nowMs = Date.now() + days * 86_400_000;
      await runDirectLanaWorker(db, deps as DirectLanaDeps);
      expect(row(plan.attempt_id).status, `after ${days} days`).toBe('unknown');
    }
  });

  it('a coin spent by ANOTHER transaction: failed only once that one is 6 blocks deep', async () => {
    chain.mode = 'odd';
    const { plan } = await paySent();
    // The customer spent the same coin elsewhere, in block 301.
    const coin = plan.inputs[0];
    const other = signDirectSale(readCardKey(wifOf(CARD)), { ...plan, recipient: CARD2_ADDRESS, attempt_id: `dla_${'9'.repeat(32)}` });
    mine(other.raw, 301);
    expect(addr(CARD_ADDRESS).utxos.some(u => u.txid === coin.txid)).toBe(false);
    chain.height = 305; // 5 deep
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(row(plan.attempt_id).status).toBe('unknown');
    chain.height = 306; // 6 deep
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(row(plan.attempt_id).status).toBe('failed');
    expect(published).toEqual([]);
  });

  it('the identical bytes again, only when the seller asks: sent', async () => {
    chain.mode = 'odd';
    const { plan, s } = await paySent();
    chain.mode = 'accept';
    const r = await post(`/api/direct-lana/sales/${plan.attempt_id}/resend`, { attempt_id: plan.attempt_id });
    expect(r.data.status).toBe('sent');
    expect(chain.broadcasts).toEqual([s.raw, s.raw]);
  });
});

describe('double submit, and two payments at once', () => {
  it('the same bytes again: the stored status; other bytes for the same attempt: 409', async () => {
    const { plan, s, r } = await paySent();
    expect(r.data.status).toBe('sent');
    const again = await submit(plan, s);
    expect(again.status).toBe(200);
    expect(again.data.status).toBe('sent');
    expect(chain.broadcasts.length).toBe(1);
    const other = signDirectSale(readCardKey(wifOf(CARD)), { ...plan, recipient: CARD2_ADDRESS });
    const conflict = await submit(plan, other);
    expect(conflict.status).toBe(409);
    expect(conflict.data.code).toBe('SALE_CONFLICT');
  });

  it('another sale from the same card while one is unresolved: 409, at quote and at submit', async () => {
    const first = await quote();
    const second = await quote({ amount: '5.00' });
    expect(second.status).toBe(200); // two quotes may exist; only one may be sent
    expect((await submit(first.data.plan, sign(first.data.plan))).data.status).toBe('sent');
    const late = await submit(second.data.plan, sign(second.data.plan));
    expect(late.status).toBe(409);
    expect(late.data.code).toBe('CARD_PAYMENT_PENDING');
    expect((await quote({ amount: '3.00' })).data.code).toBe('CARD_PAYMENT_PENDING');
    expect(chain.broadcasts.length).toBe(1);
  });

  it('an invoice number paid in this shop is paid once', async () => {
    const { s } = await paySent({ invoice_number: 'R-1' });
    mine(s.raw, 301);
    chain.height = 301;
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect((await quote({ invoice_number: 'R-1' }, CARD2)).data.code).toBe('INVOICE_USED');
    expect((await quote({ invoice_number: 'R-2' }, CARD2)).status).toBe(200);
  });
});

describe('the replacement rule: a hanging payment is replaced only by one that spends its coins', () => {
  it('not while it is sent; for the same sale after "unknown", spending one of the same coins; the old one is superseded', async () => {
    // Sent: the card waits for its block.
    const sent = await paySent();
    expect((await quote({ sale_id: sent.plan.sale_id })).data.code).toBe('CARD_PAYMENT_PENDING');

    // Unknown (and not in either server's mempool): another sale is refused,
    // the same sale may be paid again with one of the same coins.
    chain.mode = 'odd';
    const hanging = await paySent({}, CARD2);
    expect(hanging.r.data.status).toBe('unknown');
    chain.mode = 'accept';
    expect((await quote({ amount: '4.00' }, CARD2)).data.code).toBe('CARD_PAYMENT_PENDING');
    const replacement = await quote({ sale_id: hanging.plan.sale_id }, CARD2);
    expect(replacement.status).toBe(200);
    expect(replacement.data.replaces).toEqual([hanging.plan.attempt_id]);
    const shared = replacement.data.plan.inputs.some((i: any) => hanging.plan.inputs.some(h => h.txid === i.txid && h.vout === i.vout));
    expect(shared, 'the replacement spends one of the same coins').toBe(true);
    // Never byte for byte the payment it replaces: stamped after it, so another txid.
    expect(replacement.data.plan.created_at).toBeGreaterThan(hanging.plan.created_at);
    const sentAgain = await submit(replacement.data.plan, sign(replacement.data.plan, CARD2));
    expect(sentAgain.data.status, JSON.stringify(sentAgain.data)).toBe("sent");
    expect(row(hanging.plan.attempt_id).status).toBe('superseded');
  });

  it('if the superseded one is mined after all, it is paid and its replacement fails', async () => {
    chain.mode = 'odd';
    const hanging = await paySent();
    chain.mode = 'accept';
    const replacement = await quote({ sale_id: hanging.plan.sale_id });
    const signedReplacement = sign(replacement.data.plan);
    // Send the replacement, but the network mines the OLD one.
    chain.mode = 'odd';
    expect((await submit(replacement.data.plan, signedReplacement)).data.status).toBe('unknown');
    expect(row(hanging.plan.attempt_id).status).toBe('superseded');
    mine(hanging.s.raw, 301);
    chain.height = 301;
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(row(hanging.plan.attempt_id).status).toBe('paid');
    expect(row(replacement.data.attempt_id).status).toBe('unknown');
    chain.height = 306;
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(row(replacement.data.attempt_id).status).toBe('failed');
    // One record, of the payment that is in a block.
    expect(published.map(p => p.id)).toEqual([hanging.s.record.id]);
  });

  it('a sale with a payment hanging from one card cannot be paid from another card', async () => {
    chain.mode = 'odd';
    const hanging = await paySent();
    chain.mode = 'accept';
    expect((await quote({ sale_id: hanging.plan.sale_id }, CARD2)).data.code).toBe('SALE_PAYMENT_PENDING');
  });
});

describe('the record is published only for paid payments, never re-signed', () => {
  it('sent, unknown, refused, superseded and failed payments are never published', async () => {
    chain.mode = 'odd';
    await paySent();
    chain.mode = 'refuse';
    await paySent({}, CARD2);
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(published).toEqual([]);
  });

  it('re-sends the identical event until 3 relays accepted it', async () => {
    const { s, plan } = await paySent();
    mine(s.raw, 301);
    chain.height = 301;
    relaysAccepting = ['wss://r1.example', 'wss://r2.example'];
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(row(plan.attempt_id).record_published).toBe(0);
    relaysAccepting = ['wss://r3.example'];
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(row(plan.attempt_id).record_published).toBe(1);
    expect(published.length).toBe(2);
    expect(published.every(p => p.id === s.record.id && p.sig === s.record.sig)).toBe(true);
    // The second pass asked only the relays that had not accepted it yet.
    expect(published[1].relays).toEqual(['wss://r3.example', 'wss://r4.example']);
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(published.length).toBe(2);
  });
});

describe('the journal holds its rules by itself', () => {
  it('statuses only move forward', async () => {
    const { plan } = await paySent();
    const now = Math.floor(Date.now() / 1000);
    expect(move(db, plan.attempt_id, ['quoted'], 'validating', now)).toBe(false);
    expect(move(db, plan.attempt_id, ['sent'], 'paid', now, { paid_height: 1 })).toBe(true);
    for (const back of ['quoted', 'sent', 'unknown', 'validating'] as const) {
      expect(move(db, plan.attempt_id, ['sent', 'unknown', 'refused', 'superseded'], back, now)).toBe(false);
    }
    expect(row(plan.attempt_id).status).toBe('paid');
  });

  it('the unique indexes: one live attempt per sale, one unresolved payment per card, one row per txid, a paid invoice once', async () => {
    const { plan } = await paySent({ invoice_number: 'R-9' });
    const original = row(plan.attempt_id);
    const insert = (over: Partial<Record<string, unknown>>) => {
      const r = { ...original, ...over } as any;
      const cols = Object.keys(r).filter(k => k !== 'updated_at');
      db.prepare(`INSERT INTO direct_lana_sales (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => r[c]));
    };
    // Same sale, another card, also unresolved.
    expect(() => insert({ id: `dla_${'a'.repeat(32)}`, txid: 'a'.repeat(64), payer_address: CARD2_ADDRESS })).toThrow(/UNIQUE/);
    // Same card, another sale, also unresolved.
    expect(() => insert({ id: `dla_${'b'.repeat(32)}`, txid: 'b'.repeat(64), sale_id: `dls_${'b'.repeat(32)}` })).toThrow(/UNIQUE/);
    // The same txid twice.
    expect(() => insert({ id: `dla_${'c'.repeat(32)}`, sale_id: `dls_${'c'.repeat(32)}`, payer_address: CARD2_ADDRESS, status: 'failed' })).toThrow(/UNIQUE/);
    // A paid invoice number of the unit, twice.
    move(db, plan.attempt_id, ['sent'], 'paid', 1, { paid_height: 1 });
    expect(() => insert({ id: `dla_${'d'.repeat(32)}`, txid: 'd'.repeat(64), sale_id: `dls_${'d'.repeat(32)}`, payer_address: CARD2_ADDRESS, status: 'paid' })).toThrow(/UNIQUE/);
  });
});

describe('review fixes (23 Nov 2026)', () => {
  it('a frozen shop wallet stays marked when the register no longer knows it; only "registered, not frozen" clears it', async () => {
    registrar.set(SHOP_WALLET, wallet('Main Wallet', OWNER_HEX, true));
    expect((await quote()).data.code).toBe('PAYEE_FROZEN');
    registrar.delete(SHOP_WALLET);
    db.prepare('UPDATE direct_lana_payees SET checked_at = 0').run();
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(directLanaView(db, unitRow(db, UNIT), { pubkey: hexOfKey(PARAMS) })).toEqual({ enabled: false, reason: 'PAYEE_FROZEN' });
    // Asked, and remembered as asked: not again on every pass of the sweep.
    const asked = registrarAsked.length;
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(registrarAsked.length).toBe(asked);

    registrar.set(SHOP_WALLET, wallet('Main Wallet', OWNER_HEX));
    db.prepare('UPDATE direct_lana_payees SET checked_at = 0').run();
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(directLanaView(db, unitRow(db, UNIT), { pubkey: hexOfKey(PARAMS) })).toEqual({ enabled: true, reason: null });
  });

  it('a re-send says what it did: refused by every server again, or taken because a server already holds it', async () => {
    chain.mode = 'odd';
    const { plan, s } = await paySent();
    chain.mode = 'refuse';
    const again = await post(`/api/direct-lana/sales/${plan.attempt_id}/resend`, { attempt_id: plan.attempt_id });
    expect(again.data).toMatchObject({ resend: 'refused', status: 'unknown' });
    // Refused in words, yet a server holds exactly these bytes: it is on its way.
    chain.mempool.add(s.txid);
    const held = await post(`/api/direct-lana/sales/${plan.attempt_id}/resend`, { attempt_id: plan.attempt_id });
    expect(held.data).toMatchObject({ resend: 'accepted', status: 'sent' });
    expect(chain.broadcasts).toEqual([s.raw, s.raw, s.raw]);
  });

  it('a coin spent by another transaction IN THE SAME BLOCK as the coin still proves "failed" once 6 deep', async () => {
    chain.mode = 'odd';
    const { plan } = await paySent();
    const coinHeight = plan.inputs[0].height;
    const other = signDirectSale(readCardKey(wifOf(CARD)), { ...plan, recipient: CARD2_ADDRESS, attempt_id: `dla_${'8'.repeat(32)}` });
    mine(other.raw, coinHeight);
    chain.height = coinHeight + 4; // 5 deep
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(row(plan.attempt_id).status).toBe('unknown');
    chain.height = coinHeight + 5; // 6 deep
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(row(plan.attempt_id).status).toBe('failed');
  });
});

// ── Review fixes, second round (23 Nov 2026) ────────────────────────────────

const exclude = (hex: string) => db.prepare(`INSERT INTO person_exclusions (d_tag, person_hex, active, ground, since, event_id, event_created_at) VALUES (?, ?, 1, 'g', 1, 'ev', 1)`).run(`d-${hex}`, hex);
const resend = (id: string, key: Uint8Array = OWNER) => post(`/api/direct-lana/sales/${id}/resend`, { attempt_id: id }, key);
const setUnitEvent = (tags: string[][]) => db.prepare('UPDATE business_units SET raw_event = ? WHERE unit_id = ?').run(unitEvent(UNIT, OWNER_HEX, tags), UNIT);
/** The tags shop.lanapays.us option (c) signs, as the seed has them. */
const OPTION_C = [['payout_account', 'none'], ['margin_percent', '10'], ['lanapays_payout_method', 'lana'], ['lanapays_payout_wallet', SHOP_WALLET]];
const journalSize = () => (db.prepare('SELECT COUNT(*) AS n FROM direct_lana_sales').get() as { n: number }).n;
const asStaff = (extra: Record<string, unknown> = {}) =>
  post('/api/direct-lana/quote', { unit_id: UNIT, amount: '10.00', currency: 'EUR', public_key: readCardKey(wifOf(CARD)).publicKey, ...extra }, STAFF);

/** A payment every server refused after it was handed over: refused, sent = 1. */
async function refusedAfterSending(card = CARD) {
  chain.mode = 'refuse';
  const paid = await paySent({}, card);
  expect(paid.r.data).toMatchObject({ status: 'refused', sent: true });
  chain.mode = 'accept';
  return paid;
}
/** A payment without a clear answer: unknown. */
async function hangingPayment(card = CARD) {
  chain.mode = 'odd';
  const paid = await paySent({}, card);
  expect(paid.r.data.status).toBe('unknown');
  chain.mode = 'accept';
  return paid;
}

describe('a re-send is held to every check of a submit (review: it moved money past the shop and the price)', () => {
  const cases: Array<[string, () => void, string]> = [
    ['the shop suspended (KIND 30903)', () => db.prepare("UPDATE business_units SET suspension_status = 'suspended' WHERE unit_id = ?").run(UNIT), 'UNIT_BLOCKED'],
    ['the shop pending again', () => db.prepare("UPDATE business_units SET suspension_status = 'pending' WHERE unit_id = ?").run(UNIT), 'UNIT_BLOCKED'],
    ['the shop re-signed as a company unit', () => setUnitEvent([['receiver_type', 'company'], ['lanapays_payout_wallet', SHOP_WALLET]]), 'UNIT_NOT_DIRECT'],
    ['the shop no longer active', () => db.prepare("UPDATE business_units SET status = 'inactive' WHERE unit_id = ?").run(UNIT), 'UNKNOWN_UNIT'],
    ['the shop now paying into another wallet', () => setUnitEvent([...OPTION_C.filter(t => t[0] !== 'lanapays_payout_wallet'), ['lanapays_payout_wallet', addressOfKey(keyOf(13))]]), 'WALLET_CHANGED'],
    ['the LANA price moved from 0.256 to 0.5', () => { db.prepare('DELETE FROM kind_38888').run(); store38888('0.5'); }, 'RATE_CHANGED'],
    ['no LANA price any more', () => db.prepare('DELETE FROM kind_38888').run(), 'RATE_UNAVAILABLE'],
  ];
  for (const [label, change, code] of cases) {
    it(`${label}: ${code}, the bytes do not go out again (refused after sending, and unknown)`, async () => {
      const refused = await refusedAfterSending(CARD);
      const hanging = await hangingPayment(CARD2);
      const before = chain.broadcasts.length;
      change();
      for (const p of [refused, hanging]) {
        const r = await resend(p.plan.attempt_id);
        expect(r.data.code, `${label}: ${JSON.stringify(r.data)}`).toBe(code);
        expect(r.data.success).toBe(false);
        // The whole attempt, as it is: a refused re-send resolves nothing.
        expect(r.data).toMatchObject({ attempt_id: p.plan.attempt_id, pay_cents: '1100' });
      }
      expect(chain.broadcasts.length).toBe(before);
      expect(row(refused.plan.attempt_id)).toMatchObject({ status: 'refused', sent: 1 });
      expect(row(hanging.plan.attempt_id).status).toBe('unknown');
    });
  }

  it('the card frozen now, the register silent, the shop\'s wallet frozen: refused, nothing goes out', async () => {
    const { plan } = await refusedAfterSending();
    registrar.set(CARD_ADDRESS, wallet('Main Wallet', CUSTOMER_HEX, true));
    expect((await resend(plan.attempt_id)).data.code).toBe('PAYER_FROZEN');
    registrar.set(CARD_ADDRESS, 'down');
    const down = await resend(plan.attempt_id);
    expect(down.status).toBe(503);
    expect(down.data.code).toBe('REGISTRAR_UNAVAILABLE');
    registrar.set(CARD_ADDRESS, wallet('Main Wallet', CUSTOMER_HEX));
    registrar.set(SHOP_WALLET, wallet('Main Wallet', OWNER_HEX, true));
    expect((await resend(plan.attempt_id)).data.code).toBe('PAYEE_FROZEN');
    expect(chain.broadcasts.length).toBe(1);
  });

  it('the card\'s owner as the register names it NOW: its KIND 87058 decision, and the shop\'s own owner', async () => {
    const { plan } = await refusedAfterSending();
    const newOwner = hexOfKey(keyOf(14));
    registrar.set(CARD_ADDRESS, wallet('Main Wallet', newOwner));
    exclude(newOwner);
    const r = await resend(plan.attempt_id);
    expect(r.status).toBe(403);
    expect(r.data.code).toBe('PERSON_EXCLUDED');
    db.prepare('DELETE FROM person_exclusions').run();
    registrar.set(CARD_ADDRESS, wallet('Main Wallet', OWNER_HEX));
    expect((await resend(plan.attempt_id)).data.code).toBe('SELF_PAYMENT');
    expect(chain.broadcasts.length).toBe(1);
  });

  it('a KIND 87058 decision against the card or the owner it had at the quote: refused', async () => {
    const { plan } = await refusedAfterSending();
    exclude(CUSTOMER_HEX);
    expect((await resend(plan.attempt_id)).status).toBe(403);
    db.prepare('DELETE FROM person_exclusions').run();
    exclude(hexOfKey(CARD));
    expect((await resend(plan.attempt_id)).status).toBe(403);
    expect(chain.broadcasts.length).toBe(1);
  });

  it('only within 30 minutes of the card\'s signature; later the seller pays again with the same card', async () => {
    const { plan } = await refusedAfterSending();
    nowMs += (RESEND_WINDOW_SECONDS + 1) * 1000;
    const late = await resend(plan.attempt_id);
    expect(late.status).toBe(409);
    expect(late.data.code).toBe('RESEND_TOO_LATE');
    expect(chain.broadcasts.length).toBe(1);
    // Paying again (the card scanned again, every check afresh, one of the same coins) still can.
    const again = await quote({ sale_id: plan.sale_id });
    expect(again.status, JSON.stringify(again.data)).toBe(200);
    expect(again.data.replaces).toEqual([plan.attempt_id]);
  });

  it('as at a submit: a spend of the card waiting for a block, a block arriving mid-read, a coin gone', async () => {
    const { plan } = await refusedAfterSending();
    addr(CARD_ADDRESS).pending = -1_000n;
    expect((await resend(plan.attempt_id)).data.code).toBe('CHAIN_PENDING');
    addr(CARD_ADDRESS).pending = 0n;
    chain.tipMoves = true;
    expect((await resend(plan.attempt_id)).data.code).toBe('WALLET_STATE_CHANGED');
    chain.tipMoves = false;
    const a = addr(CARD_ADDRESS);
    const coin = a.utxos.find(u => u.txid === plan.inputs[0].txid)!;
    a.utxos = a.utxos.filter(u => u !== coin);
    a.confirmed -= BigInt(coin.value);
    expect((await resend(plan.attempt_id)).data.code).toBe('WALLET_STATE_CHANGED');
    expect(chain.broadcasts.length).toBe(1);
    expect(row(plan.attempt_id)).toMatchObject({ status: 'refused', sent: 1 });
  });

  it('with everything as it was, the same bytes go out again: sent', async () => {
    const { plan, s } = await refusedAfterSending();
    const r = await resend(plan.attempt_id);
    expect(r.data).toMatchObject({ success: true, resend: 'accepted', status: 'sent' });
    expect(chain.broadcasts).toEqual([s.raw, s.raw]);
  });
});

describe('a replacement refused before it was sent replaces nothing (review: the hanging payment stayed "superseded")', () => {
  it('RATE_CHANGED at its submit: the hanging payment is unknown again, holds the card, may be sent again, and the till is pointed to it', async () => {
    const hanging = await hangingPayment();
    const replacement = await quote({ sale_id: hanging.plan.sale_id });
    expect(replacement.data.replaces).toEqual([hanging.plan.attempt_id]);
    db.prepare('DELETE FROM kind_38888').run();
    store38888('0.3');
    const r = await submit(replacement.data.plan, sign(replacement.data.plan));
    expect(r.status).toBe(409);
    expect(r.data).toMatchObject({ code: 'RATE_CHANGED', status: 'refused', sent: false, pending_attempt_id: hanging.plan.attempt_id });
    expect(row(hanging.plan.attempt_id)).toMatchObject({ status: 'unknown', sent: 1, reason: 'NO_CLEAR_ANSWER', superseded_from: null });
    expect(row(replacement.data.attempt_id)).toMatchObject({ status: 'refused', sent: 0, reason: 'RATE_CHANGED' });
    expect((await quote({ amount: '3.00' })).data.code).toBe('CARD_PAYMENT_PENDING');
    db.prepare('DELETE FROM kind_38888').run();
    store38888('0.256');
    expect((await resend(hanging.plan.attempt_id)).data).toMatchObject({ resend: 'accepted', status: 'sent' });
    expect(chain.broadcasts).toEqual([hanging.s.raw, hanging.s.raw]);
  });

  it('a payment every server refused after sending is put back as refused, sent = 1, with its reason', async () => {
    const refused = await refusedAfterSending();
    const replacement = await quote({ sale_id: refused.plan.sale_id });
    registrar.set(SHOP_WALLET, 'down');
    const r = await submit(replacement.data.plan, sign(replacement.data.plan));
    expect(r.data).toMatchObject({ code: 'REGISTRAR_UNAVAILABLE', status: 'refused', sent: false, pending_attempt_id: refused.plan.attempt_id });
    expect(row(refused.plan.attempt_id)).toMatchObject({ status: 'refused', sent: 1, reason: 'BROADCAST_REFUSED' });
  });

  it('a replacement cut off by a crash while it was checked: the sweep refuses it and puts back what it replaced', async () => {
    const hanging = await hangingPayment();
    const replacement = await quote({ sale_id: hanging.plan.sale_id });
    const s = sign(replacement.data.plan);
    const began = beginValidating(db, row(replacement.data.attempt_id), { txid: s.txid, raw: s.raw, record: s.record, record_id: s.record.id }, Math.floor(nowMs / 1000));
    expect(began.ok).toBe(true);
    expect(row(hanging.plan.attempt_id).status).toBe('superseded');
    nowMs += 301_000;
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(row(replacement.data.attempt_id)).toMatchObject({ status: 'refused', sent: 0, reason: 'INTERRUPTED_BEFORE_SENDING' });
    expect(row(hanging.plan.attempt_id)).toMatchObject({ status: 'unknown', sent: 1, reason: 'NO_CLEAR_ANSWER' });
    expect(chain.broadcasts.length).toBe(1);
  });

  it('one the chain has meanwhile put in a block stays paid', async () => {
    const hanging = await hangingPayment();
    const replacement = await quote({ sale_id: hanging.plan.sale_id });
    const s = sign(replacement.data.plan);
    beginValidating(db, row(replacement.data.attempt_id), { txid: s.txid, raw: s.raw, record: s.record, record_id: s.record.id }, Math.floor(nowMs / 1000));
    mine(hanging.s.raw, 301);
    chain.height = 301;
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(row(hanging.plan.attempt_id).status).toBe('paid');
    expect(refuseBeforeSending(db, replacement.data.attempt_id, 'RATE_CHANGED', Math.floor(nowMs / 1000))).toEqual({ refused: true, restored: [] });
    expect(row(hanging.plan.attempt_id).status).toBe('paid');
  });
});

describe('an answer about an attempt is the whole attempt; a quote past its time is final (review)', () => {
  it('a quote that ran out at its submit: the whole attempt, expired, nothing sent', async () => {
    const q = await quote();
    nowMs += 121_000;
    const r = await submit(q.data.plan, sign(q.data.plan));
    expect(r.status).toBe(409);
    expect(r.data).toMatchObject({
      code: 'QUOTE_EXPIRED', attempt_id: q.data.attempt_id, status: 'expired', sent: false,
      currency: 'EUR', invoice_cents: '1000', margin_percent: 10, pay_cents: '1100', amount_lanoshi: '4296875000',
    });
    expect(typeof r.data.fee_lanoshi).toBe('string');
    expect(chain.broadcasts).toEqual([]);
  });

  it('a quote asked about after its time is expired at once: the till learns that nothing was sent', async () => {
    const q = await quote();
    const s = sign(q.data.plan);
    expect((await get(`/api/direct-lana/sales/${q.data.attempt_id}`)).data.status).toBe('quoted');
    nowMs += 121_000;
    const asked = await get(`/api/direct-lana/sales/${q.data.attempt_id}`);
    expect(asked.data).toMatchObject({ status: 'expired', reason: 'QUOTE_EXPIRED', sent: false });
    expect(row(q.data.attempt_id).status).toBe('expired');
    // A submit arriving later is refused.
    expect((await submit(q.data.plan, s)).status).toBe(409);
    expect(chain.broadcasts).toEqual([]);
  });
});

describe('only exactly a unit without a company takes LANA directly (review: one "none" among other tags opened the path)', () => {
  const cases: Array<[string, string[][]]> = [
    ['two payout_account tags, "bank" and "none"', [['payout_account', 'bank'], ...OPTION_C]],
    ['a company unit that also signs payout_account none', [...OPTION_C.filter(t => t[0] !== 'lanapays_payout_method'),
      ['receiver_type', 'company'], ['receiver_name', 'Podjetje d.o.o.'], ['payment_scheme', 'iban'],
      ['payment_scheme_fields', '{"iban":"SI56191000000123438"}'], ['lanapays_payout_method', 'fiat'], ['online_shop', 'true']]],
    ['its reward method fiat', [...OPTION_C.filter(t => t[0] !== 'lanapays_payout_method'), ['lanapays_payout_method', 'fiat']]],
    ['no reward method at all', OPTION_C.filter(t => t[0] !== 'lanapays_payout_method')],
    ['a bank account beside it', [...OPTION_C, ['bank_account', 'SI56191000000123438']]],
    ['a receiver named beside it', [...OPTION_C, ['receiver_name', 'Janez Novak s.p.']]],
    ['an online shop', [...OPTION_C, ['online_shop', 'true']]],
  ];
  for (const [label, tags] of cases) {
    it(`${label}: UNIT_NOT_DIRECT, nothing asked of the register or the chain`, async () => {
      setUnitEvent(tags);
      expect((await get(`/api/direct-lana/price?unit_id=${UNIT}&amount=10.00`)).data.code).toBe('UNIT_NOT_DIRECT');
      const q = await quote();
      expect(q.status).toBe(409);
      expect(q.data.code).toBe('UNIT_NOT_DIRECT');
      expect(registrarAsked).toEqual([]);
      expect(chain.reads).toBe(0);
      expect(directLanaView(db, unitRow(db, UNIT), { pubkey: hexOfKey(PARAMS) })).toEqual({ enabled: false, reason: 'UNIT_NOT_DIRECT' });
    });
  }

  it('the shop\'s own form, with the place of sale and online_shop "false": takes LANA directly', async () => {
    setUnitEvent([...OPTION_C, ['receiver_address', 'Glavna 1'], ['receiver_zip', '1000'], ['receiver_city', 'Ljubljana'],
      ['receiver_country', 'SI'], ['online_shop', 'false'], ['online_shop_shipping_fee', '0.00'], ['online_shop_pickup', 'false']]);
    expect((await quote()).status).toBe(200);
  });
});

describe('KIND 87058 at the quote and between the quote and the submit (review: nothing pinned these)', () => {
  it('at the quote: the owner (the shop stops) and the staff member selling; nothing kept', async () => {
    exclude(OWNER_HEX);
    const owner = await quote();
    expect(owner.status).toBe(403);
    expect(owner.data.code).toBe('MERCHANT_UNAVAILABLE');
    db.prepare('DELETE FROM person_exclusions').run();
    exclude(hexOfKey(STAFF));
    const staff = await asStaff();
    expect(staff.status).toBe(403);
    expect(staff.data.code).toBe('PERSON_EXCLUDED');
    expect(journalSize()).toBe(0);
    expect(chain.broadcasts).toEqual([]);
  });

  const between: Array<[string, () => string, string, string]> = [
    ['the owner', () => OWNER_HEX, 'MERCHANT_UNAVAILABLE', 'quoted'],
    ['the card', () => hexOfKey(CARD), 'PERSON_EXCLUDED', 'quoted'],
    ['the card\'s registrar owner', () => CUSTOMER_HEX, 'PERSON_EXCLUDED', 'refused'],
  ];
  for (const [label, who, code, kept] of between) {
    it(`decided against ${label} between the quote and the submit: 403, nothing sent`, async () => {
      const q = await quote();
      exclude(who());
      const r = await submit(q.data.plan, sign(q.data.plan));
      expect(r.status).toBe(403);
      expect(r.data.code).toBe(code);
      expect(chain.broadcasts).toEqual([]);
      expect(row(q.data.attempt_id)).toMatchObject({ status: kept, sent: 0 });
    });
  }

  it('decided against the staff member selling between the quote and the submit: 403, nothing sent', async () => {
    const q = await asStaff();
    expect(q.status, JSON.stringify(q.data)).toBe(200);
    exclude(hexOfKey(STAFF));
    const s = sign(q.data.plan);
    const r = await post('/api/direct-lana/submit', { attempt_id: q.data.attempt_id, raw: s.raw, record: s.record }, STAFF);
    expect(r.status).toBe(403);
    expect(r.data.code).toBe('PERSON_EXCLUDED');
    expect(chain.broadcasts).toEqual([]);
  });
});

describe('the shop and the card between the quote and the submit (review: nothing pinned these)', () => {
  const cases: Array<[string, () => void, string]> = [
    ['the shop re-signed as a company unit', () => setUnitEvent([['receiver_type', 'company'], ['lanapays_payout_wallet', SHOP_WALLET]]), 'UNIT_NOT_DIRECT'],
    ['the shop suspended', () => db.prepare("UPDATE business_units SET suspension_status = 'suspended' WHERE unit_id = ?").run(UNIT), 'UNIT_BLOCKED'],
    ['the shop\'s margin made unreadable', () => setUnitEvent([...OPTION_C.filter(t => t[0] !== 'margin_percent'), ['margin_percent', '25']]), 'MARGIN_INVALID'],
  ];
  for (const [label, change, code] of cases) {
    it(`${label}: refused with ${code}, sent = 0, nothing sent`, async () => {
      const q = await quote();
      change();
      const r = await submit(q.data.plan, sign(q.data.plan));
      expect(r.data).toMatchObject({ code, status: 'refused', sent: false });
      expect(chain.broadcasts).toEqual([]);
    });
  }

  it('the register now names the shop\'s owner as the card\'s owner: SELF_PAYMENT, nothing sent', async () => {
    const q = await quote();
    registrar.set(CARD_ADDRESS, wallet('Main Wallet', OWNER_HEX));
    const r = await submit(q.data.plan, sign(q.data.plan));
    expect(r.data).toMatchObject({ code: 'SELF_PAYMENT', status: 'refused', sent: false });
    expect(chain.broadcasts).toEqual([]);
  });

  it('a card whose key is the owner\'s (another address, the register naming someone else): SELF_PAYMENT at the quote', async () => {
    const ownerCard = wifOf(OWNER, false);
    const address = addressOfKey(OWNER, false);
    expect(address).not.toBe(SHOP_WALLET);
    fund(address, [10_000_000_000n]);
    registrar.set(address, wallet('Wallet', CUSTOMER_HEX));
    const q = await post('/api/direct-lana/quote', { unit_id: UNIT, amount: '10.00', currency: 'EUR', public_key: readCardKey(ownerCard).publicKey });
    expect(q.data.code).toBe('SELF_PAYMENT');
    expect(chain.reads).toBe(0);
    expect(journalSize()).toBe(0);
  });

  it('a spend of the card waiting for a block, at the quote: CHAIN_PENDING, nothing kept', async () => {
    addr(CARD_ADDRESS).pending = -1_000n;
    expect((await quote()).data.code).toBe('CHAIN_PENDING');
    expect(journalSize()).toBe(0);
  });

  it('a spend of the card waiting for a block, between the quote and the submit: CHAIN_PENDING, nothing sent', async () => {
    const q = await quote();
    addr(CARD_ADDRESS).pending = -1_000n;
    const r = await submit(q.data.plan, sign(q.data.plan));
    expect(r.data).toMatchObject({ code: 'CHAIN_PENDING', status: 'refused', sent: false });
    expect(chain.broadcasts).toEqual([]);
  });

  it('a block arriving between the submit\'s last read and its broadcast: WALLET_STATE_CHANGED, nothing sent', async () => {
    const q = await quote();
    chain.tipMoves = true;
    const r = await submit(q.data.plan, sign(q.data.plan));
    expect(r.data).toMatchObject({ code: 'WALLET_STATE_CHANGED', status: 'refused', sent: false });
    expect(chain.broadcasts).toEqual([]);
  });
});

describe('a crash in the middle of a submit is put right by the sweep, never by guessing (review: nothing pinned this)', () => {
  async function stuck(status: 'validating' | 'broadcasting') {
    const q = await quote();
    const s = sign(q.data.plan);
    const now = Math.floor(nowMs / 1000);
    expect(beginValidating(db, row(q.data.attempt_id), { txid: s.txid, raw: s.raw, record: s.record, record_id: s.record.id }, now).ok).toBe(true);
    if (status === 'broadcasting') expect(move(db, q.data.attempt_id, ['validating'], 'broadcasting', now, { sent: 1 })).toBe(true);
    return q.data.attempt_id as string;
  }

  it('left "broadcasting" over 300 s: unknown, sent = 1, and the card still held (the bytes may have reached a server)', async () => {
    const id = await stuck('broadcasting');
    nowMs += 299_000;
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(row(id).status).toBe('broadcasting');
    nowMs += 2_000;
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(row(id)).toMatchObject({ status: 'unknown', sent: 1, reason: 'INTERRUPTED_WHILE_SENDING' });
    expect((await quote({ amount: '3.00' })).data.code).toBe('CARD_PAYMENT_PENDING');
  });

  it('left "validating" over 300 s: refused, sent = 0, and the card free again (nothing reached a server)', async () => {
    const id = await stuck('validating');
    nowMs += 301_000;
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(row(id)).toMatchObject({ status: 'refused', sent: 0, reason: 'INTERRUPTED_BEFORE_SENDING' });
    expect((await quote({ amount: '3.00' })).status).toBe(200);
  });

  it('a "sent" payment both servers dropped, with a coin spent by another payment not yet 6 deep: still sent, however long', async () => {
    const { plan, s } = await paySent();
    expect(row(plan.attempt_id).status).toBe('sent');
    // Both servers dropped it: its coin is unspent again for them, it waits for nothing.
    chain.mempool.delete(s.txid);
    const a = addr(CARD_ADDRESS);
    a.history = a.history.filter(h => h.txid !== s.txid);
    a.utxos.push(...plan.inputs.map(i => ({ txid: i.txid, vout: i.vout, value: i.value, height: i.height })));
    a.pending = 0n;
    // The customer spent the same coin elsewhere, in block 301; the tip is 302 (2 deep).
    const other = signDirectSale(readCardKey(wifOf(CARD)), { ...plan, recipient: CARD2_ADDRESS, attempt_id: `dla_${'7'.repeat(32)}` });
    mine(other.raw, 301);
    chain.height = 302;
    nowMs += 3_600_000;
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    expect(row(plan.attempt_id).status).toBe('sent');
  });
});

describe('the receipt photo (Brilly, 26 Nov 2026: the same procedure as LANA, the money to the shop\'s wallet)', () => {
  const R = { receipt_url: 'https://files.example/r-1.jpg', receipt_hash: 'cd'.repeat(32) };

  it('kept with the sale and shown to the seller; never in the signed plan nor the public record', async () => {
    const { plan, s, r } = await paySent(R);
    expect(r.data.status).toBe('sent');
    expect(row(plan.attempt_id)).toMatchObject({ receipt_url: R.receipt_url, receipt_hash: R.receipt_hash });
    const seen = await get(`/api/direct-lana/sales/${plan.attempt_id}`);
    expect(seen.data.receipt_url).toBe(R.receipt_url);
    expect(JSON.stringify(seen.data)).not.toContain(R.receipt_hash);
    for (const text of [JSON.stringify(plan), JSON.stringify(s.record)]) {
      expect(text).not.toContain('r-1.jpg');
      expect(text).not.toContain(R.receipt_hash);
    }
  });

  it('"No receipt" is a sale as before', async () => {
    const { plan, r } = await paySent();
    expect(r.data.status).toBe('sent');
    expect(row(plan.attempt_id)).toMatchObject({ receipt_url: null, receipt_hash: null });
  });

  it('the same photo is never paid twice in the shop: refused at the quote; another photo goes on', async () => {
    await paySent(R);
    const again = await quote({ ...R, invoice_number: 'other' }, CARD2);
    expect(again.status).toBe(409);
    expect(again.data.code).toBe('RECEIPT_USED');
    expect((await quote({ receipt_url: 'https://files.example/r-2.jpg', receipt_hash: 'ef'.repeat(32) }, CARD2)).status).toBe(200);
  });

  it('— and at the submit, when another sale with it went out between the quote and the submit: nothing sent', async () => {
    const first = await quote(R);
    const second = await quote(R, CARD2);
    expect(second.status).toBe(200);
    expect((await submit(first.data.plan, sign(first.data.plan))).data.status).toBe('sent');
    const r = await submit(second.data.plan, sign(second.data.plan, CARD2));
    // As INVOICE_USED at the submit: refused before anything is kept or sent.
    expect(r.status).toBe(409);
    expect(r.data.code).toBe('RECEIPT_USED');
    expect(row(second.data.attempt_id).status).toBe('quoted');
    expect(chain.broadcasts.length).toBe(1);
  });

  it('a sale started before keeps its own photo, whatever a later quote of it says', async () => {
    const first = await quote(R);
    expect(first.status).toBe(200);
    const again = await quote({ sale_id: first.data.sale_id, receipt_url: 'https://files.example/other.jpg', receipt_hash: '12'.repeat(32) });
    expect(again.status, JSON.stringify(again.data)).toBe(200);
    expect(row(again.data.attempt_id)).toMatchObject({ receipt_url: R.receipt_url, receipt_hash: R.receipt_hash });
  });

  it('a receipt that does not read is refused before anything is asked', async () => {
    const bad: Array<Record<string, unknown>> = [
      { receipt_hash: 'cd'.repeat(32) },
      { receipt_url: 'javascript:alert(1)' },
      { receipt_url: 'https://files.example/a b.jpg' },
      { receipt_url: R.receipt_url, receipt_hash: 'not-a-hash' },
      { receipt_url: `https://files.example/${'a'.repeat(600)}` },
      { receipt_url: 42 },
    ];
    for (const b of bad) {
      const r = await quote(b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.data.code).toBe('RECEIPT_INVALID');
    }
    expect(registrarAsked).toEqual([]);
  });

  it('the till\'s early warning (check-dedup) sees a direct sale of the photo or of the number; a quote nobody signed holds nothing', async () => {
    const { plan } = await paySent({ ...R, invoice_number: 'R-9' });
    const byPhoto = directDedupHit(db, UNIT, { receiptHash: R.receipt_hash });
    expect(byPhoto).toMatchObject({ duplicate: true, by: 'receipt_image' });
    expect(byPhoto!.original_created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(directDedupHit(db, UNIT, { invoiceNumber: ' R-9 ' })).toMatchObject({ duplicate: true, by: 'invoice' });
    expect(directDedupHit(db, UNIT, { receiptHash: 'ef'.repeat(32), invoiceNumber: 'R-10' })).toBe(null);
    expect(directDedupHit(db, COMPANY, { receiptHash: R.receipt_hash })).toBe(null);
    db.prepare("UPDATE direct_lana_sales SET status = 'quoted' WHERE id = ?").run(plan.attempt_id);
    expect(directDedupHit(db, UNIT, { receiptHash: R.receipt_hash })).toBe(null);
  });
});

describe('what was sold (Brilly, 26 Nov 2026: a shop without a company has no invoice, so no invoice number)', () => {
  it('kept with the sale and shown to the seller; never in the signed plan nor the public record', async () => {
    const { plan, s, r } = await paySent({ what_sold: 'Jajca, 10 kosov' });
    expect(r.data.status).toBe('sent');
    expect(row(plan.attempt_id)).toMatchObject({ what_sold: 'Jajca, 10 kosov', invoice_number: '' });
    const seen = await get(`/api/direct-lana/sales/${plan.attempt_id}`);
    expect(seen.data.what_sold).toBe('Jajca, 10 kosov');
    expect(JSON.stringify(plan)).not.toContain('Jajca');
    expect(JSON.stringify(s.record)).not.toContain('Jajca');
  });

  it('cleaned as a note: one line, at most 200 characters; anything but text is nothing', async () => {
    const a = await quote({ what_sold: '  Jajca\n\tin mleko\u202e  ' });
    expect(row(a.data.attempt_id).what_sold).toBe('Jajca in mleko');
    const b = await quote({ what_sold: 'x'.repeat(300) }, CARD2);
    expect(Array.from(row(b.data.attempt_id).what_sold!).length).toBe(200);
    const c = await quote({ what_sold: { evil: true } });
    expect(c.status).toBe(200);
    expect(row(c.data.attempt_id).what_sold).toBeNull();
  });

  it('a sale started before keeps what it was started with', async () => {
    const first = await quote({ what_sold: 'Jajca' });
    const again = await quote({ sale_id: first.data.sale_id, what_sold: 'Something else' });
    expect(again.status, JSON.stringify(again.data)).toBe(200);
    expect(row(again.data.attempt_id).what_sold).toBe('Jajca');
  });
});
