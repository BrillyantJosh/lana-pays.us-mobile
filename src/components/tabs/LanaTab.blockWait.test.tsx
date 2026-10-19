/**
 * The till (LANA tab), same family as /pay on 19 Oct 2026: the customer's
 * wallet had an earlier payment waiting for its block, the node refused the
 * new one with -22, and the seller read "PAYMENT NOT RECEIVED — do NOT hand
 * over the goods" for a payment that simply had to wait a few minutes.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import i18n from '@/i18n';
import { signCustomerLanaTx } from '@/lib/transaction';
import LanaTab from './LanaTab';

vi.mock('@/components/QRScanner', () => ({
  QRScanner: ({ isOpen, onScan }: any) =>
    isOpen ? <button onClick={() => onScan('6uCustomerTestWifNotReal')}>SCAN-NOW</button> : null,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: { currency: 'EUR' } }) }));
vi.mock('@/lib/crypto', () => ({
  convertWifToIds: vi.fn(async () => ({ walletId: 'LfDJmg13pwCjG3u6T6GH4Y3MUEdRuj68Nd', nostrHexId: '2f'.repeat(32) })),
}));
vi.mock('@/lib/transaction', () => ({
  signCustomerLanaTx: vi.fn(async () => ({ signedTxHex: 'ab'.repeat(100), fee: 38700 })),
}));

const NEEDED = 64335937500;
const PENDING = { confirmed: 2143.51, unconfirmed: -66.41, unconfirmedLanoshis: -6640694300, lana: 2077.1 };
const MINED = { confirmed: 2077.1, unconfirmed: 0, unconfirmedLanoshis: 0, lana: 2077.1 };
const REFUSED_22 = {
  status: 402,
  body: { success: false, error: 'CUSTOMER_LANA_FAILED', reason: "Broadcast rejected: {u'message': u'TX rejected', u'code': -22}" },
};

let balances: any[] = [];
let purchase: { status: number; body: any } | 'network' = { status: 200, body: { success: true, data: { tx_hash: '2c'.repeat(32) } } };
let previewFails = false;

const json = (status: number, body: any) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.mocked(signCustomerLanaTx).mockClear();
  balances = [];
  previewFails = false;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.startsWith('/api/system-params')) return json(200, { data: { exchangeRates: { EUR: 0.256 } } });
    if (url.startsWith('/api/check-wallet')) {
      return json(200, { success: true, registered: true, wallet: { nostr_hex_id: '2f'.repeat(32), frozen: false } });
    }
    if (url.startsWith('/api/balance/')) {
      const b = balances.length > 1 ? balances.shift() : balances[0];
      return json(200, { ...b, status: 'active' });
    }
    if (url.startsWith('/api/users/by-wallet/')) return json(404, {});
    if (url.startsWith('/api/brain/purchase/preview')) {
      if (previewFails) return Promise.reject(new TypeError('Failed to fetch'));
      return json(200, {
        success: true,
        data: { recipients: [{ address: 'LRoBJ4VvWPGwY716YgfWcMFvzdaR6gHPZB', amount_lanoshis: NEEDED }], allocations: [] },
      });
    }
    if (url.startsWith('/api/brain/purchase')) {
      if (purchase === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      return json(purchase.status, purchase.body);
    }
    return json(404, {});
  }) as any);
});

async function scanAtTheTill() {
  render(
    <LanaTab
      unitCurrency="EUR"
      unitId="7282dd9339f0"
      paymentRequest={{ walletAddress: 'LfDJmg13pwCjG3u6T6GH4Y3MUEdRuj68Nd', invoiceNumber: 'ziva center 243640', amount: 164.7 }}
    />,
  );
  fireEvent.click(await screen.findByText('SCAN-NOW'));
}

const notReceived = () => screen.queryByText(i18n.t('purchase.paymentFailedTitle'));

describe('LanaTab — waiting for a block', () => {
  it('19 Oct 08:49: the wait is said before anything is signed', async () => {
    balances = [PENDING];
    await scanAtTheTill();
    expect(await screen.findByText(i18n.t('purchase.previousPaymentPending'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('purchase.waitingForBlockTitle'))).toBeInTheDocument();
    expect(signCustomerLanaTx).not.toHaveBeenCalled();
    expect(notReceived()).not.toBeInTheDocument();
  });

  it('a -22 refusal with a payment still unconfirmed reads as the wait', async () => {
    // Clear when the card is scanned, then the earlier payment shows up.
    balances = [MINED, PENDING];
    purchase = REFUSED_22;
    await scanAtTheTill();
    expect(await screen.findByText(i18n.t('purchase.previousPaymentPending'))).toBeInTheDocument();
    expect(signCustomerLanaTx).toHaveBeenCalledTimes(1);
    expect(notReceived()).not.toBeInTheDocument();
  });
});

describe('LanaTab — a genuine failure stays loud', () => {
  it('a -22 refusal with nothing unconfirmed: "payment not received, do not hand over"', async () => {
    balances = [MINED];
    purchase = REFUSED_22;
    await scanAtTheTill();
    expect(await screen.findByText(i18n.t('purchase.customerLanaFailed'))).toBeInTheDocument();
    expect(notReceived()).toBeInTheDocument();
  });

  it('a network error BEFORE the payment left the till is still a plain network error', async () => {
    balances = [MINED];
    previewFails = true;
    await scanAtTheTill();
    expect(await screen.findByText(i18n.t('lana.networkError'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('purchase.inReviewTitle'))).not.toBeInTheDocument();
  });
});

describe('LanaTab — outcome unknown is "being verified", never "not received"', () => {
  it.each([
    ['brain in doubt', { status: 409, body: { success: false, error: 'CUSTOMER_LANA_IN_DOUBT' } }],
    ['brain unreachable', { status: 502, body: { success: false, error: 'Failed to reach Brain service' } }],
    ['no answer after sending', 'network' as const],
  ])('%s', async (_label, outcome) => {
    balances = [MINED];
    purchase = outcome as any;
    await scanAtTheTill();
    expect(await screen.findByText(i18n.t('purchase.inReviewTitle'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('purchase.customerLanaInReview'))).toBeInTheDocument();
    expect(notReceived()).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t('common.tryAgain'))).not.toBeInTheDocument();
  });
});
