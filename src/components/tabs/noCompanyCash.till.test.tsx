/**
 * The cash till of a shop without a company and without a bank account
 * (KIND 30901 payout_account "none", Brilly 23 Nov 2026), through the real
 * CashTab with the stubs of cashLimits.till.test.
 *
 * Such a shop issues no invoices. The seller says what was sold ("What did you
 * sell?"), a photo is optional, and the till adds the unit's sale number from
 * the server. The brain refuses an invoice number used twice on one unit: the
 * stub brain below does the same, so these tests show that two sales described
 * the same way both go through, that one sale keeps its number on every retry,
 * and that no text sends this seller to LANA. Every other unit's cash sale is
 * exactly as it was.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
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
const SELLER = '5e'.repeat(32);
vi.mock('@/components/QRScanner', () => ({
  QRScanner: ({ isOpen, onScan }: any) =>
    isOpen ? <button onClick={() => onScan(globalThis.__scanValue)}>SCAN-NOW</button> : null,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: { currency: 'EUR', nostrHexId: '5e'.repeat(32) } }) }));
vi.mock('@/lib/compress-image', () => ({ compressImage: vi.fn(async (f: File) => ({ file: f })) }));

declare global { var __scanValue: string; }

const UNIT = '8d20dd51c92f4f0ba003d33e66e23d3f';

/** What the stub brain answers instead of a sale, once; null = a sale like the brain makes it. */
let refusal: { status: number; body: any } | null;
/** The next sale is recorded by the stub brain, but its answer is lost (502). */
let recordThenLose = false;
/** What POST /api/cash-sale-recorded answers: the stub brain's own book, or "cannot tell". */
let recordedCheck: 'brain' | 'down' = 'brain';
let recordedCalls: any[] = [];
let purchaseCalls: any[] = [];
let saleNumberCalls: Array<{ body: any; headers: Record<string, string> }> = [];
let dedupCalls: any[] = [];
let saleNumberAnswer: { status: number; body?: any } | null;
let nextSaleNumber = 1;
/** The brain's rule: one invoice number once per unit. */
let usedInvoices: Set<string>;

const json = (status: number, body: any) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body, clone() { return this; } } as unknown as Response);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  purchaseCalls = [];
  saleNumberCalls = [];
  dedupCalls = [];
  refusal = null;
  recordThenLose = false;
  recordedCheck = 'brain';
  recordedCalls = [];
  // A sale kept by an earlier test must not come back in this one.
  try { localStorage.clear(); } catch { /* no storage */ }
  saleNumberAnswer = null;
  nextSaleNumber = 1;
  usedInvoices = new Set();
  globalThis.__scanValue = WALLET;
  (window as any).__selectedUnit = { currency: 'EUR', owner_hex: 'aa'.repeat(32) };
  (window as any).__maxTransactionAmount = null;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
    if (url.startsWith('/api/cash-sale-number')) {
      saleNumberCalls.push({ body: JSON.parse(init.body), headers: init.headers });
      if (saleNumberAnswer) return json(saleNumberAnswer.status, saleNumberAnswer.body ?? {});
      return json(200, { success: true, number: nextSaleNumber++, date: '23.11.2026' });
    }
    if (url.startsWith('/api/receipt/upload')) {
      return json(200, { success: true, url: 'https://files.example/r1.jpg', hash: '1'.repeat(64) });
    }
    if (url.startsWith('/api/receipt/analyze')) {
      // The reader thinks it saw a receipt with a number: a shop without a company never takes it.
      return json(200, { isReceipt: true, amount: 9.1, currency: 'EUR', invoiceNumber: 'INV-1', items: 'eggs' });
    }
    if (url.startsWith('/api/brain/purchase/check-dedup')) {
      dedupCalls.push(JSON.parse(init.body));
      return json(200, { duplicate: false });
    }
    if (url.startsWith('/api/cash-sale-recorded')) {
      const body = JSON.parse(init.body);
      recordedCalls.push(body);
      if (recordedCheck === 'down') return json(503, { success: false, code: 'BRAIN_UNAVAILABLE' });
      return json(200, { success: true, recorded: usedInvoices.has(body.invoice_number) });
    }
    if (url.startsWith('/api/brain/purchase')) {
      const body = JSON.parse(init.body);
      purchaseCalls.push(body);
      if (refusal) { const r = refusal; refusal = null; return json(r.status, r.body); }
      if (usedInvoices.has(body.invoice_number)) {
        return json(409, { success: false, error: 'DUPLICATE_INVOICE', original_created_at: '2026-11-23 08:00:00' });
      }
      usedInvoices.add(body.invoice_number);
      if (recordThenLose) {
        recordThenLose = false;
        return json(502, { success: false, error: 'Failed to reach Brain service' });
      }
      return json(200, { success: true, data: { transaction_id: `t${purchaseCalls.length}` } });
    }
    if (url.startsWith('/api/check-wallet')) {
      return json(200, { success: true, registered: true, wallet: { nostr_hex_id: '2f'.repeat(32), frozen: false } });
    }
    if (url.startsWith('/api/balance/')) {
      return json(200, { confirmed: 2077.1, unconfirmed: 0, unconfirmedLanoshis: 0, lana: 2077.1, fiatValue: 531.7, currency: 'EUR' });
    }
    if (url.startsWith('/api/users/by-wallet/')) return json(200, { user: { display_name: 'Test Buyer', hex_id: '2f'.repeat(32) } });
    if (url.startsWith('/api/regular-customers/')) return json(200, { customers: [] });
    return json(404, {});
  }) as any);
});

