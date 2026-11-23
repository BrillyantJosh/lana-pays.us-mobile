/**
 * The LANA tab, when a sale is refused because of the shop's payout settings
 * (23 Nov 2026): a shop without a bank account (UNIT_NO_PAYOUT_ACCOUNT, from
 * this server or the brain), a new unit without one (brain NO_PAYOUT_ACCOUNT),
 * or a reward that must be paid in LANA without a valid wallet (brain
 * REWARD_WALLET_INVALID). The seller reads words, never the raw answer, and
 * the preview refusal stops the flow before the customer's key signs.
 * Same stubs as LanaTab.blockWait.test.
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
const WORDS = 'This shop has no bank account, so it cannot be paid with LANA this way. Cash works as usual.';

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
  it.each([
    ['this server, for a shop without a bank account', { status: 409, body: { success: false, code: 'UNIT_NO_PAYOUT_ACCOUNT', error: WORDS, message: WORDS } }, 'purchase.unitNoPayoutAccount'],
    ['the brain, for the same shop', { status: 409, body: { success: false, error: 'UNIT_NO_PAYOUT_ACCOUNT', code: 'UNIT_NO_PAYOUT_ACCOUNT', message: 'x' } }, 'purchase.unitNoPayoutAccount'],
    ['the brain, for a new unit with no bank account', { status: 409, body: { success: false, error: 'NO_PAYOUT_ACCOUNT', code: 'NO_PAYOUT_ACCOUNT', message: 'x' } }, 'purchase.noPayoutAccount'],
  ])('%s', async (_label, answer, key) => {
    preview = answer;
    await scanAtTheTill();
    expect(await screen.findByText(i18n.t(key))).toBeInTheDocument();
    expect(screen.queryByText('UNIT_NO_PAYOUT_ACCOUNT')).not.toBeInTheDocument();
    expect(screen.queryByText('NO_PAYOUT_ACCOUNT')).not.toBeInTheDocument();
    expect(signCustomerLanaTx).not.toHaveBeenCalled();
  });
});

describe('refused at the purchase, before any LANA was sent', () => {
  it.each([
    ['REWARD_WALLET_INVALID', 'purchase.rewardWalletInvalid'],
    ['NO_PAYOUT_ACCOUNT', 'purchase.noPayoutAccount'],
    ['UNIT_NO_PAYOUT_ACCOUNT', 'purchase.unitNoPayoutAccount'],
  ])('%s is said in the seller\'s words', async (code, key) => {
    purchase = { status: 409, body: { success: false, error: code, code, message: 'x' } };
    await scanAtTheTill();
    expect(await screen.findByText(i18n.t(key))).toBeInTheDocument();
    expect(screen.queryByText(code)).not.toBeInTheDocument();
    // Under the tab's usual title for a refused sale: nothing was received, so
    // the goods are not handed over — true here, no LANA moved.
    expect(screen.getByText(i18n.t('purchase.paymentFailedTitle'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('purchase.inReviewTitle'))).not.toBeInTheDocument();
  });

  it('every other refusal still prints as before', async () => {
    purchase = { status: 400, body: { success: false, error: 'No exchange rate found' } };
    await scanAtTheTill();
    expect(await screen.findByText('No exchange rate found')).toBeInTheDocument();
  });
});
