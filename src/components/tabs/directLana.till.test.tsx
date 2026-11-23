/**
 * LANA neposredno at the till, end to end (SPEC §4, phase 2): the real tab
 * (DirectLanaTab), the real new signer (src/lib/directLanaSign.ts) and the real
 * server routes (server/directLana.ts), running in this process on an
 * in-memory database. Only the camera, the chain (as if two agreeing Electrum
 * servers), the registrar and the relays are fakes. So every byte the till
 * sends is judged by the server's own code: the seller's NIP-98 signature, the
 * plan, the signed payment and the signed KIND 9350 record.
 *
 * Every screen: entry, the breakdown in Brilly's Slovenian words, confirm, sent,
 * paid, unknown ("do not take a second payment"), refused before anything was
 * sent, the list; a cancel and a quote that runs out; a lost answer; paying
 * again after an unknown payment (the same coins). Throughout:
 *   - the card's WIF never leaves the tab, in no URL, header or body;
 *   - its key bytes are zero after signing, on cancel, on a refusal and when
 *     the quote runs out;
 *   - the till never signs a second payment by itself: after a lost answer it
 *     asks about the payment it sent;
 *   - the till asks nothing but /api/direct-lana/*: not the brain, not the
 *     registration or the broadcast routes.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // This runner has no working Storage, and i18n reads `lang` from it at import.
  if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') return;
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => { map.set(k, String(v)); },
      removeItem: (k: string) => { map.delete(k); },
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() { return map.size; },
    },
  });
});

import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'net';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import i18n from '@/i18n';
import { bytesToHex } from '@/lib/directLanaCore';
import { shortAddress } from '@/lib/directLanaFormat';
import type { CardKey } from '@/lib/directLanaSign';
import { initializeSchema } from '../../../server/db/schema';
import { ensureExclusionTables } from '../../../server/lib/personExclusion';
import { keepRawBody, forgetSpentTokens } from '../../../server/lib/nip98';
import { registerDirectLanaRoutes, runDirectLanaWorker, type DirectLanaDeps } from '../../../server/directLana';
import { RegistrarUnavailable, type RegistrarAnswer } from '../../../server/lib/directLanaRegistrar';
import { parseLanaTx } from '../../../server/lib/directLanaTx';
import { FakeChain } from '../../../server/fixtures/directLanaChain';
import { keyOf, wifOf, addressOfKey, hexOfKey } from '../../../server/fixtures/directLana';

declare global {
  var __scanValue: string;
  var __session: any;
  var __cards: CardKey[];
}

vi.mock('@/components/QRScanner', () => ({
  QRScanner: ({ isOpen, onScan, onClose }: any) =>
    isOpen ? <button onClick={() => { onScan(globalThis.__scanValue); onClose(); }}>SCAN-NOW</button> : null,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: globalThis.__session }) }));
// The real card reader, watched: every key it hands out is kept here, so the
// test can see its bytes zeroed. Signing and everything else stay real.
vi.mock('@/lib/directLanaSign', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/directLanaSign')>();
  return {
    ...real,
    readCardKey: (input: string) => {
      const card = real.readCardKey(input);
      globalThis.__cards.push(card);
      return card;
    },
  };
});

import DirectLanaTab from './DirectLanaTab';

// ── people, wallets, the shop ───────────────────────────────────────────────
const OWNER = keyOf(7);
const OWNER_HEX = hexOfKey(OWNER);
const SHOP_WALLET = addressOfKey(OWNER);
const PARAMS = keyOf(5);
const CUSTOMER_HEX = hexOfKey(keyOf(11));
/** A random card key for this file, so its hex cannot turn up anywhere by chance. */
const CARD = generateSecretKey();
const CARD_WIF = wifOf(CARD);
const CARD_ADDRESS = addressOfKey(CARD);
const UNIT = 'nocompany-unit-1';
const UNIT_VIEW = { unit_id: UNIT, name: 'Kmetija Novak', currency: 'EUR', owner_hex: OWNER_HEX, lanapays_payout_wallet: SHOP_WALLET };

