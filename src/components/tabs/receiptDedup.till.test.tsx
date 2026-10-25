/**
 * Alaja, 16 Oct 2026. A 9,10 € receipt was refused as "already used" three
 * times in four minutes:
 *  - the reader returned only the first line of a wrapped number, which an
 *    earlier receipt already had — and "Continue" was hidden, so the number
 *    could not be corrected;
 *  - a product photo then went on with the PREVIOUS photo's number;
 *  - the brain refused at payment and the till offered "Scan again", which
 *    only reopens the wallet scanner and sends the same number again.
 * The brain's rule is unchanged; these are the till's three fixes.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
import CashTab from './CashTab';
import LanaTab from './LanaTab';
import LanaOnlineTab from './LanaOnlineTab';

const WALLET = 'LfDJmg13pwCjG3u6T6GH4Y3MUEdRuj68Nd';
vi.mock('@/components/QRScanner', () => ({
  QRScanner: ({ isOpen, onScan }: any) =>
    isOpen ? <button onClick={() => onScan(globalThis.__scanValue)}>SCAN-NOW</button> : null,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: { currency: 'EUR' } }) }));
vi.mock('@/lib/compress-image', () => ({ compressImage: vi.fn(async (f: File) => ({ file: f })) }));
vi.mock('@/lib/crypto', () => ({
  convertWifToIds: vi.fn(async () => ({ walletId: 'LfDJmg13pwCjG3u6T6GH4Y3MUEdRuj68Nd', nostrHexId: '2f'.repeat(32) })),
}));
vi.mock('@/lib/transaction', () => ({
  signCustomerLanaTx: vi.fn(async () => ({ signedTxHex: 'ab'.repeat(100), fee: 38700 })),
}));

declare global { var __scanValue: string; }

const UNIT = '8d20dd51c92f4f0ba003d33e66e23d3f';
const READ_SHORT = 'TRG1-L0001-521';
const READ_FULL = 'TRG1-L0001-52160';

let analyses: any[] = [];
let usedNumbers: Set<string>;
let purchase: { status: number; body: any };
let dedupCalls: any[] = [];
let purchaseCalls: any[] = [];

const json = (status: number, body: any) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  analyses = [];
  usedNumbers = new Set();
  dedupCalls = [];
  purchaseCalls = [];
  purchase = { status: 200, body: { success: true, data: { tx_hash: '2c'.repeat(32), transaction_id: 't1' } } };
  globalThis.__scanValue = WALLET;
  let upload = 0;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
    if (url.startsWith('/api/receipt/upload')) {
      upload += 1;
      return json(200, { success: true, url: `https://files.example/r${upload}.jpg`, hash: String(upload).repeat(64).slice(0, 64) });
    }
    if (url.startsWith('/api/receipt/analyze')) return json(200, analyses.shift() ?? { isReceipt: false, description: 'x' });
    if (url.startsWith('/api/brain/purchase/check-dedup')) {
      const body = JSON.parse(init.body);
      dedupCalls.push(body);
      if (body.invoice_number && usedNumbers.has(body.invoice_number)) {
        return json(200, { duplicate: true, by: 'invoice', original_tx_id: 'fb73a279', original_created_at: '2026-10-13 08:44:53' });
      }
      return json(200, { duplicate: false });
    }
    if (url.startsWith('/api/brain/purchase/preview')) {
      return json(200, { success: true, data: { recipients: [{ address: 'LRoBJ4VvWPGwY716YgfWcMFvzdaR6gHPZB', amount_lanoshis: 3554687500 }], allocations: [] } });
    }
    if (url.startsWith('/api/brain/purchase')) {
      purchaseCalls.push(JSON.parse(init.body));
      return json(purchase.status, purchase.body);
    }
    if (url.startsWith('/api/system-params')) return json(200, { data: { exchangeRates: { EUR: 0.256 } } });
    if (url.startsWith('/api/check-wallet')) {
      return json(200, { success: true, registered: true, wallet: { nostr_hex_id: '2f'.repeat(32), frozen: false } });
    }
    if (url.startsWith('/api/balance/')) {
      return json(200, { confirmed: 2077.1, unconfirmed: 0, unconfirmedLanoshis: 0, lana: 2077.1, fiatValue: 531.7, currency: 'EUR', address: WALLET, status: 'active' });
    }
    if (url.startsWith('/api/users/by-wallet/')) return json(200, { user: { display_name: 'Test Buyer', hex_id: '2f'.repeat(32) } });
    if (url.startsWith('/api/payment-requests')) return json(200, { success: true, requests: [] });
    return json(404, {});
  }) as any);
});

const photo = (name: string) => new File([`bytes-of-${name}`], `${name}.jpg`, { type: 'image/jpeg' });

/** Take a photo with the first file input on the screen. */
async function takePhoto(container: HTMLElement, name: string) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [photo(name)] } });
}