afterEach(() => {
  (window as any).__selectedUnit = undefined;
  (window as any).__maxTransactionAmount = null;
});

/** From the first step to the filled sale, skipping the photo. */
async function toSaleStep(opts: { noCompany?: boolean } = { noCompany: true }) {
  render(<CashTab unitCurrency="EUR" unitId={UNIT} noCompany={opts.noCompany} />);
  fireEvent.click(screen.getByText(i18n.t(opts.noCompany ? 'cash.noCompanySkipPhoto' : 'cash.skipNoReceipt')));
  await screen.findByText(i18n.t('cash.scanCustomerWallet'));
}

function fill(description: string, amount = '9,10') {
  const field = screen.queryByLabelText(new RegExp(i18n.t('cash.whatDidYouSell').replace('?', '\\?')))
    ?? screen.getByPlaceholderText(i18n.t('cash.invoicePlaceholder'));
  fireEvent.change(field, { target: { value: description } });
  fireEvent.change(screen.getByPlaceholderText(i18n.t('cash.amountPlaceholder')), { target: { value: amount } });
}

async function scanAndPay(expectedCalls: number) {
  fireEvent.click(screen.getByText(i18n.t('cash.scanCustomerWallet')));
  fireEvent.click(await screen.findByText('SCAN-NOW'));
  await waitFor(() => expect(purchaseCalls).toHaveLength(expectedCalls));
}