// ── the server, in this process ─────────────────────────────────────────────
let db: Database.Database;
let server: any;
let base = '';
let realFetch: typeof fetch;
const chain = new FakeChain();
const registrar = new Map<string, RegistrarAnswer | 'down'>();
const published: string[] = [];
const quiet = { log: console.log, warn: console.warn, error: console.error };

const deps: Partial<DirectLanaDeps> = {
  withChain: chain.withChain,
  registrar: async (w) => {
    const a = registrar.get(w);
    if (a === 'down') throw new RegistrarUnavailable('down');
    return a ?? { registered: false };
  },
  publish: async (event, relays) => {
    published.push(event.id);
    return relays;
  },
  nowMs: () => Date.now(),
  paramsPubkey: hexOfKey(PARAMS),
  limitPerMinute: 10_000,
};

const wallet = (type: string, owner: string | null, frozen = false): RegistrarAnswer =>
  ({ registered: true, wallet_type: type, frozen, freeze_reason: frozen ? 'frozen_max_cap' : null, owner });

function store38888(rate = '0.256') {
  db.prepare('DELETE FROM kind_38888').run();
  const ev = finalizeEvent({
    kind: 38888,
    created_at: Math.floor(Date.now() / 1000) - 60,
    tags: [
      ['d', 'main'], ['fx', 'EUR', rate],
      ['electrum', 'e1.example', '5097'], ['electrum', 'e2.example', '5097'],
      ['relay', 'wss://r1.example'], ['relay', 'wss://r2.example'], ['relay', 'wss://r3.example'],
    ],
    content: '',
  }, PARAMS);
  db.prepare('INSERT INTO kind_38888 (event_id, raw_event, relays, electrum_servers, exchange_rates) VALUES (?, ?, ?, ?, ?)')
    .run(ev.id, JSON.stringify(ev), '[]', '[]', '{}');
}

function seedUnit() {
  const raw = JSON.stringify({
    kind: 30901, pubkey: OWNER_HEX, content: '',
    tags: [['d', UNIT], ['name', 'Kmetija Novak'], ['payout_account', 'none'], ['margin_percent', '10'],
      ['lanapays_payout_method', 'lana'], ['lanapays_payout_wallet', SHOP_WALLET]],
  });
  db.prepare(`
    INSERT OR REPLACE INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event, unit_type, lana_only, suspension_status)
    VALUES (?, ?, ?, 1, 'Kmetija Novak', ?, ?, 'EUR', 'active', ?, NULL, 0, 'active')
  `).run(UNIT, 'e'.repeat(64), OWNER_HEX, OWNER_HEX, JSON.stringify([OWNER_HEX]), raw);
}

// ── what the till sent ──────────────────────────────────────────────────────
type Sent = { url: string; method: string; headers: string; body: string };
let requests: Sent[] = [];
/** The next submit reaches the server, but its answer never reaches the till. */
let loseNextSubmitAnswer = false;
/** The next submit never reaches the server at all (a proxy 502, a dropped connection). */
let dropNextSubmit = false;
const submits = () => requests.filter(r => r.url === '/api/direct-lana/submit');
const zeroed = (c: CardKey) => c.key.every(b => b === 0);
const flat = (s: string | null | undefined) => String(s ?? '').replace(/[  ]/g, ' ');