const RECEIPT = (invoiceNumber: string, amount = 9.1) => ({ isReceipt: true, amount, currency: 'EUR', invoiceNumber, items: 'Krema za roke' });
const PRODUCT = { isReceipt: false, description: 'A tube of hand cream', amount: null, invoiceNumber: null };

describe('CashTab', () => {
  it('a product photo after a receipt photo does not carry the old number or amount', async () => {
    analyses = [RECEIPT(READ_SHORT, 51.8), PRODUCT];
    const { container } = render(<CashTab unitCurrency="EUR" unitId={UNIT} />);
    await takePhoto(container, 'receipt');
    await screen.findByText(i18n.t('cash.receiptDetected'));
    await takePhoto(container, 'product');
    await screen.findByText(i18n.t('cash.photoNotReceipt'));
    fireEvent.click(screen.getByText(i18n.t('cash.continueToInvoice')));
    const field = await screen.findByPlaceholderText(i18n.t('cash.descriptionPlaceholder')) as HTMLInputElement;
    expect(field.value).toBe('');
    expect((screen.getByPlaceholderText(i18n.t('cash.amountPlaceholder')) as HTMLInputElement).value).toBe('');
  });

  it('a pre-check hit on the number: the number can be corrected in place', async () => {
    usedNumbers.add(READ_SHORT);
    analyses = [RECEIPT(READ_SHORT)];
    const { container } = render(<CashTab unitCurrency="EUR" unitId={UNIT} />);
    await takePhoto(container, 'receipt');
    const fix = await screen.findByLabelText(i18n.t('cash.fixInvoiceNumber')) as HTMLInputElement;
    expect(fix.value).toBe(READ_SHORT);
    const go = screen.getByRole('button', { name: i18n.t('cash.continueToInvoice') });
    expect(go).toBeDisabled();                       // the refused number cannot go on as it is
    fireEvent.change(fix, { target: { value: READ_FULL } });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await screen.findByText(i18n.t('cash.scanCustomerWallet'));      // the invoice step
    expect(screen.queryByLabelText(i18n.t('cash.fixInvoiceNumber'))).not.toBeInTheDocument();
    const field = screen.getByPlaceholderText(i18n.t('cash.invoicePlaceholder')) as HTMLInputElement;
    expect(field.value).toBe(READ_FULL);
    expect(dedupCalls.at(-1)).toMatchObject({ unit_id: UNIT, invoice_number: READ_FULL });
  });

  it('a corrected number that is ALSO used stays on the receipt step', async () => {
    usedNumbers.add(READ_SHORT);
    usedNumbers.add(READ_FULL);
    analyses = [RECEIPT(READ_SHORT)];
    const { container } = render(<CashTab unitCurrency="EUR" unitId={UNIT} />);
    await takePhoto(container, 'receipt');
    const fix = await screen.findByLabelText(i18n.t('cash.fixInvoiceNumber'));
    fireEvent.change(fix, { target: { value: READ_FULL } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('cash.continueToInvoice') }));
    await waitFor(() => expect(dedupCalls.length).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: i18n.t('cash.continueToInvoice') })).toBeDisabled());
    expect(screen.queryByText(i18n.t('cash.scanCustomerWallet'))).not.toBeInTheDocument();
    expect(screen.getByLabelText(i18n.t('cash.fixInvoiceNumber'))).toBeInTheDocument();
  });

  it('refused at payment as DUPLICATE_INVOICE: back to the number field, not "Scan again"', async () => {
    analyses = [RECEIPT(READ_FULL)];
    purchase = { status: 409, body: { success: false, error: 'DUPLICATE_INVOICE', original_tx_id: 'x', original_created_at: '2026-10-14 07:10:44' } };
    const { container } = render(<CashTab unitCurrency="EUR" unitId={UNIT} />);
    await takePhoto(container, 'receipt');
    await screen.findByText(i18n.t('cash.receiptDetected'));
    fireEvent.click(screen.getByText(i18n.t('cash.continueToInvoice')));
    fireEvent.click(await screen.findByText(i18n.t('cash.scanCustomerWallet')));
    fireEvent.click(await screen.findByText('SCAN-NOW'));
    await waitFor(() => expect(purchaseCalls).toHaveLength(1));
    const scan = await screen.findByRole('button', { name: i18n.t('cash.scanCustomerWallet') });   // the invoice step again
    expect(screen.queryByText(i18n.t('common.scanAgain'))).not.toBeInTheDocument();
    const field = screen.getByPlaceholderText(i18n.t('cash.invoicePlaceholder')) as HTMLInputElement;
    expect(field.value).toBe(READ_FULL);
    expect(screen.getByText(i18n.t('cash.fixInvoiceHint'))).toBeInTheDocument();
    expect(scan).toBeDisabled();                     // same number → refused again
    fireEvent.change(field, { target: { value: `${READ_FULL}-2` } });
    expect(scan).toBeEnabled();
  });
});

