/**
 * Every way a sale leaves the till carries the seller's signature: the real tabs, the
 * real signing code, the server's real verifier on what the tab actually sent.
 *
 * Cash has three doors (scanned card, regular customer, new card after registration)
 * and LANA has one. A sale with no key at all still leaves, and when the server does
 * not take a sale from this sign-in the seller reads why, in words.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

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
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import i18n from '@/i18n';
import CashTab from './CashTab';
import LanaTab from './LanaTab';
import { verifyNip98, forgetSpentTokens } from '../../../server/lib/nip98';

declare global {
  var __scanValue: string;
  var __session: any;
  var __customer: { key: string; hex: string };
}

vi.mock('@/components/QRScanner', () => ({
  QRScanner: ({ isOpen, onScan }: any) =>
    isOpen ? <button onClick={() => onScan(globalThis.__scanValue)}>SCAN-NOW</button> : null,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: globalThis.__session }) }));
vi.mock('@/lib/compress-image', () => ({ compressImage: vi.fn(async (f: File) => ({ file: f })) }));
vi.mock('@/lib/crypto', () => ({
  convertWifToIds: vi.fn(async () => ({
    walletId: 'LfDJmg13pwCjG3u6T6GH4Y3MUEdRuj68Nd',
    nostrHexId: globalThis.__customer.hex,
    nostrNpubId: 'npub1customer',
    privateKeyHex: globalThis.__customer.key,
  })),
}));
vi.mock('@/lib/transaction', () => ({
  signCustomerLanaTx: vi.fn(async () => ({ signedTxHex: 'ab'.repeat(100), fee: 38700 })),
}));

const PATH = '/api/brain/purchase';
const UNIT = '8d20dd51c92f4f0ba003d33e66e23d3f';
const WALLET = 'LfDJmg13pwCjG3u6T6GH4Y3MUEdRuj68Nd';
const REGULAR = { customer_hex_id: '2f'.repeat(32), customer_wallet: 'LbtLTSACAREiT513CVNpbg6NeE5cFbrhkC', display_name: 'Živa Šuštar' };

const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
function person() {
  const sk = generateSecretKey();
  return { key: toHex(sk), hex: getPublicKey(sk) };
}

let seller: { key: string; hex: string };
let registered = true;
let sent: Array<{ headers: Record<string, string>; body: string }> = [];
let answers: Array<{ status: number; body: unknown }> = [];

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

beforeEach(async () => {
  await i18n.changeLanguage('en');
  forgetSpentTokens();
  seller = person();
  registered = true;
  sent = [];
  answers = [];
  globalThis.__customer = person();
  globalThis.__session = { currency: 'EUR', nostrHexId: seller.hex, privateKeyHex: seller.key };
  globalThis.__scanValue = WALLET;
  (window as any).__selectedUnit = null;
  (window as any).__maxTransactionAmount = null;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
    if (url === PATH) {
      sent.push({ headers: init.headers, body: init.body });
      const next = answers.shift() ?? { status: 200, body: { success: true, data: { tx_hash: '2c'.repeat(32), transaction_id: 't1' } } };
      return json(next.status, next.body);
    }
    if (url.startsWith('/api/receipt/upload')) return json(200, { success: true, url: 'https://files.example/r1.jpg', hash: '1'.repeat(64) });
    if (url.startsWith('/api/receipt/analyze')) return json(200, { isReceipt: true, amount: 9.1, currency: 'EUR', invoiceNumber: 'INV-1', items: 'x' });
    if (url.startsWith('/api/brain/purchase/check-dedup')) return json(200, { duplicate: false });
    if (url.startsWith('/api/brain/purchase/preview')) {
      return json(200, { success: true, data: { recipients: [{ address: 'LRoBJ4VvWPGwY716YgfWcMFvzdaR6gHPZB', amount_lanoshis: 3554687500 }], allocations: [] } });
    }
    if (url.startsWith('/api/regular-customers')) return json(200, { customers: [REGULAR] });
    if (url.startsWith('/api/system-params')) return json(200, { data: { exchangeRates: { EUR: 0.256 } } });
    if (url.startsWith('/api/check-wallet')) {
      return json(200, registered
        ? { success: true, registered: true, wallet: { nostr_hex_id: '2f'.repeat(32), frozen: false } }
        : { success: true, registered: false });
    }
    if (url.startsWith('/api/balance/')) {
      const lana = registered ? 2077.1 : 0;
      return json(200, { confirmed: lana, unconfirmed: 0, unconfirmedLanoshis: 0, lana, fiatValue: lana / 4, currency: 'EUR', address: WALLET, status: 'active' });
    }
    if (url.startsWith('/api/users/by-wallet/')) return json(200, { user: { display_name: 'Test Buyer', hex_id: '2f'.repeat(32) } });
    if (url.startsWith('/api/profile-status')) return json(200, { status: 'absent' });
    if (url.startsWith('/api/broadcast-event')) return json(200, { success: ['wss://relay.example'] });
    if (url.startsWith('/api/register/wallet')) return json(200, { success: true, status: 'ok' });
    if (url.startsWith('/api/users')) return json(200, { success: true });
    return json(404, {});
  }) as any);
});
afterEach(() => { vi.unstubAllGlobals(); });

/** What the server would make of the n-th sale this tab sent. */
const verdictOn = (n: number, nowSec?: number) =>
  verifyNip98(sent[n].headers.Authorization, 'POST', PATH, { body: Buffer.from(sent[n].body, 'utf8'), nowSec });

