/**
 * The home screen for a shop without a company and without a bank account
 * (KIND 30901 payout_account "none", Brilly 23 Nov 2026).
 *
 * Such a shop sells for cash through this till and takes LANA only directly,
 * never through the brain. So: no brain LANA tile, no notice asking for bank
 * details, a calm note instead, and the Split and monthly-limit texts do not
 * send the seller to LANA. Its Lana-online tile stays (26 Nov 2026): there the
 * online payment request is a LANA neposredno payment link, never the brain's
 * request (LanaOnlineTab.direct.e2e.test.tsx). A shop that switches on
 * shop.lanapays.us reaches the till by itself with the next poll (the selected
 * unit used to keep its old payout fields until a reload), but a LANA tab that
 * is already open is never taken away: its answer may be the only place the
 * seller learns whether the customer paid.
 *
 * The real Index page; every tab and the chrome around it are stubs.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

const SELLER = '5e'.repeat(32);
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: { nostrHexId: '5e'.repeat(32), currency: 'EUR' } }) }));
vi.mock('@/components/TopBar', () => ({ default: () => <div>TOP-BAR</div> }));
vi.mock('@/components/MenuDrawer', () => ({ default: () => null }));
vi.mock('@/components/MobileQuotaPanel', () => ({ default: () => null }));
vi.mock('@/components/tabs/CashTab', () => ({ default: (p: any) => <div>CASH-TAB noCompany={String(p.noCompany)}</div> }));
vi.mock('@/components/tabs/LanaTab', () => ({ default: () => <div>LANA-TAB</div> }));
vi.mock('@/components/tabs/LanaOnlineTab', () => ({
  default: (p: any) => <div>LANA-ONLINE-TAB noCompany={String(p.noCompany)} direct={JSON.stringify(p.directLana ?? null)}</div>,
}));
vi.mock('@/components/tabs/WalletsTab', () => ({ default: () => <div>WALLETS-TAB</div> }));
vi.mock('@/components/tabs/OrdersTab', () => ({ default: () => <div>ORDERS-TAB</div> }));
vi.mock('@/components/tabs/RegularCustomersTab', () => ({ default: () => <div>REGULARS-TAB</div> }));
vi.mock('@/components/tabs/RegisterCustomerTab', () => ({ default: () => <div>REGISTER-TAB</div> }));
vi.mock('@/components/tabs/CaretakerTab', () => ({ default: () => <div>CARETAKER-TAB</div> }));
vi.mock('@/components/EditProfile', () => ({ default: () => <div>PROFILE</div> }));

import Index from './Index';

const UNIT = '8d20dd51c92f4f0ba003d33e66e23d3f';
const WALLET = 'LbtLTSACAREiT513CVNpbg6NeE5cFbrhkC';

/** A unit as GET /api/business-units hands it over, today. */
const companyUnit = {
  unit_id: UNIT, name: 'Kmetija Novak', owner_hex: SELLER, category: 'Food', category_detail: 'Eggs', currency: 'EUR',
  country: 'SI', image: null, logo: null, status: 'active', receiver_city: 'Ljubljana', lanapays_payout_method: 'fiat',
  suspension_status: 'active', suspension_reason: null, suspension_until: null, suspension_content: null,
  quota_volume_used: 0, quota_volume_limit: 0, quota_tx_used: 0, quota_tx_limit: 0, quota_currency: 'EUR', quota_period: '',
  updated_at: '2026-11-23 08:00:00',
  payout_configured: true, online_shop: false, payout_problems: [], payout_advice: [], payout_fix_url: 'https://shop.lanapays.us',
};
/** The same unit after its owner chose "without a company and without a bank account". */
const noCompanyUnit = {
  ...companyUnit, lanapays_payout_method: 'lana', payout_configured: false,
  payout_account: 'none', margin_percent: 10, lanapays_payout_wallet: WALLET,
};

let units: any[];
let split = false;

const json = (body: any) => Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  units = [companyUnit];
  split = false;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.startsWith('/api/business-units/')) return json({ units });
    if (url.startsWith('/api/system-params')) return json({ data: { splitApproaching: false, splitHappening: split, splitHappeningUntil: null } });
    if (url.startsWith('/api/payment-requests/unseen-count')) return json({ success: true, count: 0, latest: [] });
    if (url.startsWith('/api/payment-requests/mark-seen')) return json({ success: true });
    if (url.startsWith('/api/orders/pending-count')) return json({ success: true, count: 0, latest: [] });
    if (url.startsWith('/api/max-transaction')) return json({ max_amount: 200, source: 'merchant', merchant_limit: 200, fund_limit: 5000, currency: 'EUR' });
    return json({});
  }) as any);
});