beforeAll(async () => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  realFetch = globalThis.fetch;
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

beforeEach(async () => {
  await i18n.changeLanguage('sl');
  forgetSpentTokens();
  db.exec('DELETE FROM direct_lana_sales; DELETE FROM direct_lana_payees; DELETE FROM business_units;');
  seedUnit();
  store38888();
  db.prepare("UPDATE app_settings SET value = '*' WHERE key = 'direct_lana_units'").run();
  chain.reset();
  chain.fund(CARD_ADDRESS, [10_000_000_000n]);
  registrar.clear();
  registrar.set(CARD_ADDRESS, wallet('Main Wallet', CUSTOMER_HEX));
  registrar.set(SHOP_WALLET, wallet('Main Wallet', OWNER_HEX));
  published.length = 0;
  requests = [];
  loseNextSubmitAnswer = false;
  dropNextSubmit = false;
  globalThis.__cards = [];
  globalThis.__scanValue = CARD_WIF;
  globalThis.__session = { nostrHexId: OWNER_HEX, privateKeyHex: bytesToHex(OWNER), currency: 'EUR' };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
    requests.push({
      url: String(url).split('?')[0],
      method: init.method || 'GET',
      headers: JSON.stringify(init.headers || {}),
      body: typeof init.body === 'string' ? init.body : '',
    });
    // Anything but LANA neposredno is not this tab's business: no answer for it.
    if (!String(url).startsWith('/api/direct-lana/')) return new Response('{}', { status: 404 });
    if (dropNextSubmit && url === '/api/direct-lana/submit') {
      dropNextSubmit = false;
      throw new TypeError('Failed to fetch');
    }
    const res = await realFetch(base + url, init);
    if (loseNextSubmitAnswer && url === '/api/direct-lana/submit') {
      loseNextSubmitAnswer = false;
      await res.text();
      throw new TypeError('Failed to fetch');
    }
    return res;
  }) as any);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Whatever the test did: the card's WIF and key never left the tab, and the
  // till asked nothing but LANA neposredno.
  const keyHex = bytesToHex(CARD);
  for (const r of requests) {
    for (const part of [r.url, r.headers, r.body]) {
      expect(part).not.toContain(CARD_WIF);
      expect(part).not.toContain(keyHex);
    }
    expect(r.url.startsWith('/api/direct-lana/'), r.url).toBe(true);
  }
});

// ── the steps a seller takes ────────────────────────────────────────────────
function open(pollMs = 40) {
  return render(<DirectLanaTab unit={UNIT_VIEW} pollMs={pollMs} />);
}

async function enterAmount(amount = '10,00', invoice = '') {
  fireEvent.change(screen.getByTestId('direct-amount'), { target: { value: amount } });
  if (invoice) fireEvent.change(screen.getByTestId('direct-invoice'), { target: { value: invoice } });
  fireEvent.click(screen.getByTestId('direct-continue'));
  return screen.findByTestId('direct-breakdown');
}

async function scanCard() {
  fireEvent.click(screen.getByTestId('direct-scan'));
  fireEvent.click(await screen.findByText('SCAN-NOW'));
}

async function toConfirm(amount = '10,00', invoice = '', pollMs = 40) {
  open(pollMs);
  await enterAmount(amount, invoice);
  await scanCard();
  return screen.findByTestId('direct-confirm-text');
}

async function confirmPayment() {
  fireEvent.click(screen.getByTestId('direct-confirm'));
}

/** The payment the server keeps for this card, newest first. */
const rows = () => db.prepare('SELECT * FROM direct_lana_sales WHERE status <> \'quoted\' ORDER BY created_at DESC, rowid DESC').all() as any[];