describe('the sale of a shop without a company', () => {
  it('asks what was sold (a photo is optional) and sends it with the unit\'s sale number', async () => {
    render(<CashTab unitCurrency="EUR" unitId={UNIT} noCompany />);
    expect(screen.getByText(i18n.t('cash.noCompanyReceiptSubtitle'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('cash.skipNoReceipt'))).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(i18n.t('cash.noCompanySkipPhoto')));

    await screen.findByText(i18n.t('cash.noCompanyInvoiceTitle'));
    expect(screen.getByLabelText(/What did you sell\?/)).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('cash.invoiceNumber'))).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t('cash.saleNumberHint'))).toBeInTheDocument();

    fill('jajca, 10 kosov', '9,10');
    await scanAndPay(1);

    expect(saleNumberCalls).toHaveLength(1);
    expect(saleNumberCalls[0].body).toEqual({ unit_id: UNIT, staff_hex: SELLER });
    expect(purchaseCalls[0]).toMatchObject({
      unit_id: UNIT, payment_type: 'cash', amount: 9.1, currency: 'EUR',
      invoice_number: 'jajca, 10 kosov (#1, 23.11.2026)',
    });
    await screen.findByText(i18n.t('cash.confirmedTitle'));
    expect(screen.getByText(i18n.t('cash.saleNumberLabel', { number: 1 }))).toBeInTheDocument();
    expect(screen.getByText('jajca, 10 kosov')).toBeInTheDocument();
  });

  it('two sales described "jajca" both go through: the brain\'s duplicate rule refuses neither', async () => {
    await toSaleStep();
    fill('jajca');
    await scanAndPay(1);
    await screen.findByText(i18n.t('cash.confirmedTitle'));
    cleanup();

    await toSaleStep();
    fill('jajca');
    await scanAndPay(2);
    await screen.findByText(i18n.t('cash.confirmedTitle'));

    expect(purchaseCalls.map(p => p.invoice_number)).toEqual(['jajca (#1, 23.11.2026)', 'jajca (#2, 23.11.2026)']);
    expect(usedInvoices.size).toBe(2);
  });

  it('— without the number (a shop with a company typing a description) the second one is refused, which is why it is there', async () => {
    await toSaleStep({ noCompany: false });
    fill('jajca');
    await scanAndPay(1);
    await screen.findByText(i18n.t('cash.confirmedTitle'));
    cleanup();

    await toSaleStep({ noCompany: false });
    fill('jajca');
    await scanAndPay(2);
    expect(await screen.findByText(i18n.t('cash.duplicateInvoice', { date: new Date('2026-11-23T08:00:00Z').toLocaleString() }))).toBeInTheDocument();
    expect(saleNumberCalls).toEqual([]);
  });

  it('a retry after a lost answer sends the SAME text, so the brain still refuses one sale recorded twice', async () => {
    await toSaleStep();
    fill('jajca');
    refusal = { status: 502, body: { success: false, error: 'Failed to reach Brain service' } };
    await scanAndPay(1);

    fireEvent.click(await screen.findByText(i18n.t('common.scanAgain')));
    fireEvent.click(await screen.findByText('SCAN-NOW'));
    await waitFor(() => expect(purchaseCalls).toHaveLength(2));

    expect(saleNumberCalls).toHaveLength(1);
    expect(purchaseCalls[1].invoice_number).toBe(purchaseCalls[0].invoice_number);
    expect(purchaseCalls[1].invoice_number).toBe('jajca (#1, 23.11.2026)');
  });

  it('the brain says its text is already used: THIS sale is already recorded; it is never sent again under other words', async () => {
    // (Review, 23 Nov 2026: the till used to ask for other words with the same
    // number, and so recorded one cash sale twice.)
    await toSaleStep();
    fill('jajca');
    refusal = { status: 409, body: { success: false, error: 'DUPLICATE_INVOICE', original_created_at: '2026-11-23 08:00:00' } };
    await scanAndPay(1);

    const box = await screen.findByTestId('cash-sale-recorded');
    expect(box).toHaveTextContent(i18n.t('cash.saleAlreadyRecorded', { number: 1, description: 'jajca' }));
    expect(screen.queryByText(i18n.t('cash.scanCustomerWallet'))).not.toBeInTheDocument();

    // Done with: the next sale is a new one, with a new number.
    fireEvent.click(screen.getByText(i18n.t('common.newPayment')));
    fireEvent.click(await screen.findByText(i18n.t('cash.noCompanySkipPhoto')));
    await screen.findByText(i18n.t('cash.scanCustomerWallet'));
    fill('kruh');
    await scanAndPay(2);
    expect(purchaseCalls[1].invoice_number).toBe('kruh (#2, 23.11.2026)');
  });

  it('two quick taps on "Scan" ask for ONE number: one sale never holds two', async () => {
    await toSaleStep();
    fill('jajca');
    const scan = screen.getByText(i18n.t('cash.scanCustomerWallet'));
    fireEvent.click(scan);
    fireEvent.click(scan);
    fireEvent.click(await screen.findByText('SCAN-NOW'));
    await waitFor(() => expect(purchaseCalls).toHaveLength(1));

    expect(saleNumberCalls).toHaveLength(1);
    expect(purchaseCalls[0].invoice_number).toBe('jajca (#1, 23.11.2026)');
  });

  it('a failed number is asked again on the next tap, and the old error goes', async () => {
    await toSaleStep();
    fill('jajca');
    saleNumberAnswer = { status: 503, body: { success: false } };
    fireEvent.click(screen.getByText(i18n.t('cash.scanCustomerWallet')));
    await screen.findByText(i18n.t('cash.saleNumberFailed'));

    saleNumberAnswer = null;
    fireEvent.click(screen.getByText(i18n.t('cash.scanCustomerWallet')));
    fireEvent.click(await screen.findByText('SCAN-NOW'));
    await waitFor(() => expect(purchaseCalls).toHaveLength(1));

    expect(saleNumberCalls).toHaveLength(2);
    expect(purchaseCalls[0].invoice_number).toBe('jajca (#1, 23.11.2026)');
    expect(screen.queryByText(i18n.t('cash.saleNumberFailed'))).not.toBeInTheDocument();
  });

  it('no sale number from the server: the seller is told, the scanner does not open, nothing is sent', async () => {
    await toSaleStep();
    fill('jajca');
    saleNumberAnswer = { status: 503, body: { success: false } };
    fireEvent.click(screen.getByText(i18n.t('cash.scanCustomerWallet')));

    expect(await screen.findByText(i18n.t('cash.saleNumberFailed'))).toBeInTheDocument();
    expect(screen.queryByText('SCAN-NOW')).not.toBeInTheDocument();
    expect(purchaseCalls).toEqual([]);
  });

  it('a number read off a photo is never taken as the description, nor checked as an invoice number', async () => {
    const { container } = render(<CashTab unitCurrency="EUR" unitId={UNIT} noCompany />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['bytes'], 'eggs.jpg', { type: 'image/jpeg' })] } });
    await screen.findByText(i18n.t('cash.receiptDetected'));
    await waitFor(() => expect(dedupCalls).toHaveLength(1));
    expect(dedupCalls[0].invoice_number).toBeUndefined();
    expect(dedupCalls[0].receipt_hash).toBe('1'.repeat(64));

    fireEvent.click(screen.getByText(i18n.t('cash.continueToInvoice')));
    await screen.findByText(i18n.t('cash.noCompanyInvoiceTitle'));
    expect((screen.getByLabelText(/What did you sell\?/) as HTMLInputElement).value).toBe('');
  });
});

