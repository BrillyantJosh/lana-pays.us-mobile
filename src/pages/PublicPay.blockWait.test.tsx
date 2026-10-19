/**
 * /pay/:token, replaying 19 Oct 2026 (»ziva center 243640«, 643.359375 LANA).
 *
 * The buyer's wallet had an earlier payment waiting for its block. The page
 * signed anyway, the node refused with -22 six times, and every time the page
 * said the payment had FAILED and the goods must NOT be handed over. These
 * tests pin what the page says now in each case: waiting for a block, a real
 * failure, and an outcome nobody knows yet.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

const NEEDED = 64335937500;
const PENDING = { confirmed: 2143.51, unconfirmed: -66.41, unconfirmedLanoshis: -6640694300, lana: 2077.1 };
const MINED = { confirmed: 2077.1, unconfirmed: 0, unconfirmedLanoshis: 0, lana: 2077.1 };
const REFUSED_22 = {
  status: 402,
  body: {
    success: false, error: 'CUSTOMER_LANA_FAILED', code: 'CUSTOMER_LANA_FAILED',
    reason: "Broadcast rejected: {u'message': u'TX rejected', u'code': -22}",
  },
};

let balances: any[] = [];
let submit: { status: number; body: any } | 'network' = { status: 200, body: { success: true, data: { txHash: 'c'.repeat(64) } } };
let requestStatus = 'pending';

const json = (status: number, body: any) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  localStorage.setItem('lang', 'en');
  vi.mocked(signCustomerLanaTx).mockClear();
  balances = [];
  requestStatus = 'pending';
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.startsWith('/api/pay/TOKEN/preview')) {
      return json(200, {
        success: true,
        data: {
          recipients: [{ address: 'LRoBJ4VvWPGwY716YgfWcMFvzdaR6gHPZB', amount_lanoshis: NEEDED }],
          allocations: [{ investor: 'x' }], lanaTotalLanoshis: NEEDED, exchangeRate: 0.256,
        },
      });
    }
    if (url.startsWith('/api/pay/TOKEN/submit')) {
      if (submit === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      return json(submit.status, submit.body);
    }
    if (url.startsWith('/api/pay/TOKEN')) {
      return json(200, {
        success: true,
        request: {
          unitName: 'Traussnig transport', amountFiat: 164.7, currency: 'EUR', invoiceNumber: 'ziva center 243640',
          receiptUrl: null, receiptDescription: null, status: requestStatus, createdAt: '', expiresAt: null,
          paidAt: null, txHash: requestStatus === 'paid' ? '2c'.repeat(32) : null,
          paidLanaLanoshis: requestStatus === 'paid' ? NEEDED : null, paidExchangeRate: null,
          indicativeRate: 0.256, indicativeLanaLanoshis: NEEDED,
        },
      });
    }
    if (url.startsWith('/api/check-wallet')) {
      return json(200, { success: true, registered: true, wallet: { nostr_hex_id: '2f'.repeat(32), frozen: false } });
    }
    if (url.startsWith('/api/balance/')) {
      const b = balances.length > 1 ? balances.shift() : balances[0];
      return json(200, { ...b, status: 'active' });
    }
    if (url.startsWith('/api/users/by-wallet/')) return json(404, {});
    return json(404, {});
  }) as any);
});

async function openAndEnterKey() {
  render(
    <MemoryRouter initialEntries={['/pay/TOKEN']}>
      <Routes><Route path="/pay/:token" element={<PublicPay />} /></Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText(i18n.t('pay.enterManually')));
  const input = screen.getByPlaceholderText(i18n.t('pay.wifManualPlaceholder'));
  fireEvent.change(input, { target: { value: '6uBuyerTestWifNotARealKey' } });
  fireEvent.click(input.parentElement!.querySelector('button')!);
  await screen.findByText(i18n.t('pay.confirmAndPay'));
}

const failed = () => screen.queryByText(i18n.t('purchase.customerLanaFailed'));
const waiting = () => screen.queryByText(i18n.t('lana.previousPaymentPending'));

describe('PublicPay — a payment waiting for its block', () => {
  it('19 Oct 08:49: says so on the confirm screen, and pressing pay signs nothing while it waits', async () => {
    balances = [PENDING];
    await openAndEnterKey();
    expect(waiting()).toBeInTheDocument();

    fireEvent.click(screen.getByText(i18n.t('pay.confirmAndPay')));
    await waitFor(() => expect(screen.getByText(i18n.t('pay.confirmAndPay'))).toBeInTheDocument());
    expect(waiting()).toBeInTheDocument();
    expect(signCustomerLanaTx).not.toHaveBeenCalled();
    expect(failed()).not.toBeInTheDocument();
  });

  it('once the block is in, the same button pays', async () => {
    balances = [PENDING, MINED];
    submit = { status: 200, body: { success: true, data: { txHash: '2c'.repeat(32), lanaPaidLanoshis: NEEDED, exchangeRate: 0.256 } } };
    await openAndEnterKey();
    expect(waiting()).toBeInTheDocument();
    fireEvent.click(screen.getByText(i18n.t('pay.confirmAndPay')));
    expect(await screen.findByText(i18n.t('pay.paidTitle'))).toBeInTheDocument();
    expect(signCustomerLanaTx).toHaveBeenCalledTimes(1);
  });

  it('a -22 refusal while a payment is still unconfirmed reads as the wait, not as a failure', async () => {
    // Clear at scan and right before signing, then the earlier payment shows up.
    balances = [MINED, MINED, PENDING];
    submit = REFUSED_22;
    await openAndEnterKey();
    expect(waiting()).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(i18n.t('pay.confirmAndPay')));
    expect(await screen.findByText(i18n.t('lana.previousPaymentPending'))).toBeInTheDocument();
    expect(failed()).not.toBeInTheDocument();
  });
});

describe('PublicPay — a genuine failure stays a failure', () => {
  it('a -22 refusal with nothing unconfirmed keeps the "not received, do not hand over" message', async () => {
    balances = [MINED];
    submit = REFUSED_22;
    await openAndEnterKey();
    fireEvent.click(screen.getByText(i18n.t('pay.confirmAndPay')));
    expect(await screen.findByText(i18n.t('purchase.customerLanaFailed'))).toBeInTheDocument();
    expect(waiting()).not.toBeInTheDocument();
  });
});

describe('PublicPay — an outcome nobody knows yet is "being verified"', () => {
  it.each([
    ['the brain stopped waiting for the broadcast', { status: 409, body: { success: false, error: 'CUSTOMER_LANA_IN_DOUBT' } }],
    ['the brain could not be reached', { status: 502, body: { success: false, error: 'Failed to reach Brain service' } }],
    ['no answer reached the browser', 'network' as const],
  ])('%s → being verified, no pay button, no "failed"', async (_label, outcome) => {
    balances = [MINED];
    submit = outcome as any;
    await openAndEnterKey();
    fireEvent.click(screen.getByText(i18n.t('pay.confirmAndPay')));
    expect(await screen.findByText(i18n.t('pay.inReview'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('pay.checkStatus'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('pay.confirmAndPay'))).not.toBeInTheDocument();
    expect(failed()).not.toBeInTheDocument();
  });

  it('"Check status" shows the paid request once the server has it as paid', async () => {
    balances = [MINED];
    submit = { status: 409, body: { success: false, error: 'CUSTOMER_LANA_IN_DOUBT' } };
    await openAndEnterKey();
    fireEvent.click(screen.getByText(i18n.t('pay.confirmAndPay')));
    await screen.findByText(i18n.t('pay.inReview'));
    requestStatus = 'paid';
    fireEvent.click(screen.getByText(i18n.t('pay.checkStatus')));
    expect(await screen.findByText(i18n.t('pay.alreadyPaid'))).toBeInTheDocument();
  });
});