describe('the whole sale, in Brilly\'s words', () => {
  it('breakdown: Znesek računa 10,00 € · Doplačilo … (10 %) +1,00 € · Za plačilo 11,00 € = 42,96875 LANA (1 LANA = 0,256 €) · omrežnino plača kupec', async () => {
    open();
    const box = await enterAmount('10,00');
    const text = flat(box.textContent);
    for (const part of ['Znesek računa', '10,00 €', 'Doplačilo za plačilo v LANA (10 %)', '+1,00 €', 'Za plačilo', '11,00 €',
      '= 42,96875 LANA', '(1 LANA = 0,256 €)', 'omrežnino plača kupec']) {
      expect(text, part).toContain(part);
    }
    // The order, as the seller reads it.
    const at = (s: string) => text.indexOf(s);
    expect(at('Znesek računa')).toBeLessThan(at('Doplačilo'));
    expect(at('Doplačilo')).toBeLessThan(at('Za plačilo'));
    expect(at('Za plačilo')).toBeLessThan(at('42,96875'));
    // Nothing is reserved, signed or sent for a price.
    expect(requests.map(r => r.url)).toEqual(['/api/direct-lana/price']);
    expect(globalThis.__cards).toEqual([]);
  });

  it('confirm: the exact LANA, the fee, the shop and its wallet; cannot be undone', async () => {
    const confirmText = await toConfirm();
    expect(flat(confirmText.textContent)).toBe(
      `Plačaj 42,96875 LANA + omrežnina 0,0003945 LANA → Kmetija Novak (${shortAddress(SHOP_WALLET)}). Plačila ni mogoče preklicati.`,
    );
    expect(screen.getByTestId('direct-confirm')).toHaveTextContent('Potrdi plačilo');
    expect(screen.getByTestId('direct-cancel')).toHaveTextContent('Prekliči');
    // The quote named the card by its public key only.
    const quote = JSON.parse(requests.find(r => r.url === '/api/direct-lana/quote')!.body);
    expect(Object.keys(quote).sort()).toEqual(['amount', 'currency', 'public_key', 'unit_id']);
    expect(quote.amount).toBe('10.00');
    // The key is held until the customer confirms, and nothing was sent yet.
    expect(globalThis.__cards.length).toBe(1);
    expect(zeroed(globalThis.__cards[0])).toBe(false);
    expect(submits()).toEqual([]);
    expect(chain.broadcasts).toEqual([]);
  });

  it('sent ("Plačano, potrditev v bloku sledi"), then paid in a block, the record published, the key zero', async () => {
    await toConfirm();
    await confirmPayment();
    const sent = await screen.findByTestId('direct-status-sent');
    expect(sent).toHaveTextContent('Plačano, potrditev v bloku sledi');
    expect(sent).toHaveTextContent('Javni zapis bo objavljen po potrditvi');
    expect(zeroed(globalThis.__cards[0])).toBe(true);

    // What went to the network is exactly what the server kept, and it pays
    // the shop's wallet first, the change back to the same card address.
    expect(chain.broadcasts.length).toBe(1);
    const kept = rows()[0];
    expect(kept.raw_tx).toBe(chain.broadcasts[0]);
    expect(kept.status).toBe('sent');
    const tx = parseLanaTx(chain.broadcasts[0]);
    expect(tx.outputs.length).toBe(2);
    expect(tx.outputs[0].lanoshis).toBe(4_296_875_000n);
    expect(tx.nTime).toBe(kept.created_at);
    // The record the card signed is the one kept, and it is not public yet.
    const record = JSON.parse(kept.record_json);
    expect(record.pubkey).toBe(hexOfKey(CARD));
    expect(record.kind).toBe(9350);
    expect(published).toEqual([]);

    chain.mine(chain.broadcasts[0], 301);
    chain.height = 301;
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    const paid = await screen.findByTestId('direct-status-paid', {}, { timeout: 3000 });
    expect(paid).toHaveTextContent('Potrjeno v bloku');
    await waitFor(() => expect(screen.getByText('Javni zapis je objavljen')).toBeInTheDocument());
    expect(published).toEqual([record.id]);
    // One signature, one submit, one broadcast: the polling never signed again.
    expect(submits().length).toBe(1);
    expect(chain.broadcasts.length).toBe(1);
  });

  it('an invoice number, when entered, is in the sale and in the public record', async () => {
    await toConfirm('10,00', 'R-17');
    const quote = JSON.parse(requests.find(r => r.url === '/api/direct-lana/quote')!.body);
    expect(quote.invoice_number).toBe('R-17');
    await confirmPayment();
    await screen.findByTestId('direct-status-sent');
    expect(JSON.parse(JSON.parse(rows()[0].record_json).content).description).toContain('Invoice no.: R-17');
  });

  it('the list of the shop\'s direct sales', async () => {
    await toConfirm();
    await confirmPayment();
    await screen.findByTestId('direct-status-sent');
    fireEvent.click(screen.getByText('Pokaži neposredna plačila'));
    const row = await screen.findByTestId('direct-sale-row');
    expect(flat(row.textContent)).toContain('11,00 € · 42,96875 LANA');
    expect(row).toHaveTextContent('Poslano');
  });
});

