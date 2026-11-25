/**
 * A LANA neposredno payment link end to end (Brilly, 25 Nov 2026): the seller
 * makes it in the real till tab (DirectLanaTab), the customer pays it on the
 * real public page (PublicDirectPay) with the real new signer, and the real
 * server routes (server/directLana.ts) run in this process on an in-memory
 * database. Only the camera, the chain (as if two agreeing Electrum servers),
 * the registrar and the relays are fakes.
 *
 * Throughout:
 *   - the customer's WIF and key never leave their page, in no URL, header or body;
 *   - the customer's page signs no request and carries no session: only
 *     /api/direct-pay/* is asked, with no Authorization header;
 *   - the seller's requests are signed (NIP-98) and ask only /api/direct-lana/*;
 *   - the key bytes are zero after signing.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
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
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import i18n from '@/i18n';
import { bytesToHex } from '@/lib/directLanaCore';
import type { CardKey } from '@/lib/directLanaSign';
import { initializeSchema } from '../../../server/db/schema';
import { ensureExclusionTables } from '../../../server/lib/personExclusion';
import { keepRawBody, forgetSpentTokens } from '../../../server/lib/nip98';
import { registerDirectLanaRoutes, runDirectLanaWorker, type DirectLanaDeps } from '../../../server/directLana';
import { RegistrarUnavailable, type RegistrarAnswer } from '../../../server/lib/directLanaRegistrar';
import { FakeChain } from '../../../server/fixtures/directLanaChain';
import { keyOf, wifOf, addressOfKey, hexOfKey } from '../../../server/fixtures/directLana';

declare global {
  var __session: any;
  var __cards: CardKey[];
  var __scanValue: string;
}

vi.mock('@/components/QRScanner', () => ({
  QRScanner: ({ isOpen, onScan, onClose }: any) =>
    isOpen ? <button onClick={() => { onScan(globalThis.__scanValue); onClose(); }}>SCAN-NOW</button> : null,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: globalThis.__session }) }));
// The real card reader, watched: every key it hands out is kept, to see it zeroed.
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
import PublicDirectPay from '@/pages/PublicDirectPay';

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

// ── what each side sent ─────────────────────────────────────────────────────
type Sent = { url: string; method: string; headers: string; body: string };
let requests: Sent[] = [];
/** The customer's next read of the link gets a 502 (a server being restarted). */
let failNextView = false;
const flat = (s: string | null | undefined) => String(s ?? '').replace(/[\u00a0\u202f]/g, ' ');
const zeroed = (c: CardKey) => c.key.every(b => b === 0);

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
  localStorage.setItem('lang', 'sl');
  await i18n.changeLanguage('sl');
  forgetSpentTokens();
  db.exec('DELETE FROM direct_lana_links; DELETE FROM direct_lana_sales; DELETE FROM direct_lana_payees; DELETE FROM business_units;');
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
  failNextView = false;
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
    if (!String(url).startsWith('/api/direct-lana/') && !String(url).startsWith('/api/direct-pay/')) return new Response('{}', { status: 404 });
    if (failNextView && String(url).startsWith('/api/direct-pay/') && (init.method || 'GET') === 'GET') {
      failNextView = false;
      return new Response('Bad Gateway', { status: 502 });
    }
    return realFetch(base + url, init);
  }) as any);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Whatever happened: the customer's WIF and key never left their page.
  const keyHex = bytesToHex(CARD);
  for (const r of requests) {
    for (const part of [r.url, r.headers, r.body]) {
      expect(part).not.toContain(CARD_WIF);
      expect(part).not.toContain(keyHex);
    }
    const customer = r.url.startsWith('/api/direct-pay/');
    const seller = r.url.startsWith('/api/direct-lana/');
    expect(customer || seller, r.url).toBe(true);
    // The customer's page signs nothing; every seller's call is signed.
    if (customer) expect(r.headers).not.toContain('Authorization');
    if (seller) expect(r.headers).toContain('Nostr ');
  }
});