describe('what a shop without a company is told when cash is in the way: never "sell for LANA"', () => {
  it.each([
    ['the month used up (proxy 403)', { status: 403, body: { success: false, error: 'MERCHANT_QUOTA_EXCEEDED' } }, 'cash.monthlyCashLimitReachedNoCompany', {}],
    ['the month used up (brain 409)', { status: 409, body: { success: false, error: 'MERCHANT_QUOTA_EXCEEDED' } }, 'cash.monthlyCashLimitReachedNoCompany', {}],
    ['a Split', { status: 403, body: { success: false, error: 'SPLIT_HAPPENING' } }, 'split.happening.bodyNoCompany', {}],
    ['the same customer today', { status: 403, body: { success: false, error: 'CUSTOMER_WINDOW_EXCEEDED', spent: 200, limit: 200, days: 1, currency: 'EUR' } },
      'cash.customerWindowExceededTodayNoCompany', { spent: '200.00', limit: '200.00', days: 1, currency: 'EUR' }],
    ['the same customer, several days', { status: 403, body: { success: false, error: 'CUSTOMER_WINDOW_EXCEEDED', spent: 150, limit: 100, days: 3, currency: 'EUR' } },
      'cash.customerWindowExceededNoCompany', { spent: '150.00', limit: '100.00', days: 3, currency: 'EUR' }],
  ])('%s', async (_label, answer, key, values) => {
    await toSaleStep();
    fill('jajca');
    refusal = answer;
    await scanAndPay(1);

    const text = i18n.t(key, values);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(text).not.toMatch(/LANA/);
  });

  it('the brain refuses because the reward has no valid LANA wallet: the seller is told where to fix it', async () => {
    await toSaleStep();
    fill('jajca');
    refusal = { status: 409, body: { success: false, error: 'REWARD_WALLET_INVALID', code: 'REWARD_WALLET_INVALID', message: 'Trgovina nima veljavne LANA denarnice za nagrado.' } };
    await scanAndPay(1);

    expect(await screen.findByText(i18n.t('purchase.rewardWalletInvalid'))).toBeInTheDocument();
  });

  it('under the amount: the month used up is said without LANA', async () => {
    (window as any).__selectedUnit = { currency: 'EUR', quota_currency: 'EUR', quota_volume_limit: 300, quota_volume_used: 300, quota_tx_limit: 5, quota_tx_used: 1 };
    (window as any).__maxTransactionAmount = 0;
    await toSaleStep();
    expect(screen.getByText(i18n.t('cash.monthlyCashLimitReachedNoCompany'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('cash.monthlyCashLimitReached'))).not.toBeInTheDocument();
  });
});

describe('every other shop: the cash sale is exactly as before', () => {
  it('the invoice number as typed, no sale number asked for, the LANA advice where it was', async () => {
    await toSaleStep({ noCompany: false });
    expect(screen.getByText(i18n.t('cash.invoiceNumber'))).toBeInTheDocument();
    fill('2026-001234');
    refusal = { status: 403, body: { success: false, error: 'MERCHANT_QUOTA_EXCEEDED' } };
    await scanAndPay(1);

    expect(purchaseCalls[0].invoice_number).toBe('2026-001234');
    expect(saleNumberCalls).toEqual([]);
    expect(await screen.findByText(i18n.t('cash.monthlyCashLimitReached'))).toBeInTheDocument();
  });

  it('the number read off a receipt is used, as before', async () => {
    const { container } = render(<CashTab unitCurrency="EUR" unitId={UNIT} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['bytes'], 'receipt.jpg', { type: 'image/jpeg' })] } });
    await screen.findByText(i18n.t('cash.receiptDetected'));
    await waitFor(() => expect(dedupCalls).toHaveLength(1));
    expect(dedupCalls[0].invoice_number).toBe('INV-1');
    fireEvent.click(screen.getByText(i18n.t('cash.continueToInvoice')));
    await scanAndPay(1);
    expect(purchaseCalls[0].invoice_number).toBe('INV-1');
    expect(saleNumberCalls).toEqual([]);
  });
});