describe('refused before anything is sent: in words, the key zero', () => {
  it('a frozen customer wallet: "LANA niso bile poslane: kupčeva denarnica je zamrznjena."', async () => {
    registrar.set(CARD_ADDRESS, wallet('Main Wallet', CUSTOMER_HEX, true));
    open();
    await enterAmount();
    await scanCard();
    const box = await screen.findByTestId('direct-refusal');
    expect(box).toHaveTextContent('LANA niso bile poslane: kupčeva denarnica je zamrznjena.');
    expect(zeroed(globalThis.__cards[0])).toBe(true);
    expect(submits()).toEqual([]);
    expect(chain.broadcasts).toEqual([]);
    // Still on the breakdown: the seller may scan another card.
    expect(screen.getByTestId('direct-scan')).toBeInTheDocument();
  });

  it('the register does not answer: refused, nothing kept, nothing sent', async () => {
    registrar.set(SHOP_WALLET, 'down');
    open();
    await enterAmount();
    await scanCard();
    expect(await screen.findByTestId('direct-refusal')).toHaveTextContent('registra denarnic ni bilo mogoče preveriti');
    expect(zeroed(globalThis.__cards[0])).toBe(true);
    expect(rows()).toEqual([]);
    expect(chain.broadcasts).toEqual([]);
  });

  it('the price changed between the quote and the confirm: RATE_CHANGED, nothing sent', async () => {
    await toConfirm();
    store38888('0.3');
    await confirmPayment();
    const refused = await screen.findByTestId('direct-status-refused');
    expect(refused).toHaveTextContent('LANA niso bile poslane: cena LANA se je vmes spremenila. Poskusi znova.');
    expect(rows()[0]).toMatchObject({ status: 'refused', sent: 0, reason: 'RATE_CHANGED' });
    expect(chain.broadcasts).toEqual([]);
    expect(zeroed(globalThis.__cards[0])).toBe(true);
    // Nothing went out, so a new try is a plain one.
    expect(screen.getByTestId('direct-try-again')).toBeInTheDocument();
    expect(screen.queryByTestId('direct-resend')).not.toBeInTheDocument();
  });

  it('a price that moved since the breakdown is shown before the customer confirms', async () => {
    open();
    await enterAmount();
    store38888('0.25');
    await scanCard();
    const notice = await screen.findByTestId('direct-price-changed');
    expect(flat(notice.textContent)).toContain('44 LANA');
    expect(flat(screen.getByTestId('direct-confirm-text').textContent)).toContain('Plačaj 44 LANA');
  });
});

describe('the customer or the clock says no: the key is zeroed', () => {
  it('cancel on the confirm screen: back to the breakdown, nothing submitted', async () => {
    await toConfirm();
    fireEvent.click(screen.getByTestId('direct-cancel'));
    await screen.findByTestId('direct-scan');
    expect(zeroed(globalThis.__cards[0])).toBe(true);
    expect(submits()).toEqual([]);
    expect(chain.broadcasts).toEqual([]);
  });

  it('the quote runs out on the confirm screen: the key is zeroed, the card must be scanned again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await toConfirm();
    expect(zeroed(globalThis.__cards[0])).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(121_000); });
    expect(await screen.findByTestId('direct-refusal')).toHaveTextContent('ponudba je potekla');
    expect(zeroed(globalThis.__cards[0])).toBe(true);
    expect(screen.queryByTestId('direct-confirm')).not.toBeInTheDocument();
    expect(submits()).toEqual([]);
  });
});