afterEach(() => {
  vi.useRealTimers();
});

const lanaTile = () => screen.queryByText(i18n.t('home.payWithLana'));
const lanaOnlineTile = () => screen.queryByText(i18n.t('home.payLanaOnline'));
// The calm note of a shop without a company (its words depend on the direct-LANA switch, Index.directLana.test).
const note = () => screen.queryByTestId('no-company-note');

async function open() {
  render(<Index />);
  await screen.findByText('Kmetija Novak');
}

describe('a shop with a company: the home screen as before', () => {
  it('both LANA tiles, no note', async () => {
    await open();
    await waitFor(() => expect(lanaTile()).toBeInTheDocument());
    expect(lanaOnlineTile()).toBeInTheDocument();
    expect(note()).not.toBeInTheDocument();
  });

  it('missing bank details still grey LANA and say so', async () => {
    units = [{ ...companyUnit, payout_configured: false }];
    await open();
    expect(await screen.findByText(i18n.t('home.lanaPayoutNotConfigured'))).toBeInTheDocument();
  });
});

describe('a shop without a company and without a bank account', () => {
  it('no brain LANA tile, the calm note instead; the Lana-online tile stays', async () => {
    units = [noCompanyUnit];
    await open();
    // No direct-LANA button in this answer (an older server, or the switch off): the note says cash only.
    expect(await screen.findByText(i18n.t('home.noCompanyNoteCashOnly'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('home.noCompanyNote'))).not.toBeInTheDocument();
    expect(lanaTile()).not.toBeInTheDocument();
    // Lana-online makes a LANA neposredno link for it (26 Nov 2026), not the brain's request.
    expect(lanaOnlineTile()).toBeInTheDocument();
    // The cash tile is there as for every shop.
    expect(screen.getByText(i18n.t('home.cashPayment'))).toBeInTheDocument();
  });

  it('Lana-online opens the form of the shop without a company, never the "no bank account" panel', async () => {
    units = [noCompanyUnit];
    await open();
    await screen.findByTestId('no-company-note');
    // Not greyed by Direct Fund capacity or a missing bank account: neither is used.
    expect(lanaOnlineTile()!.closest('button')).not.toBeDisabled();
    fireEvent.click(lanaOnlineTile()!);
    expect(await screen.findByText('LANA-ONLINE-TAB noCompany=true direct=null')).toBeInTheDocument();
    expect(screen.queryByTestId('no-company-lana-closed')).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t('purchase.unitNoPayoutAccount'))).not.toBeInTheDocument();
  });

  it('— a shop with a company opens Lana-online as before', async () => {
    await open();
    await waitFor(() => expect(lanaTile()).toBeInTheDocument());
    fireEvent.click(lanaOnlineTile()!);
    expect(await screen.findByText('LANA-ONLINE-TAB noCompany=false direct=null')).toBeInTheDocument();
  });

  it('is never asked for bank details, whatever the payout fields say', async () => {
    units = [{ ...noCompanyUnit, payout_configured: false, payout_problems: ['ACCOUNT_MISSING'], payout_advice: ['RECEIVER_NOT_CHOSEN'] }];
    await open();
    await screen.findByTestId('no-company-note');
    expect(screen.queryByText(i18n.t('home.lanaPayoutNotConfigured'))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t('payoutCheck.titleBlocking'))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t('payoutCheck.titleAdvice'))).not.toBeInTheDocument();
  });

  it('during a Split the cash tile says when cash comes back, in English and Slovenian, not "pay with LANA"', async () => {
    units = [noCompanyUnit];
    split = true;
    await open();
    expect(await screen.findByText(i18n.t('split.happening.bodyNoCompany', { lng: 'en' }))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('split.happening.bodyNoCompany', { lng: 'sl' }))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('split.happening.body', { lng: 'en' }))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t('split.happening.body', { lng: 'sl' }))).not.toBeInTheDocument();
  });

  it('— a shop with a company keeps the Split text that points to LANA', async () => {
    split = true;
    await open();
    expect(await screen.findByText(i18n.t('split.happening.body', { lng: 'en' }))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('split.happening.bodyNoCompany', { lng: 'en' }))).not.toBeInTheDocument();
  });

  it('at the monthly cash limit: no "LANA stays unlimited"', async () => {
    units = [{ ...noCompanyUnit, suspension_status: 'quota_blocked' }];
    await open();
    expect(await screen.findByText(i18n.t('home.cashLimitReachedDetailNoCompany'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('home.cashLimitReachedDetail'))).not.toBeInTheDocument();
  });

  it('the cash till is told it is a shop without a company', async () => {
    units = [noCompanyUnit];
    await open();
    await screen.findByTestId('no-company-note');
    fireEvent.click(screen.getByText(i18n.t('home.cashPayment')));
    expect(await screen.findByText('CASH-TAB noCompany=true')).toBeInTheDocument();
  });

  it('— and a shop with a company is not', async () => {
    await open();
    await waitFor(() => expect(lanaTile()).toBeInTheDocument());
    fireEvent.click(screen.getByText(i18n.t('home.cashPayment')));
    expect(await screen.findByText('CASH-TAB noCompany=false')).toBeInTheDocument();
  });
});