async function toInvoiceStep() {
  const { container } = render(<CashTab unitCurrency="EUR" unitId={UNIT} />);
  fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
    target: { files: [new File(['bytes'], 'receipt.jpg', { type: 'image/jpeg' })] },
  });
  await screen.findByText(i18n.t('cash.receiptDetected'));
  fireEvent.click(screen.getByText(i18n.t('cash.continueToInvoice')));
  await screen.findByText(i18n.t('cash.scanCustomerWallet'));
}

async function scanCard() {
  fireEvent.click(screen.getByText(i18n.t('cash.scanCustomerWallet')));
  fireEvent.click(await screen.findByText('SCAN-NOW'));
}

const sellForLana = async () => {
  render(<LanaTab unitCurrency="EUR" unitId={UNIT} paymentRequest={{ walletAddress: WALLET, invoiceNumber: 'INV-L', amount: 9.1 } as any} />);
  fireEvent.click(await screen.findByText('SCAN-NOW'));
};

describe('every door signs, with the seller\'s key', () => {
  it('cash, a scanned card', async () => {
    await toInvoiceStep();
    await scanCard();
    await screen.findByText(i18n.t('cash.confirmedTitle'));
    expect(sent).toHaveLength(1);
    expect(verdictOn(0)).toMatchObject({ ok: true, hex: seller.hex });
    expect(sent[0].headers['x-till-signs']).toBe('1');
    expect(sent[0].headers['x-till-seller']).toBe(seller.hex);
    expect(JSON.parse(sent[0].body)).toMatchObject({ unit_id: UNIT, payment_type: 'cash', invoice_number: 'INV-1' });
  });

  it('cash, a regular customer picked from the list', async () => {
    await toInvoiceStep();
    fireEvent.click(await screen.findByText(REGULAR.display_name));
    await screen.findByText(i18n.t('cash.confirmedTitle'));
    expect(sent).toHaveLength(1);
    expect(verdictOn(0)).toMatchObject({ ok: true, hex: seller.hex });
    expect(sent[0].headers['x-till-signs']).toBe('1');
    expect(JSON.parse(sent[0].body)).toMatchObject({ customer_hex: REGULAR.customer_hex_id, customer_name: REGULAR.display_name });
  });

  it('cash, a new card right after it is registered: the seller signs, not the card', async () => {
    registered = false;
    globalThis.__scanValue = '6uCustomerTestWifNotReal';
    await toInvoiceStep();
    await scanCard();
    fireEvent.change(await screen.findByPlaceholderText(i18n.t('cash.fullNamePlaceholder')), { target: { value: 'Nova Kupka' } });
    fireEvent.click(screen.getByText(i18n.t('cash.registerAndContinue')));
    await screen.findByText(i18n.t('cash.confirmedTitle'));
    expect(sent).toHaveLength(1);
    expect(verdictOn(0)).toMatchObject({ ok: true, hex: seller.hex });
    expect(sent[0].headers['x-till-signs']).toBe('1');
    expect(sent[0].headers['x-till-seller'], 'the seller, not the card').toBe(seller.hex);
    expect(JSON.parse(sent[0].body)).toMatchObject({ customer_hex: globalThis.__customer.hex, customer_name: 'Nova Kupka' });
  });

  it('LANA: the seller signs the request, the customer\'s key stays with the payment', async () => {
    globalThis.__scanValue = '6uCustomerTestWifNotReal';
    await sellForLana();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(verdictOn(0)).toMatchObject({ ok: true, hex: seller.hex });
    expect(sent[0].headers['x-till-signs']).toBe('1');
    expect(sent[0].headers['x-till-seller'], 'the seller, not the customer').toBe(seller.hex);
    expect(JSON.parse(sent[0].body)).toMatchObject({ unit_id: UNIT, payment_type: 'lana', signed_tx_hex: 'ab'.repeat(100) });
    expect(sent[0].body).not.toContain(globalThis.__customer.key);
    expect(sent[0].headers.Authorization).not.toContain(globalThis.__customer.key);
  });

  it('a retry of the same sale is signed afresh, and both tokens are good', async () => {
    answers = [{ status: 502, body: { success: false, error: 'Failed to reach Brain service' } }];
    await toInvoiceStep();
    await scanCard();
    await screen.findByText('Failed to reach Brain service');
    fireEvent.click(screen.getByText(i18n.t('common.scanAgain')));
    fireEvent.click(await screen.findByText('SCAN-NOW'));
    await screen.findByText(i18n.t('cash.confirmedTitle'));
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toBe(sent[0].body);
    expect(sent[1].headers.Authorization).not.toBe(sent[0].headers.Authorization);
    expect(verdictOn(0)).toMatchObject({ ok: true, hex: seller.hex });
    expect(verdictOn(1)).toMatchObject({ ok: true, hex: seller.hex });
  });
});