describe('after sending, only the chain decides; the till never signs again by itself', () => {
  it('no clear answer: "Plačilo se preverja … Ne vzemi drugega plačila."; the seller re-sends the SAME bytes', async () => {
    chain.mode = 'odd';
    await toConfirm();
    await confirmPayment();
    const unknown = await screen.findByTestId('direct-status-unknown');
    expect(unknown).toHaveTextContent('Plačilo se preverja (običajno nekaj minut). Ne vzemi drugega plačila.');
    // Asking about it, as long as it takes, changes nothing.
    await new Promise(r => setTimeout(r, 200));
    expect(screen.getByTestId('direct-status-unknown')).toBeInTheDocument();
    expect(requests.filter(r => r.url.startsWith('/api/direct-lana/sales/')).length).toBeGreaterThan(0);

    chain.mode = 'accept';
    fireEvent.click(screen.getByTestId('direct-resend'));
    await screen.findByTestId('direct-status-sent');
    expect(chain.broadcasts.length).toBe(2);
    expect(chain.broadcasts[1]).toBe(chain.broadcasts[0]);
    expect(submits().length).toBe(1);
  });

  it('a re-send every server refuses again says so', async () => {
    chain.mode = 'odd';
    await toConfirm();
    await confirmPayment();
    await screen.findByTestId('direct-status-unknown');
    chain.mode = 'refuse';
    fireEvent.click(screen.getByTestId('direct-resend'));
    // Said as what it is: the same bytes refused again, the payment itself still being checked.
    const box = await screen.findByTestId('direct-refusal');
    expect(box).toHaveTextContent('Omrežje je isto plačilo znova zavrnilo. Dokler se ne razjasni, ne vzemi drugega plačila.');
    expect(box).not.toHaveTextContent('niso bile poslane');
    expect(screen.getByTestId('direct-status-unknown')).toBeInTheDocument();
  });

  it('the answer to the submit is lost: the till shows "being checked", asks, and shows what happened', async () => {
    loseNextSubmitAnswer = true;
    // Asked every 400 ms here, so the "being checked" screen is there long enough to be seen.
    await toConfirm('10,00', '', 400);
    await confirmPayment();
    // The server did send it; the till only knows it may have gone out ...
    expect(await screen.findByTestId('direct-status-quoted')).toHaveTextContent('Plačilo se preverja (običajno nekaj minut). Ne vzemi drugega plačila.');
    // ... and finds out by asking, never by signing again.
    await screen.findByTestId('direct-status-sent', {}, { timeout: 3000 });
    expect(submits().length).toBe(1);
    expect(chain.broadcasts.length).toBe(1);
  });

  it('paying again after an unknown payment spends one of the SAME coins; the old one is superseded', async () => {
    chain.mode = 'odd';
    await toConfirm();
    await confirmPayment();
    await screen.findByTestId('direct-status-unknown');
    const first = rows()[0];

    chain.mode = 'accept';
    fireEvent.click(screen.getByTestId('direct-pay-again'));
    fireEvent.click(await screen.findByText('SCAN-NOW'));
    await screen.findByTestId('direct-confirm-text');
    await confirmPayment();
    await screen.findByTestId('direct-status-sent');

    const [second, old] = rows();
    expect(old.id).toBe(first.id);
    expect(old.status).toBe('superseded');
    expect(second.sale_id).toBe(first.sale_id);
    const coins = (r: any) => JSON.parse(r.plan_json).inputs.map((i: any) => `${i.txid}:${i.vout}`);
    expect(coins(second).some((c: string) => coins(first).includes(c))).toBe(true);
    // Two signatures for two quotes, each of them asked for by the seller.
    expect(submits().length).toBe(2);
    expect(globalThis.__cards.every(zeroed)).toBe(true);
  });

  it('a superseded payment points to the payment that replaced it', async () => {
    chain.mode = 'odd';
    await toConfirm();
    await confirmPayment();
    await screen.findByTestId('direct-status-unknown');
    chain.mode = 'accept';
    fireEvent.click(screen.getByTestId('direct-pay-again'));
    fireEvent.click(await screen.findByText('SCAN-NOW'));
    await screen.findByTestId('direct-confirm-text');
    await confirmPayment();
    await screen.findByTestId('direct-status-sent');

    fireEvent.click(screen.getByText('Pokaži neposredna plačila'));
    const list = await screen.findAllByTestId('direct-sale-row');
    expect(list.length).toBe(2);
    fireEvent.click(list[1].querySelector('button')!);
    await screen.findByTestId('direct-status-superseded');
    fireEvent.click(screen.getByTestId('direct-show-replacement'));
    await screen.findByTestId('direct-status-sent');
  });
});

describe('in English too', () => {
  it('the breakdown and the confirm sentence', async () => {
    await i18n.changeLanguage('en');
    open();
    const box = await enterAmount('10.00');
    expect(flat(box.textContent)).toContain('Surcharge for paying in LANA (10 %)');
    expect(flat(box.textContent)).toContain('= 42.96875 LANA');
    await scanCard();
    const confirmText = await screen.findByTestId('direct-confirm-text');
    expect(flat(confirmText.textContent)).toBe(
      `Pay 42.96875 LANA + network fee 0.0003945 LANA → Kmetija Novak (${shortAddress(SHOP_WALLET)}). The payment cannot be undone.`,
    );
  });
});

