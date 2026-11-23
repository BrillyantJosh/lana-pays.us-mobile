/**
 * /pay/:token for a shop without a company and without a bank account
 * (KIND 30901 payout_account "none", 23 Nov 2026).
 *
 * The server shows such a link as closed from the first load, and refuses its
 * preview and submit (UNIT_NO_PAYOUT_ACCOUNT) if the shop switched while the
 * page was open. The buyer is told the link is closed, in their own language,
 * and is not asked for a key. Refusals because of the shop's payout settings
 * (brain NO_PAYOUT_ACCOUNT / REWARD_WALLET_INVALID) are not the buyer's to
 * fix: the shop cannot take this payment now. Other links show as before.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
import PublicPay from './PublicPay';

vi.mock('@/components/QRScanner', () => ({ QRScanner: () => null }));
vi.mock('@/lib/crypto', () => ({
  convertWifToIds: vi.fn(async () => ({ walletId: 'LfDJmg13pwCjG3u6T6GH4Y3MUEdRuj68Nd', nostrHexId: '2f'.repeat(32) })),
}));
vi.mock('@/lib/transaction', () => ({
  signCustomerLanaTx: vi.fn(async () => ({ signedTxHex: 'ab'.repeat(100), fee: 38700 })),
}));

const NEEDED = 4_882_812_500;
const UNIT_REFUSAL = {
  status: 409,
  body: {
    success: false, code: 'UNIT_NO_PAYOUT_ACCOUNT',
    error: 'This shop has no bank account, so it cannot be paid with LANA this way. Cash works as usual.',
  },
};

let requestStatus = 'pending';
let closedReason: string | undefined;
let previewAnswer: { status: number; body: any };
let submitAnswer: { status: number; body: any };

const json = (status: number, body: any) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  localStorage.setItem('lang', 'en');
  vi.mocked(signCustomerLanaTx).mockClear();
  requestStatus = 'pending';
  closedReason = undefined;
  previewAnswer = {
    status: 200,
    body: {
      success: true,
      data: {
        recipients: [{ address: 'LRoBJ4VvWPGwY716YgfWcMFvzdaR6gHPZB', amount_lanoshis: NEEDED }],
        allocations: [{ investor: 'x' }], lanaTotalLanoshis: NEEDED, exchangeRate: 0.256,
      },
    },
  };
  submitAnswer = { status: 200, body: { success: true, data: { txHash: 'c'.repeat(64) } } };
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.startsWith('/api/pay/TOKEN/preview')) return json(previewAnswer.status, previewAnswer.body);
    if (url.startsWith('/api/pay/TOKEN/submit')) return json(submitAnswer.status, submitAnswer.body);
    if (url.startsWith('/api/pay/TOKEN')) {
      return json(200, {
        success: true,
        request: {
          unitName: 'Kmetija Novak', amountFiat: 12.5, currency: 'EUR', invoiceNumber: 'R-17',
          receiptUrl: null, receiptDescription: null, status: requestStatus, closedReason, createdAt: '', expiresAt: null,
          paidAt: null, txHash: null, paidLanaLanoshis: null, paidExchangeRate: null,
          indicativeRate: 0.256, indicativeLanaLanoshis: NEEDED,
        },
      });
    }
    if (url.startsWith('/api/check-wallet')) {
      return json(200, { success: true, registered: true, wallet: { nostr_hex_id: '2f'.repeat(32), frozen: false } });
    }
    if (url.startsWith('/api/balance/')) {
      return json(200, { confirmed: 2077.1, unconfirmed: 0, unconfirmedLanoshis: 0, lana: 2077.1, status: 'active' });
    }
    if (url.startsWith('/api/users/by-wallet/')) return json(404, {});
    return json(404, {});
  }) as any);
});

function openPage() {
  render(
    <MemoryRouter initialEntries={['/pay/TOKEN']}>
      <Routes><Route path="/pay/:token" element={<PublicPay />} /></Routes>
    </MemoryRouter>,
  );
}

async function enterKey() {
  fireEvent.click(await screen.findByText(i18n.t('pay.enterManually')));
  const input = screen.getByPlaceholderText(i18n.t('pay.wifManualPlaceholder'));
  fireEvent.change(input, { target: { value: '6uBuyerTestWifNotARealKey' } });
  fireEvent.click(input.parentElement!.querySelector('button')!);
}

const closedText = () => screen.queryByText(i18n.t('pay.closedNoPayoutAccount'));

describe('a link of a shop without a bank account', () => {
  it('the first page load says it is closed, and no key is asked for', async () => {
    requestStatus = 'closed';
    closedReason = 'UNIT_NO_PAYOUT_ACCOUNT';
    openPage();
    expect(await screen.findByText(i18n.t('pay.closedNoPayoutAccount'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('pay.enterManually'))).not.toBeInTheDocument();
    // Not "cancelled by the seller": nobody cancelled it.
    expect(screen.queryByText(i18n.t('pay.cancelledInfo'))).not.toBeInTheDocument();
  });

  it('the shop switched while the page was open: the preview refusal closes it, nothing is signed', async () => {
    previewAnswer = UNIT_REFUSAL;
    openPage();
    await enterKey();
    await waitFor(() => expect(closedText()).toBeInTheDocument());
    expect(signCustomerLanaTx).not.toHaveBeenCalled();
    expect(screen.queryByText(i18n.t('pay.confirmAndPay'))).not.toBeInTheDocument();
  });

  it('the submit refusal (before the claim, nothing was sent) closes it too', async () => {
    submitAnswer = UNIT_REFUSAL;
    openPage();
    await enterKey();
    fireEvent.click(await screen.findByText(i18n.t('pay.confirmAndPay')));
    await waitFor(() => expect(closedText()).toBeInTheDocument());
    expect(screen.queryByText(i18n.t('pay.paidTitle'))).not.toBeInTheDocument();
  });
});

describe('the brain refuses because of the shop\'s payout settings: not the buyer\'s to fix', () => {
  it.each([
    ['NO_PAYOUT_ACCOUNT', { status: 409, body: { success: false, error: 'NO_PAYOUT_ACCOUNT', code: 'NO_PAYOUT_ACCOUNT', message: 'x' } }],
    ['REWARD_WALLET_INVALID', { status: 409, body: { success: false, error: 'REWARD_WALLET_INVALID', code: 'REWARD_WALLET_INVALID', message: 'x' } }],
  ])('%s at the preview: "the shop cannot take payments at the moment"', async (_code, answer) => {
    previewAnswer = answer;
    openPage();
    await enterKey();
    expect(await screen.findByText(i18n.t('purchase.merchantUnavailable'))).toBeInTheDocument();
    expect(screen.queryByText('NO_PAYOUT_ACCOUNT')).not.toBeInTheDocument();
    expect(signCustomerLanaTx).not.toHaveBeenCalled();
  });

  it('REWARD_WALLET_INVALID at the submit: the same words, the page stays on the payment', async () => {
    submitAnswer = { status: 409, body: { success: false, error: 'REWARD_WALLET_INVALID', code: 'REWARD_WALLET_INVALID', message: 'x' } };
    openPage();
    await enterKey();
    fireEvent.click(await screen.findByText(i18n.t('pay.confirmAndPay')));
    expect(await screen.findByText(i18n.t('purchase.merchantUnavailable'))).toBeInTheDocument();
    expect(closedText()).not.toBeInTheDocument();
  });
});

describe('every other link: as before', () => {
  it('a cancelled link says the seller cancelled it', async () => {
    requestStatus = 'cancelled';
    openPage();
    expect(await screen.findByText(i18n.t('pay.cancelledInfo'))).toBeInTheDocument();
    expect(closedText()).not.toBeInTheDocument();
  });

  it('an open link is paid', async () => {
    openPage();
    await enterKey();
    fireEvent.click(await screen.findByText(i18n.t('pay.confirmAndPay')));
    expect(await screen.findByText(i18n.t('pay.paidTitle'))).toBeInTheDocument();
  });
});
