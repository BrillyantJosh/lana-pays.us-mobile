/**
 * What the seller reads and is shown at the cash till when a limit is in the way,
 * rendered through the real CashTab with the same stubs as receiptDedup.till.test.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import CashTab from './CashTab';

const WALLET = 'LfDJmg13pwCjG3u6T6GH4Y3MUEdRuj68Nd';
vi.mock('@/components/QRScanner', () => ({
  QRScanner: ({ isOpen, onScan }: any) =>
    isOpen ? <button onClick={() => onScan(globalThis.__scanValue)}>SCAN-NOW</button> : null,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: { currency: 'EUR' } }) }));
vi.mock('@/lib/compress-image', () => ({ compressImage: vi.fn(async (f: File) => ({ file: f })) }));

declare global { var __scanValue: string; }

const UNIT = '8d20dd51c92f4f0ba003d33e66e23d3f';
const MONTH_USED_UP = i18n.t('cash.monthlyCashLimitReached');

let purchase: { status: number; body: any };
let purchaseCalls: any[] = [];

const json = (status: number, body: any) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

const setUnit = (unit: unknown, maxTx: number | null) => {
  (window as any).__selectedUnit = unit;
  (window as any).__maxTransactionAmount = maxTx;
};

beforeEach(async () => {
  await i18n.changeLanguage('en');
  purchaseCalls = [];
  purchase = { status: 200, body: { success: true, data: { tx_hash: '2c'.repeat(32), transaction_id: 't1' } } };
  globalThis.__scanValue = WALLET;
  setUnit(null, null);
  vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
    if (url.startsWith('/api/receipt/upload')) {
      return json(200, { success: true, url: 'https://files.example/r1.jpg', hash: '1'.repeat(64) });
    }
    if (url.startsWith('/api/receipt/analyze')) {
      return json(200, { isReceipt: true, amount: 9.1, currency: 'EUR', invoiceNumber: 'INV-1', items: 'x' });
    }
    if (url.startsWith('/api/brain/purchase/check-dedup')) return json(200, { duplicate: false });
    if (url.startsWith('/api/brain/purchase')) {
      purchaseCalls.push(JSON.parse(init.body));
      return json(purchase.status, purchase.body);
    }
    if (url.startsWith('/api/system-params')) return json(200, { data: { exchangeRates: { EUR: 0.256 } } });
    if (url.startsWith('/api/check-wallet')) {
      return json(200, { success: true, registered: true, wallet: { nostr_hex_id: '2f'.repeat(32), frozen: false } });
    }
    if (url.startsWith('/api/balance/')) {
      return json(200, { confirmed: 2077.1, unconfirmed: 0, unconfirmedLanoshis: 0, lana: 2077.1, fiatValue: 531.7, currency: 'EUR' });
    }
    if (url.startsWith('/api/users/by-wallet/')) return json(200, { user: { display_name: 'Test Buyer', hex_id: '2f'.repeat(32) } });
    return json(404, {});
  }) as any);
});

afterEach(() => { setUnit(undefined, null); });

async function toInvoiceStep() {
  const { container } = render(<CashTab unitCurrency="EUR" unitId={UNIT} />);
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['bytes'], 'receipt.jpg', { type: 'image/jpeg' })] } });
  await screen.findByText(i18n.t('cash.receiptDetected'));
  fireEvent.click(screen.getByText(i18n.t('cash.continueToInvoice')));
  await screen.findByText(i18n.t('cash.scanCustomerWallet'));
}

async function pay() {
  fireEvent.click(screen.getByText(i18n.t('cash.scanCustomerWallet')));
  fireEvent.click(await screen.findByText('SCAN-NOW'));
  await waitFor(() => expect(purchaseCalls).toHaveLength(1));
}

describe('refused by the server', () => {
  it('CUSTOMER_WINDOW_EXCEEDED reads as the window\'s own message, with its numbers', async () => {
    purchase = { status: 403, body: { success: false, error: 'CUSTOMER_WINDOW_EXCEEDED', message: 'x', spent: 192.44, limit: 200, days: 1, currency: 'EUR' } };
    await toInvoiceStep();
    await pay();
    await screen.findByText(i18n.t('cash.customerWindowExceeded', { spent: '192.44', limit: '200.00', days: 1, currency: 'EUR' }));
    expect(screen.queryByText('CUSTOMER_WINDOW_EXCEEDED')).not.toBeInTheDocument();
    expect(screen.queryByText(MONTH_USED_UP)).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t('cash.noFunds'))).not.toBeInTheDocument();
  });

  it('MERCHANT_QUOTA_EXCEEDED reads as the monthly message, from the till or from the brain', async () => {
    purchase = { status: 409, body: { success: false, error: 'MERCHANT_QUOTA_EXCEEDED', message: 'x' } };
    await toInvoiceStep();
    await pay();
    await screen.findByText(MONTH_USED_UP);
    expect(screen.queryByText(/already spent/)).not.toBeInTheDocument();
  });
});