describe('a switch on shop.lanapays.us reaches the till by itself', () => {
  /** Let the 30-second poll run once. */
  async function nextPoll() {
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  }

  it('company → without a company: the brain LANA tile goes, the note comes, no reload (the single unit is auto-selected)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    await waitFor(() => expect(lanaTile()).toBeInTheDocument());

    units = [noCompanyUnit];
    await nextPoll();

    await waitFor(() => expect(note()).toBeInTheDocument());
    expect(lanaTile()).not.toBeInTheDocument();
    // Lana-online stays: for this shop it now makes a LANA neposredno link.
    expect(lanaOnlineTile()).toBeInTheDocument();
  });

  it('a Lana-online tab already open when the switch arrives learns it, and makes a LANA neposredno link from then on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    await waitFor(() => expect(lanaTile()).toBeInTheDocument());
    fireEvent.click(lanaOnlineTile()!);
    expect(await screen.findByText('LANA-ONLINE-TAB noCompany=false direct=null')).toBeInTheDocument();

    units = [noCompanyUnit];
    await nextPoll();

    // The same tab, told: no "no bank account" panel takes it away.
    expect(await screen.findByText('LANA-ONLINE-TAB noCompany=true direct=null')).toBeInTheDocument();
    expect(screen.queryByTestId('no-company-lana-closed')).not.toBeInTheDocument();
  });

  it('without a company → company: the LANA tiles come back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    units = [noCompanyUnit];
    await open();
    await waitFor(() => expect(note()).toBeInTheDocument());

    units = [companyUnit];
    await nextPoll();

    await waitFor(() => expect(lanaTile()).toBeInTheDocument());
    expect(note()).not.toBeInTheDocument();
  });

  it('a LANA tab already open stays open when the switch arrives; back home, the tiles are gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    await waitFor(() => expect(lanaTile()).toBeInTheDocument());
    fireEvent.click(lanaTile()!);
    expect(await screen.findByText('LANA-TAB')).toBeInTheDocument();

    units = [noCompanyUnit];
    await nextPoll();

    // Still the tab: a payment it has sent may still be answered there.
    expect(screen.getByText('LANA-TAB')).toBeInTheDocument();
    expect(screen.queryByTestId('no-company-lana-closed')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(i18n.t('common.back')));
    await waitFor(() => expect(note()).toBeInTheDocument());
    expect(lanaTile()).not.toBeInTheDocument();
  });
});

describe('an old unit: the selected-shop refresh is exactly as before (review: SPEC 6, old units unchanged)', () => {
  async function nextPoll() {
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  }

  it('its bank data changing mid-session does not change its tiles until a reload, as before 23 Nov 2026', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    await waitFor(() => expect(lanaTile()).toBeInTheDocument());
    const tile = () => lanaTile()!.closest('button')!;
    expect(tile()).not.toBeDisabled();

    // The owner removed the IBAN on shop.lanapays.us: the next poll says so, nothing else changed.
    units = [{ ...companyUnit, payout_configured: false, payout_problems: ['ACCOUNT_MISSING'] }];
    await nextPoll();
    await nextPoll();
    expect(tile()).not.toBeDisabled();
    expect(screen.queryByText(i18n.t('home.lanaPayoutNotConfigured'))).not.toBeInTheDocument();
  });

  it('— a quota change still refreshes it, as before (and brings the new bank data with it)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    await waitFor(() => expect(lanaTile()).toBeInTheDocument());
    units = [{ ...companyUnit, payout_configured: false, quota_tx_used: 1 }];
    await nextPoll();
    await waitFor(() => expect(lanaTile()!.closest('button')).toBeDisabled());
  });
});