// ── Review fixes, second round (23 Nov 2026) ────────────────────────────────

const quotedRow = () => db.prepare("SELECT * FROM direct_lana_sales WHERE status = 'quoted' ORDER BY created_at DESC LIMIT 1").get() as any;

describe('an answer the till cannot show as a payment never blanks the till (review)', () => {
  it('the quote ran out on the server at the last second: "expired", in words, the till still there', async () => {
    await toConfirm();
    // The till's own clock says the quote is still good; the server's says not.
    db.prepare('UPDATE direct_lana_sales SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 5, quotedRow().id);
    await confirmPayment();
    const expired = await screen.findByTestId('direct-status-expired');
    expect(expired).toHaveTextContent('LANA niso bile poslane: ponudba je potekla. Skeniraj kartico znova.');
    expect(screen.getByTestId('direct-try-again')).toBeInTheDocument();
    expect(chain.broadcasts).toEqual([]);
    expect(zeroed(globalThis.__cards[0])).toBe(true);
  });

  it('a submit that never reached the server: "being checked" while it still could, then for certain "not sent"', async () => {
    dropNextSubmit = true;
    await toConfirm('10,00', '', 40);
    await confirmPayment();
    const checking = await screen.findByTestId('direct-status-quoted');
    expect(checking).toHaveTextContent('Ne vzemi gotovine in ne skeniraj druge kartice.');
    // Nothing on the server to send again.
    expect(screen.queryByTestId('direct-resend')).not.toBeInTheDocument();
    // Still asked about, until the server says it can no longer be sent.
    await new Promise(r => setTimeout(r, 200));
    expect(screen.getByTestId('direct-status-quoted')).toBeInTheDocument();
    db.prepare('UPDATE direct_lana_sales SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, quotedRow().id);
    const refused = await screen.findByTestId('direct-status-expired', {}, { timeout: 3000 });
    expect(refused).toHaveTextContent('LANA niso bile poslane: plačilo ni prišlo do strežnika. Skeniraj kartico znova.');
    expect(chain.broadcasts).toEqual([]);
    expect(submits().length).toBe(1);
  });
});

describe('what the till says agrees with what it offers (review)', () => {
  it('"being checked": no cash, no other card; paying again is said not to be a second payment', async () => {
    chain.mode = 'odd';
    await toConfirm();
    await confirmPayment();
    const unknown = await screen.findByTestId('direct-status-unknown');
    expect(unknown).toHaveTextContent('Ne vzemi gotovine in ne skeniraj druge kartice.');
    expect(unknown).toHaveTextContent('To ni drugo plačilo: porabi isti denar s kartice kot prejšnje, zato se lahko izvede samo eno od obeh.');
    expect(unknown.textContent).not.toMatch(/kovanc/);
  });

  it('refused by every server AFTER it was sent: never "LANA were not sent"; it may still go through', async () => {
    chain.mode = 'refuse';
    await toConfirm();
    await confirmPayment();
    await screen.findByTestId('direct-status-refused');
    const box = screen.getByTestId('direct-refused-sent');
    expect(box).toHaveTextContent('Omrežje je plačilo zavrnilo, a je bilo poslano, zato se lahko še izvede.');
    expect(screen.getByTestId('direct-status-refused')).not.toHaveTextContent('niso bile poslane');
    expect(screen.getByTestId('direct-resend')).toBeInTheDocument();
    expect(screen.getByTestId('direct-pay-again')).toBeInTheDocument();
  });

  it('a re-send refused for a reason (the price moved): "the same payment was not sent again", not "LANA were not sent"', async () => {
    chain.mode = 'odd';
    await toConfirm();
    await confirmPayment();
    await screen.findByTestId('direct-status-unknown');
    store38888('0.3');
    fireEvent.click(screen.getByTestId('direct-resend'));
    const box = await screen.findByTestId('direct-refusal');
    expect(box).toHaveTextContent('Isto plačilo ni bilo poslano znova: cena LANA se je vmes spremenila. Poskusi znova.');
    expect(screen.getByTestId('direct-status-unknown')).toBeInTheDocument();
    expect(chain.broadcasts.length).toBe(1);
  });

  it('a shop wallet changed between the quote and the submit: "try again", not "fix the wallet"', async () => {
    await toConfirm();
    const other = addressOfKey(keyOf(13));
    registrar.set(other, wallet('Main Wallet', OWNER_HEX));
    db.prepare('UPDATE business_units SET raw_event = ? WHERE unit_id = ?').run(JSON.stringify({
      kind: 30901, pubkey: OWNER_HEX, content: '',
      tags: [['d', UNIT], ['name', 'Kmetija Novak'], ['payout_account', 'none'], ['margin_percent', '10'],
        ['lanapays_payout_method', 'lana'], ['lanapays_payout_wallet', other]],
    }), UNIT);
    await confirmPayment();
    const refused = await screen.findByTestId('direct-status-refused');
    expect(refused).toHaveTextContent('LANA niso bile poslane: denarnica trgovine se je vmes spremenila. Poskusi znova.');
    expect(refused).not.toHaveTextContent('shop.lanapays.us');
  });
});

describe('a new payment while one may still be mined is for another purchase only (review)', () => {
  it('"New payment" on "being checked" asks first, naming the payment; Back keeps it on the screen', async () => {
    chain.mode = 'odd';
    await toConfirm();
    await confirmPayment();
    await screen.findByTestId('direct-status-unknown');
    fireEvent.click(screen.getByTestId('direct-new-sale'));
    const warning = screen.getByTestId('direct-new-sale-warning');
    expect(flat(warning.textContent)).toContain('Plačilo 11,00 € · 42,96875 LANA se še preverja in se lahko še izvede.');
    expect(screen.queryByTestId('direct-amount')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('direct-new-sale-cancel'));
    expect(screen.getByTestId('direct-status-unknown')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('direct-new-sale'));
    fireEvent.click(screen.getByTestId('direct-new-sale-confirm'));
    expect(await screen.findByTestId('direct-amount')).toBeInTheDocument();
  });

  it('— after a payment that went out ("sent"), a new payment starts at once', async () => {
    await toConfirm();
    await confirmPayment();
    await screen.findByTestId('direct-status-sent');
    fireEvent.click(screen.getByTestId('direct-new-sale'));
    expect(await screen.findByTestId('direct-amount')).toBeInTheDocument();
  });

  it('back from the list returns to the payment being checked, not to a new sale', async () => {
    chain.mode = 'odd';
    await toConfirm();
    await confirmPayment();
    await screen.findByTestId('direct-status-unknown');
    fireEvent.click(screen.getByText('Pokaži neposredna plačila'));
    await screen.findByTestId('direct-sale-row');
    fireEvent.click(screen.getByTestId('direct-list-back'));
    expect(await screen.findByTestId('direct-status-unknown')).toBeInTheDocument();
  });
});

describe('a replacement refused before it left points back to the payment still being checked (review)', () => {
  it('the price moved before the replacement was sent: the earlier payment is "being checked" again, one tap away', async () => {
    chain.mode = 'odd';
    await toConfirm();
    await confirmPayment();
    await screen.findByTestId('direct-status-unknown');
    const first = rows()[0];

    chain.mode = 'accept';
    fireEvent.click(screen.getByTestId('direct-pay-again'));
    fireEvent.click(await screen.findByText('SCAN-NOW'));
    await screen.findByTestId('direct-confirm-text');
    store38888('0.3');
    await confirmPayment();
    await screen.findByTestId('direct-status-refused');
    const box = screen.getByTestId('direct-refusal');
    expect(box).toHaveTextContent('Prejšnje plačilo za ta nakup se še preverja in se lahko še izvede. Ne vzemi drugega plačila.');
    expect((db.prepare('SELECT status FROM direct_lana_sales WHERE id = ?').get(first.id) as any).status).toBe('unknown');
    fireEvent.click(screen.getByText('Pokaži to plačilo'));
    expect(await screen.findByTestId('direct-status-unknown')).toBeInTheDocument();
    expect(chain.broadcasts.length).toBe(1);
  });
});
