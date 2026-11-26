/**
 * ONE seller, TWO shops of different kinds (Brilly's question, 25 Nov 2026): a
 * shop with a company and a shop of a person without a company. The till
 * follows the shop chosen on the home screen, by itself: the company shop gets
 * both brain LANA tiles and its cash sale as always; the shop without a company
 * gets the calm note, "LANA neposredno", the cash sale with its own sale
 * numbers, and a Lana-online that makes a LANA neposredno link (26 Nov 2026).
 * Switching back and forth changes it every time.
 * (The harness is the one of Index.noCompany.test.tsx, described below.)
 *
 * The home screen for a shop without a company and without a bank account
 * (KIND 30901 payout_account "none", Brilly 23 Nov 2026).
 *
 * Such a shop sells for cash through this till and takes LANA only directly,
 * never through the brain. So: no brain LANA tile, no notice asking for bank
 * details, a calm note instead, and the Split and monthly-limit texts do not
 * send the seller to LANA; its Lana-online makes a LANA neposredno link
 * (26 Nov 2026). A shop that switches on
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
vi.mock('@/components/tabs/CashTab', () => ({ default: (p: any) => <div>CASH-TAB unit={p.unitId} noCompany={String(p.noCompany)}</div> }));
vi.mock('@/components/tabs/LanaTab', () => ({ default: () => <div>LANA-TAB</div> }));
vi.mock('@/components/tabs/LanaOnlineTab', () => ({ default: (p: any) => <div>LANA-ONLINE-TAB unit={p.unitId} noCompany={String(p.noCompany)}</div> }));
vi.mock('@/components/tabs/DirectLanaTab', () => ({ default: (p: any) => <div>DIRECT-LANA-TAB unit={p.unit.unit_id}</div> }));
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


const COMPANY = 'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0';
const PERSON = UNIT;
const companyShop = { ...companyUnit, unit_id: COMPANY, name: 'Podjetje d.o.o.' };
const personShop = { ...noCompanyUnit, unit_id: PERSON, name: 'Kmetija Novak', direct_lana: { enabled: true, reason: null } };

const lanaTile = () => screen.queryByText(i18n.t('home.payWithLana'));
const lanaOnlineTile = () => screen.queryByText(i18n.t('home.payLanaOnline'));
const directTile = () => screen.queryByTestId('direct-lana-tile');
// Which kind of shop the tiles are for (no note says it on screen any more, Brilly 26 Nov 2026).
const shopKind = () => screen.queryByTestId('till-actions')?.getAttribute('data-shop-kind') ?? null;
const back = () => fireEvent.click(screen.getByText(i18n.t('common.back')));

describe('one seller with a company shop and a shop without a company', () => {
  beforeEach(() => { units = [companyShop, personShop]; });

  it('the till follows the chosen shop, both ways, every time', async () => {
    render(<Index />);
    await screen.findByText('Podjetje d.o.o.');

    for (let round = 0; round < 2; round++) {
      // The company shop: both brain LANA tiles, no direct LANA; its cash sale as always.
      fireEvent.click(screen.getByText('Podjetje d.o.o.'));
      await waitFor(() => expect(lanaTile()).toBeInTheDocument());
      expect(lanaOnlineTile()).toBeInTheDocument();
      expect(directTile()).not.toBeInTheDocument();
      expect(shopKind()).toBe('company');
      fireEvent.click(screen.getByText(i18n.t('home.cashPayment')));
      expect(await screen.findByText(`CASH-TAB unit=${COMPANY} noCompany=false`)).toBeInTheDocument();
      back();
      fireEvent.click(lanaOnlineTile()!);
      expect(await screen.findByText(`LANA-ONLINE-TAB unit=${COMPANY} noCompany=false`)).toBeInTheDocument();
      back();

      // The shop without a company: LANA neposredno, no brain LANA tile, no note; cash with its own numbers.
      fireEvent.click(await screen.findByText('Kmetija Novak'));
      await waitFor(() => expect(directTile()).toBeInTheDocument());
      expect(shopKind()).toBe('no-company');
      expect(screen.queryByTestId('no-company-note')).not.toBeInTheDocument();
      expect(lanaTile()).not.toBeInTheDocument();
      // Lana-online stays, and for this shop it makes a LANA neposredno link.
      expect(lanaOnlineTile()).toBeInTheDocument();
      fireEvent.click(screen.getByText(i18n.t('home.cashPayment')));
      expect(await screen.findByText(`CASH-TAB unit=${PERSON} noCompany=true`)).toBeInTheDocument();
      back();
      fireEvent.click(await screen.findByText(i18n.t('home.payLanaOnline')));
      expect(await screen.findByText(`LANA-ONLINE-TAB unit=${PERSON} noCompany=true`)).toBeInTheDocument();
      back();
      fireEvent.click(await screen.findByTestId('direct-lana-tile'));
      expect(await screen.findByText(`DIRECT-LANA-TAB unit=${PERSON}`)).toBeInTheDocument();
      back();
      await screen.findByText('Podjetje d.o.o.');
    }
  });

  it('two different sellers, one shop each: each till is set by its own shop, with nothing to choose', async () => {
    units = [companyShop];
    const first = render(<Index />);
    await screen.findByText('Podjetje d.o.o.');
    await waitFor(() => expect(lanaTile()).toBeInTheDocument());
    expect(directTile()).not.toBeInTheDocument();
    first.unmount();

    units = [personShop];
    render(<Index />);
    await screen.findByText('Kmetija Novak');
    await waitFor(() => expect(directTile()).toBeInTheDocument());
    expect(lanaTile()).not.toBeInTheDocument();
  });
});