describe('a sale whose answer was lost is never recorded twice (review, 23 Nov 2026)', () => {
  /** The first try: the brain records "jajca (#1, …)", the answer is lost; then the tab closes. */
  async function lostAnswerThenLeave() {
    await toSaleStep();
    fill('jajca', '9,10');
    recordThenLose = true;
    await scanAndPay(1);
    await screen.findByText(i18n.t('common.scanAgain'));
    expect(usedInvoices).toEqual(new Set(['jajca (#1, 23.11.2026)']));
    cleanup(); // home screen, a reload, or a phone that dropped the tab
  }

  it('back on the till, the brain is asked first: it has the sale, so the till says so and sends nothing', async () => {
    await lostAnswerThenLeave();
    render(<CashTab unitCurrency="EUR" unitId={UNIT} noCompany />);
    const box = await screen.findByTestId('cash-sale-recorded');
    expect(box).toHaveTextContent(i18n.t('cash.saleAlreadyRecorded', { number: 1, description: 'jajca' }));
    expect(recordedCalls).toEqual([{ unit_id: UNIT, staff_hex: SELLER, invoice_number: 'jajca (#1, 23.11.2026)' }]);
    expect(purchaseCalls).toHaveLength(1);
    expect(saleNumberCalls).toHaveLength(1);
    // Forgotten once settled: the next visit starts a new sale.
    cleanup();
    render(<CashTab unitCurrency="EUR" unitId={UNIT} noCompany />);
    expect(await screen.findByText(i18n.t('cash.noCompanySkipPhoto'))).toBeInTheDocument();
    expect(recordedCalls).toHaveLength(1);
  });

  it('the brain cannot be asked: the SAME sale comes back, its words fixed; the brain refuses it as already recorded', async () => {
    await lostAnswerThenLeave();
    recordedCheck = 'down';
    render(<CashTab unitCurrency="EUR" unitId={UNIT} noCompany />);
    expect(await screen.findByTestId('cash-sale-pending')).toHaveTextContent(i18n.t('cash.salePendingUnknown', { number: 1, description: 'jajca' }));
    const field = screen.getByLabelText(/What did you sell\?/) as HTMLInputElement;
    expect(field.value).toBe('jajca');
    expect(field.readOnly).toBe(true);
    // Typing other words changes nothing: it is the sale that was sent.
    fireEvent.change(field, { target: { value: 'Jajca, 10 kosov' } });
    expect((screen.getByLabelText(/What did you sell\?/) as HTMLInputElement).value).toBe('jajca');
    await scanAndPay(2);
    expect(purchaseCalls[1].invoice_number).toBe('jajca (#1, 23.11.2026)');
    expect(await screen.findByTestId('cash-sale-recorded')).toBeInTheDocument();
    // One sale, one record: the second try was refused, and no new number was asked.
    expect(usedInvoices.size).toBe(1);
    expect(saleNumberCalls).toHaveLength(1);
  });

  it('the brain does not have it: the same number goes on, and its words may change', async () => {
    await toSaleStep();
    fill('jajca', '9,10');
    refusal = { status: 502, body: { success: false, error: 'Failed to reach Brain service' } };
    await scanAndPay(1);
    await screen.findByText(i18n.t('common.scanAgain'));
    cleanup();

    render(<CashTab unitCurrency="EUR" unitId={UNIT} noCompany />);
    expect(await screen.findByTestId('cash-sale-pending')).toHaveTextContent(i18n.t('cash.salePendingNotRecorded', { number: 1, description: 'jajca' }));
    const field = screen.getByLabelText(/What did you sell\?/) as HTMLInputElement;
    expect(field.readOnly).toBe(false);
    fill('jajca, 6 kosov', '5,40');
    await scanAndPay(2);
    expect(purchaseCalls[1]).toMatchObject({ invoice_number: 'jajca, 6 kosov (#1, 23.11.2026)', amount: 5.4 });
    await screen.findByText(i18n.t('cash.confirmedTitle'));
    expect(saleNumberCalls).toHaveLength(1);
  });

  it('dropping a kept sale asks the brain first: a sale it has can never be dropped and sold again', async () => {
    await lostAnswerThenLeave();
    recordedCheck = 'down';
    render(<CashTab unitCurrency="EUR" unitId={UNIT} noCompany />);
    await screen.findByTestId('cash-sale-pending');
    // Cannot tell: it stays, and the seller is told why.
    fireEvent.click(screen.getByTestId('cash-sale-discard'));
    expect(await screen.findByText(i18n.t('cash.saleDiscardUnknown'))).toBeInTheDocument();
    expect((screen.getByLabelText(/What did you sell\?/) as HTMLInputElement).readOnly).toBe(true);
    // The brain answers: it has it.
    recordedCheck = 'brain';
    fireEvent.click(screen.getByTestId('cash-sale-discard'));
    expect(await screen.findByTestId('cash-sale-recorded')).toBeInTheDocument();
    expect(purchaseCalls).toHaveLength(1);
  });

  it('a kept sale the brain does not have may be dropped: the next sale gets a new number', async () => {
    await toSaleStep();
    fill('jajca');
    refusal = { status: 403, body: { success: false, error: 'SPLIT_HAPPENING' } };
    await scanAndPay(1);
    cleanup();
    recordedCheck = 'down';
    render(<CashTab unitCurrency="EUR" unitId={UNIT} noCompany />);
    await screen.findByTestId('cash-sale-pending');
    recordedCheck = 'brain';
    fireEvent.click(screen.getByTestId('cash-sale-discard'));
    await waitFor(() => expect(screen.queryByTestId('cash-sale-discard')).not.toBeInTheDocument());
    fill('kruh');
    await scanAndPay(2);
    expect(purchaseCalls[1].invoice_number).toBe('kruh (#2, 23.11.2026)');
  });

  it('every other shop keeps nothing and asks nothing', async () => {
    await toSaleStep({ noCompany: false });
    fill('2026-001234');
    refusal = { status: 502, body: { success: false, error: 'Failed to reach Brain service' } };
    await scanAndPay(1);
    cleanup();
    render(<CashTab unitCurrency="EUR" unitId={UNIT} />);
    await screen.findByText(i18n.t('cash.skipNoReceipt'));
    expect(recordedCalls).toEqual([]);
    const kept: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('lanapays.cashSale')) kept.push(k);
      }
    } catch { /* no storage */ }
    expect(kept).toEqual([]);
  });
});
