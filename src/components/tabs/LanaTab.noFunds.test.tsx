/**
 * The LANA tab, when the brain refuses a sale over the investors' money
 * (24 Nov 2026): no investor can fund it (409 NO_INVESTOR_BUDGET), or their
 * money could not be checked (503 FUND_UNREACHABLE). The brain says so at the
 * preview, before the customer's key signs, and at the purchase for a client
 * that sent no allocation. The seller reads the till's own words in their
 * language, never "Preview failed" or the brain's English.
 * Same stubs as LanaTab.payoutRefusal.test.
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
const MINED = { confirmed: 2077.1, unconfirmed: 0, unconfirmedLanoshis: 0, lana: 2077.1 };

const NO_BUDGET_WORDS = 'No investor can fund this sale in GBP right now.';
const UNREACHABLE_WORDS = 'Investor funds cannot be checked right now. Nothing was recorded; try again in a moment.';
const NO_BUDGET = {
  status: 409,
  body: { success: false, error: NO_BUDGET_WORDS, code: 'NO_INVESTOR_BUDGET', currency: 'GBP', message: NO_BUDGET_WORDS },
};
const UNREACHABLE = {
  status: 503,
  body: { success: false, error: UNREACHABLE_WORDS, code: 'FUND_UNREACHABLE', message: UNREACHABLE_WORDS },
};

let preview: { status: number; body: any };
let purchase: { status: number; body: any };

const json = (status: number, body: any) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.mocked(signCustomerLanaTx).mockClear();
  preview = {
    status: 200,
    body: { success: true, data: { recipients: [{ address: 'LRoBJ4VvWPGwY716YgfWcMFvzdaR6gHPZB', amount_lanoshis: NEEDED }], allocations: [] } },
  };
  purchase = { status: 200, body: { success: true, data: { tx_hash: '2c'.repeat(32) } } };
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.startsWith('/api/system-params')) return json(200, { data: { exchangeRates: { EUR: 0.256 } } });
    if (url.startsWith('/api/check-wallet')) {
      return json(200, { success: true, registered: true, wallet: { nostr_hex_id: '2f'.repeat(32), frozen: false } });
    }
    if (url.startsWith('/api/balance/')) return json(200, { ...MINED, status: 'active' });
    if (url.startsWith('/api/users/by-wallet/')) return json(404, {});
    if (url.startsWith('/api/brain/purchase/preview')) return json(preview.status, preview.body);
    if (url.startsWith('/api/brain/purchase')) return json(purchase.status, purchase.body);
    return json(404, {});
  }) as any);
});

async function scanAtTheTill() {
  render(
    <LanaTab
      unitCurrency="EUR"
      unitId="7282dd9339f0"
      paymentRequest={{ walletAddress: 'LfDJmg13pwCjG3u6T6GH4Y3MUEdRuj68Nd', invoiceNumber: 'R-17', amount: 164.7 }}
    />,
  );
  fireEvent.click(await screen.findByText('SCAN-NOW'));
}

describe('refused at the preview: nothing is signed', () => {
  it('no investor can fund the sale: the no-funds wording, not "Preview failed"', async () => {
    preview = NO_BUDGET;
    await scanAtTheTill();
    expect(await screen.findByText(i18n.t('cash.noFunds'))).toBeInTheDocument();
    expect(screen.queryByText(NO_BUDGET_WORDS)).not.toBeInTheDocument();
    expect(screen.queryByText('Preview failed')).not.toBeInTheDocument();
    expect(signCustomerLanaTx).not.toHaveBeenCalled();
  });

  it('the same in the seller\'s language', async () => {
    preview = NO_BUDGET;
    await i18n.changeLanguage('sl');
    await scanAtTheTill();
    expect(await screen.findByText('Ni razpoložljivih investitorskih sredstev')).toBeInTheDocument();
    expect(signCustomerLanaTx).not.toHaveBeenCalled();
  });

  it('the money could not be checked: a failed purchase to try again', async () => {
    preview = UNREACHABLE;
    await scanAtTheTill();
    expect(await screen.findByText(i18n.t('cash.purchaseFailed'))).toBeInTheDocument();
    expect(screen.queryByText(UNREACHABLE_WORDS)).not.toBeInTheDocument();
    expect(signCustomerLanaTx).not.toHaveBeenCalled();
  });

  it('an older brain\'s answer still prints as before', async () => {
    preview = { status: 400, body: { success: false, error: 'Preview failed' } };
    await scanAtTheTill();
    expect(await screen.findByText('Preview failed')).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('cash.noFunds'))).not.toBeInTheDocument();
  });
});

describe('refused at the purchase, before any LANA was sent', () => {
  it.each([
    ['NO_INVESTOR_BUDGET', NO_BUDGET, 'cash.noFunds', NO_BUDGET_WORDS],
    ['FUND_UNREACHABLE', UNREACHABLE, 'cash.purchaseFailed', UNREACHABLE_WORDS],
  ])('%s is said in the seller\'s words, as a refused sale, not as one being checked', async (_code, answer, key, words) => {
    purchase = answer;
    await scanAtTheTill();
    expect(await screen.findByText(i18n.t(key))).toBeInTheDocument();
    expect(screen.queryByText(words)).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t('purchase.paymentFailedTitle'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('purchase.inReviewTitle'))).not.toBeInTheDocument();
  });
});