describe('with no key in the session the sale still leaves', () => {
  beforeEach(() => { globalThis.__session = { currency: 'EUR', nostrHexId: seller.hex }; });

  it('cash', async () => {
    await toInvoiceStep();
    await scanCard();
    await screen.findByText(i18n.t('cash.confirmedTitle'));
    expect(sent).toHaveLength(1);
    expect(sent[0].headers.Authorization).toBeUndefined();
    expect(sent[0].headers['x-till-signs'], 'this code, with nothing to sign with').toBe('1');
    expect(sent[0].headers['x-till-seller']).toBe(seller.hex);
  });

  it('LANA', async () => {
    globalThis.__scanValue = '6uCustomerTestWifNotReal';
    await sellForLana();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].headers.Authorization).toBeUndefined();
    expect(sent[0].headers['x-till-signs']).toBe('1');
  });
});

describe('when the server does not take the sale from this sign-in', () => {
  const NOT_ENTITLED = { status: 403, body: { success: false, code: 'NOT_ENTITLED', error: 'raw refusal text', message: 'raw refusal text' } };
  const NOT_CONFIRMED = { status: 401, body: { success: false, code: 'SIGNATURE_REQUIRED', reason: 'MISSING', error: 'raw refusal text', message: 'raw refusal text' } };

  it.each([
    ['not owner or staff', NOT_ENTITLED, 'purchase.sellerNotEntitled'],
    ['not confirmed', NOT_CONFIRMED, 'purchase.sellerNotConfirmed'],
  ])('cash, %s: the seller reads why, in their language', async (_label, refusal, key) => {
    answers = [refusal];
    await toInvoiceStep();
    await scanCard();
    expect(await screen.findByText(i18n.t(key))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('cash.confirmedTitle'))).not.toBeInTheDocument();
    expect(screen.queryByText('raw refusal text')).not.toBeInTheDocument();
  });

  it.each([
    ['not owner or staff', NOT_ENTITLED, 'purchase.sellerNotEntitled'],
    ['not confirmed', NOT_CONFIRMED, 'purchase.sellerNotConfirmed'],
  ])('LANA, %s: the seller reads why, and it is not "being verified"', async (_label, refusal, key) => {
    answers = [refusal];
    globalThis.__scanValue = '6uCustomerTestWifNotReal';
    await sellForLana();
    expect(await screen.findByText(i18n.t(key))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('purchase.inReviewTitle'))).not.toBeInTheDocument();
    expect(screen.queryByText('raw refusal text')).not.toBeInTheDocument();
  });

  it('a phone with a wrong clock: signed again as of the server\'s time, and the sale goes through', async () => {
    const serverNow = Math.floor(Date.now() / 1000) + 3600;
    answers = [{ status: 401, body: { success: false, code: 'SIGNATURE_REQUIRED', reason: 'STALE', server_time: serverNow } }];
    await toInvoiceStep();
    await scanCard();
    await screen.findByText(i18n.t('cash.confirmedTitle'));
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toBe(sent[0].body);
    expect(verdictOn(1, serverNow)).toMatchObject({ ok: true, hex: seller.hex });
  });
});