describe('LanaTab', () => {
  it('a product photo after a receipt photo does not carry the old number or amount', async () => {
    analyses = [RECEIPT(READ_SHORT, 51.8), PRODUCT];
    const { container } = render(<LanaTab unitCurrency="EUR" unitId={UNIT} />);
    await takePhoto(container, 'receipt');
    await screen.findByText(i18n.t('cash.receiptDetected'));
    await takePhoto(container, 'product');
    await screen.findByText(i18n.t('cash.photoNotReceipt'));
    fireEvent.click(screen.getByText(i18n.t('cash.continueToInvoice')));
    const field = await screen.findByPlaceholderText(i18n.t('cash.descriptionPlaceholder')) as HTMLInputElement;
    expect(field.value).toBe('');
    expect((screen.getByPlaceholderText(i18n.t('cash.amountPlaceholder')) as HTMLInputElement).value).toBe('');
  });

  it('a pre-check hit on the number: the number can be corrected in place', async () => {
    usedNumbers.add(READ_SHORT);
    analyses = [RECEIPT(READ_SHORT)];
    const { container } = render(<LanaTab unitCurrency="EUR" unitId={UNIT} />);
    await takePhoto(container, 'receipt');
    const fix = await screen.findByLabelText(i18n.t('cash.fixInvoiceNumber'));
    fireEvent.change(fix, { target: { value: READ_FULL } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('cash.continueToInvoice') }));
    await screen.findByText(i18n.t('lana.continueToPayment'));       // the entry step
    expect(screen.queryByLabelText(i18n.t('cash.fixInvoiceNumber'))).not.toBeInTheDocument();
    const field = screen.getByPlaceholderText(i18n.t('cash.invoicePlaceholder')) as HTMLInputElement;
    expect(field.value).toBe(READ_FULL);
  });

  it('refused at payment as DUPLICATE_INVOICE: back to the number field, not "Try again"', async () => {
    globalThis.__scanValue = '6uCustomerTestWifNotReal';
    analyses = [RECEIPT(READ_FULL)];
    purchase = { status: 409, body: { success: false, error: 'DUPLICATE_INVOICE', original_tx_id: 'x', original_created_at: '2026-10-14 07:10:44' } };
    const { container } = render(<LanaTab unitCurrency="EUR" unitId={UNIT} />);
    await takePhoto(container, 'receipt');
    await screen.findByText(i18n.t('cash.receiptDetected'));
    fireEvent.click(screen.getByText(i18n.t('cash.continueToInvoice')));
    fireEvent.click(await screen.findByText(i18n.t('lana.continueToPayment')));
    fireEvent.click(await screen.findByText('SCAN-NOW'));
    await waitFor(() => expect(purchaseCalls).toHaveLength(1));
    const go = await screen.findByRole('button', { name: i18n.t('lana.continueToPayment') });     // the entry step again
    expect(screen.queryByText(i18n.t('common.tryAgain'))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t('purchase.paymentFailedTitle'))).not.toBeInTheDocument();
    const field = screen.getByPlaceholderText(i18n.t('cash.invoicePlaceholder')) as HTMLInputElement;
    expect(field.value).toBe(READ_FULL);
    expect(screen.getByText(i18n.t('cash.fixInvoiceHint'))).toBeInTheDocument();
    expect(go).toBeDisabled();
    fireEvent.change(field, { target: { value: `${READ_FULL}-2` } });
    expect(go).toBeEnabled();
  });
});

describe('LanaOnlineTab', () => {
  const renderOnline = () => render(<MemoryRouter><LanaOnlineTab unitCurrency="EUR" unitId={UNIT} merchantHex={'aa'.repeat(32)} /></MemoryRouter>);

  it('a product photo after a receipt photo does not carry the old number or amount', async () => {
    analyses = [RECEIPT(READ_SHORT, 51.8), PRODUCT];
    const { container } = renderOnline();
    await takePhoto(container, 'receipt');
    await screen.findByText(i18n.t('cash.receiptDetected'));
    await takePhoto(container, 'product');
    await screen.findByText(i18n.t('cash.photoNotReceipt'));
    fireEvent.click(screen.getByText(i18n.t('cash.continueToInvoice')));
    const field = await screen.findByPlaceholderText(i18n.t('cash.descriptionPlaceholder')) as HTMLInputElement;
    expect(field.value).toBe('');
  });

  it('a pre-check hit on the number: the number can be corrected in place', async () => {
    usedNumbers.add(READ_SHORT);
    analyses = [RECEIPT(READ_SHORT)];
    const { container } = renderOnline();
    await takePhoto(container, 'receipt');
    const fix = await screen.findByLabelText(i18n.t('cash.fixInvoiceNumber'));
    fireEvent.change(fix, { target: { value: READ_FULL } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('cash.continueToInvoice') }));
    await screen.findByText(i18n.t('lanaOnline.createRequest'));     // the entry step
    expect(screen.queryByLabelText(i18n.t('cash.fixInvoiceNumber'))).not.toBeInTheDocument();
    const field = screen.getByPlaceholderText(i18n.t('cash.invoicePlaceholder')) as HTMLInputElement;
    expect(field.value).toBe(READ_FULL);
  });
});
