/**
 * Lana-online for a shop without a company and without a bank account
 * (KIND 30901 payout_account "none", Brilly 26 Nov 2026): the online payment
 * request form makes a LANA neposredno payment link, with the same signed call
 * the till's "Send a payment link" makes, instead of the brain's request that
 * such a shop is refused ("no bank account"). A shop with a company is exactly
 * as before.
 *
 * The real tab (LanaOnlineTab) against the real server routes in this process
 * (server/directLana.ts and server/paymentRequests.ts) on an in-memory
 * database, with a real seller key. Nothing here reaches a chain, a registrar,
 * a relay or the brain: making a link touches none of them.
 *
 * Throughout: every /api/direct-lana/* call is signed (NIP-98); a shop without
 * a company never asks the brain's routes, never uploads a receipt and never
 * reads "no bank account".
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
import { MemoryRouter } from 'react-router-dom';
import { finalizeEvent } from 'nostr-tools/pure';
import i18n from '@/i18n';
import { bytesToHex } from '@/lib/directLanaCore';
import { initializeSchema } from '../../../server/db/schema';
import { ensureExclusionTables } from '../../../server/lib/personExclusion';
import { keepRawBody, forgetSpentTokens } from '../../../server/lib/nip98';
import { registerDirectLanaRoutes, type DirectLanaDeps } from '../../../server/directLana';
import { registerPaymentRequestRoutes } from '../../../server/paymentRequests';
import { keyOf, addressOfKey, hexOfKey } from '../../../server/fixtures/directLana';

declare global {
  var __session: any;
}

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: globalThis.__session }) }));
vi.mock('@/lib/compress-image', () => ({ compressImage: vi.fn(async (f: File) => ({ file: f })) }));

import LanaOnlineTab from './LanaOnlineTab';

// ── the seller, the shops ───────────────────────────────────────────────────
const OWNER = keyOf(7);
const OWNER_HEX = hexOfKey(OWNER);
const SHOP_WALLET = addressOfKey(OWNER);
const PARAMS = keyOf(5);
/** Shop.lanapays.us option (c), as the shop signs it: no company, no bank, margin 10 %. */
const NO_COMPANY = 'nocompany-online-1';
/** A shop as before: a company with its bank account. */
const COMPANY = 'company-online-1';
const NO_BANK_WORDS = /bank account|bančn/i;

let db: Database.Database;
let server: any;
let base = '';
let realFetch: typeof fetch;
const quiet = { log: console.log, warn: console.warn, error: console.error };

const deps: Partial<DirectLanaDeps> = {
  // Making a link asks no chain, no registrar and no relay: any call is a fault.
  withChain: (async () => { throw new Error('no chain when a link is made'); }) as any,
  registrar: async () => { throw new Error('no registrar when a link is made'); },
  publish: async () => { throw new Error('no relay when a link is made'); },
  nowMs: () => Date.now(),
  paramsPubkey: hexOfKey(PARAMS),
  limitPerMinute: 10_000,
};

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
    .run(ev.id, JSON.stringify(ev), '[]', '[]', JSON.stringify({ EUR: Number(rate) }));
}