// ── the seller's steps ──────────────────────────────────────────────────────
async function sellerMakesLink(amount = '10,00', invoice = '', note = '') {
  const view = render(<DirectLanaTab unit={UNIT_VIEW} pollMs={40} />);
  fireEvent.change(screen.getByTestId('direct-amount'), { target: { value: amount } });
  if (invoice) fireEvent.change(screen.getByTestId('direct-invoice'), { target: { value: invoice } });
  fireEvent.click(screen.getByTestId('direct-continue'));
  await screen.findByTestId('direct-breakdown');
  fireEvent.click(screen.getByTestId('direct-send-link'));
  if (note) fireEvent.change(screen.getByLabelText(/Opomba/), { target: { value: note } });
  fireEvent.click(screen.getByTestId('direct-create-link'));
  const url = (await screen.findByTestId('direct-link-url')).textContent || '';
  const token = /\/pay-direct\/([A-Za-z0-9_-]{32})$/.exec(url)?.[1];
  expect(token, url).toBeTruthy();
  return { view, token: token! };
}

// ── the customer's steps ────────────────────────────────────────────────────
function customerOpens(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/pay-direct/${token}`]}>
      <Routes><Route path="/pay-direct/:token" element={<PublicDirectPay pollMs={40} />} /></Routes>
    </MemoryRouter>,
  );
}
async function customerEntersKey(key = CARD_WIF) {
  fireEvent.click(await screen.findByText(i18n.t('pay.enterManually')));
  fireEvent.change(screen.getByTestId('pay-direct-key'), { target: { value: key } });
  fireEvent.click(screen.getByTestId('pay-direct-key-go'));
}

describe('a payment link, from the till to the customer\'s card to a block', () => {
  it('made at the till, paid at home, in a block: both sides see it paid', async () => {
    const { view, token } = await sellerMakesLink('10,00', 'R-21', 'Jajca za soboto');
    // The seller's request was signed and named the sale; no card, no key.
    const made = requests.find(r => r.url === '/api/direct-lana/links' && r.method === 'POST')!;
    expect(JSON.parse(made.body)).toEqual({ unit_id: UNIT, amount: '10.00', currency: 'EUR', invoice_number: 'R-21', note: 'Jajca za soboto' });
    view.unmount();

    // The customer opens the link.
    customerOpens(token);
    expect(flat((await screen.findByTestId('pay-direct-shop')).textContent)).toBe('Kmetija Novak');
    expect(flat(screen.getByTestId('pay-direct-total').textContent)).toBe('11,00 €');
    expect(screen.getByTestId('pay-direct-note').textContent).toContain('Jajca za soboto');
    expect(flat(screen.getByTestId('pay-direct-lana').textContent)).toBe('≈ 42,96875 LANA');
    expect(screen.getByText('Račun R-21')).toBeTruthy();

    await customerEntersKey();
    // The exact LANA and the fee from the server's plan, checked on this page.
    expect(flat((await screen.findByTestId('pay-direct-exact')).textContent)).toBe('42,96875 LANA');
    expect(flat(screen.getByTestId('pay-direct-confirm-text').textContent)).toMatch(/^Trgovini Kmetija Novak \(L\w{5}…\w{4}\) boste plačali 42,96875 LANA\. Omrežnina je 0,0003945 LANA\. Plačila ni mogoče preklicati\.$/);
    // What the page sent to be quoted: the card's PUBLIC key, nothing else.
    const asked = requests.find(r => r.url.endsWith('/quote'))!;
    expect(Object.keys(JSON.parse(asked.body))).toEqual(['public_key']);

    fireEvent.click(screen.getByTestId('pay-direct-confirm'));
    await screen.findByTestId('pay-direct-status-sent');
    expect(screen.getByText('Plačilo je poslano')).toBeTruthy();
    expect(chain.broadcasts.length).toBe(1);
    // Every key the page read is zero again.
    expect(globalThis.__cards.length).toBeGreaterThan(0);
    for (const c of globalThis.__cards) expect(zeroed(c)).toBe(true);

    // In a block: the page, asking by itself, shows it paid.
    chain.mine(chain.broadcasts[0], 301);
    chain.height = 301;
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    await screen.findByTestId('pay-direct-status-paid', {}, { timeout: 3000 });
    expect(screen.getByText('Plačilo je potrjeno')).toBeTruthy();
    expect(published.length).toBe(1);
    cleanup();

    // The seller's list says PLAČANO.
    render(<DirectLanaTab unit={UNIT_VIEW} pollMs={40} />);
    fireEvent.click(screen.getByTestId('direct-show-links'));
    const status = await screen.findByTestId('direct-link-row-status');
    expect(status.textContent).toBe('PLAČANO');
  });

  it('opened again after it was paid: "already paid", no key asked', async () => {
    const { view, token } = await sellerMakesLink();
    view.unmount();
    customerOpens(token);
    await customerEntersKey();
    fireEvent.click(await screen.findByTestId('pay-direct-confirm'));
    await screen.findByTestId('pay-direct-status-sent');
    chain.mine(chain.broadcasts[0], 301);
    chain.height = 301;
    await runDirectLanaWorker(db, deps as DirectLanaDeps);
    cleanup();
    customerOpens(token);
    await screen.findByTestId('pay-direct-status-paid');
    expect(screen.queryByTestId('pay-direct-key')).toBeNull();
    expect(screen.queryByText(i18n.t('pay.enterManually'))).toBeNull();
  });

  it('the seller cancels it: the customer sees it cancelled and cannot pay', async () => {
    const { view, token } = await sellerMakesLink();
    fireEvent.click(screen.getByText(i18n.t('directLana.showLinks')));
    fireEvent.click(await screen.findByTestId('direct-link-cancel'));
    fireEvent.click(screen.getByTestId('direct-link-cancel-yes'));
    await waitFor(() => expect(screen.getByTestId('direct-link-row-status').textContent).toBe('Preklicano'));
    view.unmount();
    customerOpens(token);
    await screen.findByTestId('pay-direct-closed-cancelled');
    expect(screen.getByText('Prodajalec je to povezavo za plačilo preklical.')).toBeTruthy();
    expect(chain.broadcasts).toEqual([]);
  });

  it('the customer\'s refusals are in their own words: an unregistered card, a wallet address instead of a key', async () => {
    const { view, token } = await sellerMakesLink();
    view.unmount();
    customerOpens(token);
    await customerEntersKey(CARD_ADDRESS);
    expect(flat((await screen.findByTestId('pay-direct-refusal')).textContent))
      .toBe('To je naslov denarnice, ne zasebni ključ. Za plačilo potrebujete zasebni ključ (WIF) svoje kartice.');
    registrar.delete(CARD_ADDRESS);
    fireEvent.change(screen.getByTestId('pay-direct-key'), { target: { value: CARD_WIF } });
    fireEvent.click(screen.getByTestId('pay-direct-key-go'));
    await waitFor(() => expect(flat(screen.getByTestId('pay-direct-refusal').textContent))
      .toBe('Plačilo ni bilo izvedeno: vaša kartica ni registrirana. Registrirate jo na blagajni LanaPays.Us.'));
    expect(chain.broadcasts).toEqual([]);
    for (const c of globalThis.__cards) expect(zeroed(c)).toBe(true);
  });

  it('a link the shop cannot take now is shown closed, without asking for a key', async () => {
    const { view, token } = await sellerMakesLink();
    view.unmount();
    db.prepare("UPDATE app_settings SET value = '' WHERE key = 'direct_lana_units'").run();
    customerOpens(token);
    await screen.findByTestId('pay-direct-closed-closed');
    expect(screen.getByText('Ta trgovina trenutno ne sprejema plačil LANA neposredno.')).toBeTruthy();
    expect(screen.queryByTestId('pay-direct-scan')).toBeNull();
  });

  it('an unknown link: "cannot be found"', async () => {
    customerOpens('x'.repeat(32));
    await screen.findByText('Povezave za plačilo ni mogoče najti. Preverite povezavo.');
  });

  it('a payment whose answer is lost: "being checked", never a second payment by itself', async () => {
    const { view, token } = await sellerMakesLink();
    view.unmount();
    chain.mode = 'odd';
    customerOpens(token);
    await customerEntersKey();
    fireEvent.click(await screen.findByTestId('pay-direct-confirm'));
    await screen.findByTestId('pay-direct-status-unknown');
    expect(screen.getByText('Plačilo se preverja (običajno nekaj minut). Ne plačajte z drugo kartico ali na drug način.')).toBeTruthy();
    // The page keeps asking and signs nothing new.
    await new Promise(r => setTimeout(r, 200));
    expect(requests.filter(r => r.url.endsWith('/submit')).length).toBe(1);
    // The same bytes again, on request.
    chain.mode = 'accept';
    fireEvent.click(screen.getByTestId('pay-direct-resend'));
    await screen.findByTestId('pay-direct-status-sent');
    expect(new Set(chain.broadcasts).size).toBe(1);
  });

  it('review fix: while a payment of the sale may still be mined, the till offers no link (it would be a second sale)', async () => {
    chain.mode = 'odd';
    render(<DirectLanaTab unit={UNIT_VIEW} pollMs={40} />);
    fireEvent.change(screen.getByTestId('direct-amount'), { target: { value: '10,00' } });
    fireEvent.click(screen.getByTestId('direct-continue'));
    await screen.findByTestId('direct-breakdown');
    // A fresh sale: the link is offered.
    expect(screen.getByTestId('direct-send-link')).toBeTruthy();
    fireEvent.click(screen.getByTestId('direct-scan'));
    fireEvent.click(await screen.findByText('SCAN-NOW'));
    fireEvent.click(await screen.findByTestId('direct-confirm'));
    await screen.findByTestId('direct-status-unknown');
    // "Pay again": the same sale, the same card. No link beside it.
    fireEvent.click(screen.getByTestId('direct-pay-again'));
    await screen.findByTestId('direct-breakdown');
    expect(screen.queryByTestId('direct-send-link')).toBeNull();
  });

  it('review fix: cancelled while the customer looks at the confirm screen: "cancelled", no key asked again', async () => {
    const { view, token } = await sellerMakesLink();
    view.unmount();
    customerOpens(token);
    await customerEntersKey();
    await screen.findByTestId('pay-direct-confirm');
    const id = (db.prepare('SELECT id FROM direct_lana_links WHERE token = ?').get(token) as any).id;
    db.prepare("UPDATE direct_lana_sales SET status = 'expired', reason = 'LINK_CANCELLED' WHERE status = 'quoted'").run();
    db.prepare("UPDATE direct_lana_links SET status = 'cancelled' WHERE id = ?").run(id);
    fireEvent.click(screen.getByTestId('pay-direct-confirm'));
    await screen.findByTestId('pay-direct-closed-cancelled');
    expect(screen.queryByTestId('pay-direct-key')).toBeNull();
    expect(chain.broadcasts).toEqual([]);
  });

  it('review fix: a server error on the first read is "try again", not "no such link"', async () => {
    const { view, token } = await sellerMakesLink();
    view.unmount();
    failNextView = true;
    customerOpens(token);
    const again = await screen.findByTestId('pay-direct-reload');
    expect(screen.queryByText('Povezave za plačilo ni mogoče najti. Preverite povezavo.')).toBeNull();
    fireEvent.click(again);
    expect(flat((await screen.findByTestId('pay-direct-total')).textContent)).toBe('11,00 €');
  });
});