function seedUnits() {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex, currency, status, raw_event, unit_type, lana_only, suspension_status)
    VALUES (?, ?, ?, 1, ?, ?, ?, 'EUR', 'active', ?, NULL, 0, 'active')
  `);
  insert.run(NO_COMPANY, 'e'.repeat(64), OWNER_HEX, 'Eko kmetija', OWNER_HEX, JSON.stringify([OWNER_HEX]), JSON.stringify({
    kind: 30901, pubkey: OWNER_HEX, content: '',
    tags: [['d', NO_COMPANY], ['name', 'Eko kmetija'], ['payout_account', 'none'], ['margin_percent', '10'],
      ['lanapays_payout_method', 'lana'], ['online_shop', 'false'], ['lanapays_payout_wallet', SHOP_WALLET]],
  }));
  insert.run(COMPANY, 'd'.repeat(64), OWNER_HEX, 'Podjetje d.o.o.', OWNER_HEX, JSON.stringify([OWNER_HEX]), JSON.stringify({
    kind: 30901, pubkey: OWNER_HEX, content: '',
    tags: [['d', COMPANY], ['name', 'Podjetje d.o.o.'], ['receiver_type', 'company'], ['lanapays_payout_method', 'fiat']],
  }));
}

const linkRows = () => db.prepare('SELECT * FROM direct_lana_links ORDER BY created_at').all() as any[];
const requestRows = () => db.prepare('SELECT * FROM payment_requests').all() as any[];

// ── what the tab sent ───────────────────────────────────────────────────────
type Sent = { url: string; method: string; headers: string; body: string };
let requests: Sent[] = [];
const sent = (path: string, method = 'POST') => requests.filter(r => r.url === path && r.method === method);
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
  registerPaymentRequestRoutes(app, db);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(r => server.close(r));
  console.log = quiet.log; console.warn = quiet.warn; console.error = quiet.error;
});

beforeEach(async () => {
  localStorage.setItem('lang', 'en');
  await i18n.changeLanguage('en');
  forgetSpentTokens();
  db.exec('DELETE FROM direct_lana_links; DELETE FROM direct_lana_sales; DELETE FROM payment_requests; DELETE FROM business_units;');
  seedUnits();
  store38888();
  requests = [];
  globalThis.__session = { nostrHexId: OWNER_HEX, privateKeyHex: bytesToHex(OWNER), currency: 'EUR' };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
    const path = String(url).split('?')[0];
    requests.push({ url: path, method: init.method || 'GET', headers: JSON.stringify(init.headers || {}), body: typeof init.body === 'string' ? init.body : '' });
    if (path.startsWith('/api/direct-lana/') || path.startsWith('/api/payment-requests')) return realFetch(base + url, init);
    // The receipt photo's own routes (server/index.ts), as they answer.
    if (path === '/api/receipt/upload') return new Response(JSON.stringify({ success: true, url: RECEIPT_URL, hash: RECEIPT_HASH }), { status: 200 });
    if (path === '/api/receipt/analyze') return new Response(JSON.stringify({ isReceipt: true, amount: 12.5, currency: 'EUR', invoiceNumber: 'R-77', items: 'Jajca, 30 kosov' }), { status: 200 });
    if (path === '/api/brain/purchase/check-dedup') return new Response(JSON.stringify({ duplicate: false }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as any);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Every call of LANA neposredno is the seller's, signed.
  for (const r of requests.filter(q => q.url.startsWith('/api/direct-lana/'))) expect(r.headers, r.url).toContain('Nostr ');
});

const ON = { enabled: true, reason: null };
const LACKS_WALLET = { enabled: false, reason: 'WALLET_INVALID' };

function openTab(props: { unitId: string; noCompany?: boolean; directLana?: any }) {
  return render(
    <MemoryRouter>
      <LanaOnlineTab unitCurrency="EUR" unitId={props.unitId} merchantHex={OWNER_HEX}
        noCompany={props.noCompany} directLana={props.directLana} unitName="Eko kmetija" />
    </MemoryRouter>,
  );
}

const RECEIPT_URL = 'https://files.example/receipt-77.jpg';
const RECEIPT_HASH = 'ab'.repeat(32);

/** The form of a shop without a company, after its receipt step ("No receipt" here). */
async function fillDirect(amount: string, invoice = '', note = '') {
  if (screen.queryByTestId('receipt-step')) fireEvent.click(screen.getByTestId('receipt-skip'));
  fireEvent.change(await screen.findByTestId('online-direct-amount'), { target: { value: amount } });
  if (invoice) fireEvent.change(screen.getByTestId('online-direct-invoice'), { target: { value: invoice } });
  if (note) fireEvent.change(screen.getByLabelText(/Note/), { target: { value: note } });
  fireEvent.click(screen.getByTestId('online-direct-create'));
}

describe('a shop without a company: LANA neposredno, no switch (Brilly, 26 Nov 2026)', () => {
  it('the form makes a LANA neposredno payment link with one signed call: invoice + margin, into the shop\'s wallet', async () => {
    openTab({ unitId: NO_COMPANY, noCompany: true, directLana: ON });
    // The receipt comes first, as for every request (26 Nov 2026); "No receipt" goes on to the form.
    expect(await screen.findByTestId('receipt-step')).toBeTruthy();
    expect(screen.getByText(i18n.t('cash.takePhotoLabel'))).toBeTruthy();
    await fillDirect('12,50', 'R-7', 'Jajca za soboto');

    const url = flat((await screen.findByTestId('online-direct-url')).textContent);
    const token = /\/pay-direct\/([A-Za-z0-9_-]{32})$/.exec(url)?.[1];
    expect(token, url).toBeTruthy();
    // The total the customer pays: 12.50 + 10 % = 13.75 EUR.
    expect(flat(screen.getByTestId('online-direct-total').textContent)).toBe('€13.75');
    expect(screen.getByTestId('online-direct-margin')).toBeTruthy();
    expect(screen.getByText(i18n.t('directLana.linkCreated'))).toBeTruthy();

    // The till's own link call, signed, with the form's fields; nothing of the brain's rail.
    const made = sent('/api/direct-lana/links');
    expect(made.length).toBe(1);
    expect(JSON.parse(made[0].body)).toEqual({ unit_id: NO_COMPANY, amount: '12.50', currency: 'EUR', invoice_number: 'R-7', note: 'Jajca za soboto' });
    expect(sent('/api/payment-requests')).toEqual([]);
    expect(requests.some(r => r.url.startsWith('/api/receipt') || r.url.startsWith('/api/brain'))).toBe(false);

    // Stored as the till's link: one sale, the invoice, the shop's margin, the note.
    const rows = linkRows();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ token, unit_id: NO_COMPANY, seller_hex: OWNER_HEX, owner_hex: OWNER_HEX, invoice_cents: '1250', margin_percent: 10, invoice_number: 'R-7', note: 'Jajca za soboto', status: 'open', currency: 'EUR' });
    expect(requestRows()).toEqual([]);

    // The customer's page of it: open, the total, straight into the shop's wallet.
    const page = await (await realFetch(`${base}/api/direct-pay/${token}`)).json() as any;
    expect(page.link).toMatchObject({ status: 'open', total: '13.75', invoice: '12.50', recipient: SHOP_WALLET, note: 'Jajca za soboto' });
    expect(document.body.textContent).not.toMatch(NO_BANK_WORDS);
  });

  it('the invoice number is optional; the list below shows the shop\'s links, and an open one can be cancelled', async () => {
    openTab({ unitId: NO_COMPANY, noCompany: true, directLana: ON });
    await fillDirect('5');
    await screen.findByTestId('online-direct-url');
    expect(JSON.parse(sent('/api/direct-lana/links')[0].body)).toEqual({ unit_id: NO_COMPANY, amount: '5', currency: 'EUR' });
    const row = await screen.findByTestId('online-direct-link-row');
    expect(row.textContent).toContain(i18n.t('directLana.linkStatus.open'));

    fireEvent.click(screen.getByTestId('online-direct-link-cancel'));
    fireEvent.click(await screen.findByTestId('online-direct-link-cancel-yes'));
    await waitFor(() => expect(linkRows()[0].status).toBe('cancelled'));
    await waitFor(() => expect(screen.getByTestId('online-direct-link-row-status').textContent).toBe(i18n.t('directLana.linkStatus.cancelled')));
    expect(sent(`/api/direct-lana/links/${linkRows()[0].id}/cancel`).length).toBe(1);
  });

  it('a refusal of the server reads in the till\'s words, framed as the link (an invoice number already on an open link)', async () => {
    openTab({ unitId: NO_COMPANY, noCompany: true, directLana: ON });
    await fillDirect('5', 'R-1');
    await screen.findByTestId('online-direct-url');
    fireEvent.click(screen.getByText(i18n.t('lanaOnline.newRequest')));
    await fillDirect('6', 'R-1');
    expect(flat((await screen.findByTestId('online-direct-error')).textContent))
      .toBe(i18n.t('directLana.linkRefused', { reason: i18n.t('directLana.reason.INVOICE_HAS_LINK') }));
    expect(linkRows().length).toBe(1);
  });

  it('with a receipt photo: read for the amount and the number, carried by the link, shown on the customer\'s page', async () => {
    const { container } = openTab({ unitId: NO_COMPANY, noCompany: true, directLana: ON });
    await screen.findByTestId('receipt-step');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['bytes-of-receipt'], 'r.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(await screen.findByTestId('receipt-continue'));
    // What the reader saw is in the form; the receipt is there to look at again.
    expect((await screen.findByTestId('online-direct-amount') as HTMLInputElement).value).toBe('12.50');
    expect((screen.getByTestId('online-direct-invoice') as HTMLInputElement).value).toBe('R-77');
    expect(screen.getByTestId('online-direct-receipt')).toBeTruthy();
    // Asked early whether the photo or its number was paid already.
    expect(JSON.parse(sent('/api/brain/purchase/check-dedup')[0].body)).toEqual({ unit_id: NO_COMPANY, receipt_hash: RECEIPT_HASH, invoice_number: 'R-77' });
    fireEvent.click(screen.getByTestId('online-direct-create'));

    await screen.findByTestId('online-direct-url');
    expect(JSON.parse(sent('/api/direct-lana/links')[0].body)).toEqual({
      unit_id: NO_COMPANY, amount: '12.50', currency: 'EUR', invoice_number: 'R-77', receipt_url: RECEIPT_URL, receipt_hash: RECEIPT_HASH,
    });
    expect(linkRows()[0]).toMatchObject({ receipt_url: RECEIPT_URL, receipt_hash: RECEIPT_HASH });
    const page = await (await realFetch(`${base}/api/direct-pay/${linkRows()[0].token}`)).json() as any;
    expect(page.link.receipt_url).toBe(RECEIPT_URL);
    expect(JSON.stringify(page)).not.toContain(RECEIPT_HASH);

    // The same photo on a second link while the first is open: refused, in the till's words.
    fireEvent.click(screen.getByText(i18n.t('lanaOnline.newRequest')));
    const again = (await screen.findByTestId('receipt-step')).querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(again, { target: { files: [new File(['bytes-of-receipt'], 'r.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(await screen.findByTestId('receipt-continue'));
    fireEvent.change(await screen.findByTestId('online-direct-invoice'), { target: { value: 'R-78' } });
    fireEvent.click(screen.getByTestId('online-direct-create'));
    expect(flat((await screen.findByTestId('online-direct-error')).textContent))
      .toBe(i18n.t('directLana.linkRefused', { reason: i18n.t('directLana.reason.RECEIPT_HAS_LINK') }));
    expect(linkRows().length).toBe(1);
  });

  it('an amount the server would not read is never sent', async () => {
    openTab({ unitId: NO_COMPANY, noCompany: true, directLana: ON });
    fireEvent.click(await screen.findByTestId('receipt-skip'));
    fireEvent.change(await screen.findByTestId('online-direct-amount'), { target: { value: '12.505' } });
    expect((screen.getByTestId('online-direct-create') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('online-direct-amount'), { target: { value: '0' } });
    expect((screen.getByTestId('online-direct-create') as HTMLButtonElement).disabled).toBe(true);
    expect(sent('/api/direct-lana/links')).toEqual([]);
  });
});

describe('a shop without a company that lacks something LANA neposredno needs', () => {
  it('the till knows: it says what, at once; no form, nothing sent, never "no bank account"', async () => {
    openTab({ unitId: NO_COMPANY, noCompany: true, directLana: LACKS_WALLET });
    const box = await screen.findByTestId('online-direct-closed');
    expect(flat(box.textContent)).toBe(i18n.t('directLana.notice.WALLET_INVALID'));
    // Nobody is sent to an administrator's switch: there is none.
    expect(box.textContent).not.toContain('mobile.lanapays.us/admin');
    expect(screen.queryByTestId('online-direct-create')).toBeNull();
    expect(screen.queryByText(i18n.t('lanaOnline.createRequest'))).toBeNull();
    expect(document.body.textContent).not.toMatch(NO_BANK_WORDS);
    expect(requests.filter(r => r.method === 'POST')).toEqual([]);
  });

  it('— in Slovenian', async () => {
    await i18n.changeLanguage('sl');
    openTab({ unitId: NO_COMPANY, noCompany: true, directLana: LACKS_WALLET });
    expect(flat((await screen.findByTestId('online-direct-closed')).textContent)).toBe(i18n.t('directLana.notice.WALLET_INVALID', { lng: 'sl' }));
  });

  it('the till still thinks it can, the server says the shop is suspended: its words, framed as the link; no link stored', async () => {
    db.prepare("UPDATE business_units SET suspension_status = 'suspended' WHERE unit_id = ?").run(NO_COMPANY);
    openTab({ unitId: NO_COMPANY, noCompany: true, directLana: ON });
    await fillDirect('12,50', 'R-7');
    await waitFor(() => expect(sent('/api/direct-lana/links').length).toBe(1));
    expect(await screen.findByText(i18n.t('directLana.linkRefused', { reason: i18n.t('directLana.reason.UNIT') }))).toBeInTheDocument();
    expect(screen.queryByTestId('online-direct-closed')).toBeNull();
    expect(linkRows()).toEqual([]);
    expect(document.body.textContent).not.toMatch(NO_BANK_WORDS);
  });

  it('any other reason the shop lacks: the notice of the home screen', async () => {
    openTab({ unitId: NO_COMPANY, noCompany: true, directLana: { enabled: false, reason: 'PAYEE_FROZEN' } });
    expect(flat((await screen.findByTestId('online-direct-closed')).textContent)).toBe(i18n.t('directLana.notice.PAYEE_FROZEN'));
  });
});

describe('the shop switched to "without a company" a moment ago: the server knows, the till does not yet', () => {
  it('the brain\'s request is refused (nothing stored) and the same press makes the LANA neposredno link', async () => {
    // As Brilly met it (26 Nov 2026): the till still shows the shop as one with a bank account.
    openTab({ unitId: NO_COMPANY, noCompany: false });
    fireEvent.click(screen.getByText(i18n.t('cash.skipNoReceipt')));
    fireEvent.change(await screen.findByPlaceholderText(i18n.t('cash.invoicePlaceholder')), { target: { value: 'R-9' } });
    fireEvent.change(screen.getByPlaceholderText(i18n.t('cash.amountPlaceholder')), { target: { value: '12,50' } });
    fireEvent.click(screen.getByText(i18n.t('lanaOnline.createRequest')));

    await screen.findByTestId('online-direct-url');
    expect(sent('/api/payment-requests').length).toBe(1);
    expect(requestRows()).toEqual([]);
    expect(sent('/api/direct-lana/links').length).toBe(1);
    expect(JSON.parse(sent('/api/direct-lana/links')[0].body)).toMatchObject({ unit_id: NO_COMPANY, amount: '12.50', invoice_number: 'R-9' });
    expect(linkRows().length).toBe(1);
    expect(document.body.textContent).not.toMatch(NO_BANK_WORDS);
  });
});

describe('a shop with a company: Lana-online exactly as before', () => {
  it('the brain\'s payment request /pay/<token>, from the body\'s fields; LANA neposredno is never asked', async () => {
    openTab({ unitId: COMPANY, noCompany: false });
    expect(screen.getByText(i18n.t('cash.takePhotoLabel'))).toBeTruthy();
    fireEvent.click(screen.getByText(i18n.t('cash.skipNoReceipt')));
    fireEvent.change(await screen.findByPlaceholderText(i18n.t('cash.invoicePlaceholder')), { target: { value: 'INV-3' } });
    fireEvent.change(screen.getByPlaceholderText(i18n.t('cash.amountPlaceholder')), { target: { value: '12,50' } });
    fireEvent.click(screen.getByText(i18n.t('lanaOnline.createRequest')));

    await screen.findByText(i18n.t('lanaOnline.requestCreated'));
    const rows = requestRows();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ unit_id: COMPANY, amount_fiat: 12.5, currency: 'EUR', invoice_number: 'INV-3', status: 'pending' });
    expect(screen.getByText(`${window.location.origin}/pay/${rows[0].token}`)).toBeTruthy();
    expect(JSON.parse(sent('/api/payment-requests')[0].body)).toMatchObject({ unit_id: COMPANY, merchant_hex: OWNER_HEX, amount: 12.5, invoice_number: 'INV-3' });
    expect(requests.some(r => r.url.startsWith('/api/direct-lana/'))).toBe(false);
    expect(linkRows()).toEqual([]);
  });

  it('even if an answer claimed LANA neposredno for it, a shop with a company takes the brain\'s rail', async () => {
    openTab({ unitId: COMPANY, noCompany: false, directLana: ON });
    expect(screen.getByText(i18n.t('cash.takePhotoLabel'))).toBeTruthy();
    expect(screen.queryByTestId('online-direct-amount')).toBeNull();
    await waitFor(() => expect(requests.some(r => r.url === '/api/payment-requests' && r.method === 'GET')).toBe(true));
    expect(requests.some(r => r.url.startsWith('/api/direct-lana/'))).toBe(false);
  });
});
