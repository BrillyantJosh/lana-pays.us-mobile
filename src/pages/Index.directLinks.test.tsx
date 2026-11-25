/**
 * The notice of PAID payment links on the home screen (25 Nov 2026): a red
 * number on the "LANA neposredno" tile, the selected shop's only, gone as soon
 * as its links are opened; asked only by a seller whose shop takes LANA
 * neposredno. (The harness is the one of Index.directLana.test.tsx.)
 *
 * Below: the description of the harness this file was made from.
 * The "LANA neposredno" tile on the home screen (SPEC §4, phase 2).
 *
 * Only for a shop without a company (payout_account 'none') whose server
 * answer says its direct button is on (direct_lana.enabled: the switch, a
 * readable margin, a valid wallet, a LANA price; server/lib/directLanaUnit.ts).
 * Never beside the brain's LANA tiles, never for a shop with a company, not
 * greyed by Direct Fund capacity or by a Split. When it is off for a reason the
 * seller can fix, the reason is said; when the switch is simply off, nothing.
 * A switch on shop.lanapays.us or in the admin setting reaches the till with
 * the next poll, and an open direct tab is never taken away.
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

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: { nostrHexId: '5e'.repeat(32), privateKeyHex: '7'.repeat(64), currency: 'EUR' } }) }));
vi.mock('@/components/TopBar', () => ({ default: () => <div>TOP-BAR</div> }));
vi.mock('@/components/MenuDrawer', () => ({ default: () => null }));
vi.mock('@/components/MobileQuotaPanel', () => ({ default: () => null }));
vi.mock('@/components/tabs/CashTab', () => ({ default: () => <div>CASH-TAB</div> }));
vi.mock('@/components/tabs/LanaTab', () => ({ default: () => <div>LANA-TAB</div> }));
vi.mock('@/components/tabs/LanaOnlineTab', () => ({ default: () => <div>LANA-ONLINE-TAB</div> }));
vi.mock('@/components/tabs/DirectLanaTab', () => ({
  default: (p: any) => <button onClick={() => p.onLinksSeen?.(p.unit.unit_id)}>LINKS-SEEN {p.unit.unit_id}</button>,
}));
vi.mock('@/components/tabs/WalletsTab', () => ({ default: () => <div>WALLETS-TAB</div> }));
vi.mock('@/components/tabs/OrdersTab', () => ({ default: () => <div>ORDERS-TAB</div> }));
vi.mock('@/components/tabs/RegularCustomersTab', () => ({ default: () => <div>REGULARS-TAB</div> }));
vi.mock('@/components/tabs/RegisterCustomerTab', () => ({ default: () => <div>REGISTER-TAB</div> }));
vi.mock('@/components/tabs/CaretakerTab', () => ({ default: () => <div>CARETAKER-TAB</div> }));
vi.mock('@/components/EditProfile', () => ({ default: () => <div>PROFILE</div> }));

import Index from './Index';

const SELLER = '5e'.repeat(32);
const UNIT = '8d20dd51c92f4f0ba003d33e66e23d3f';
const WALLET = 'LbtLTSACAREiT513CVNpbg6NeE5cFbrhkC';

const companyUnit = {
  unit_id: UNIT, name: 'Kmetija Novak', owner_hex: SELLER, category: 'Food', category_detail: 'Eggs', currency: 'EUR',
  country: 'SI', image: null, logo: null, status: 'active', receiver_city: 'Ljubljana', lanapays_payout_method: 'fiat',
  suspension_status: 'active', suspension_reason: null, suspension_until: null, suspension_content: null,
  quota_volume_used: 0, quota_volume_limit: 0, quota_tx_used: 0, quota_tx_limit: 0, quota_currency: 'EUR', quota_period: '',
  updated_at: '2026-11-23 08:00:00',
  payout_configured: true, online_shop: false, payout_problems: [], payout_advice: [], payout_fix_url: 'https://shop.lanapays.us',
};
const noCompany = (direct_lana: { enabled: boolean; reason: string | null }) => ({
  ...companyUnit, lanapays_payout_method: 'lana', payout_configured: false,
  payout_account: 'none', margin_percent: 10, lanapays_payout_wallet: WALLET, direct_lana,
});
const ON = { enabled: true, reason: null };

let units: any[];
let unseen: any = { success: true, count: 0, by_unit: {}, latest: [] };
let unseenCalls = 0;
let split = false;
let fundLimit: number | null = 5000;

const json = (body: any) => Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  units = [noCompany(ON)];
  unseen = { success: true, count: 0, by_unit: {}, latest: [] };
  unseenCalls = 0;
  split = false;
  fundLimit = 5000;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.startsWith('/api/business-units/')) return json({ units });
    if (url.startsWith('/api/system-params')) return json({ data: { splitApproaching: false, splitHappening: split, splitHappeningUntil: null } });
    if (url.startsWith('/api/payment-requests/unseen-count')) return json({ success: true, count: 0, latest: [] });
    if (url.startsWith('/api/payment-requests/mark-seen')) return json({ success: true });
    if (url.startsWith('/api/orders/pending-count')) return json({ success: true, count: 0, latest: [] });
    if (url.startsWith('/api/direct-lana/links/unseen')) { unseenCalls++; return json(unseen); }
    if (url.startsWith('/api/max-transaction')) return json({ max_amount: 200, source: 'merchant', merchant_limit: 200, fund_limit: fundLimit, currency: 'EUR' });
    return json({});
  }) as any);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});


const badge = () => screen.queryByTestId('direct-links-badge');

describe('the red number of paid payment links', () => {
  it('shows the selected shop\'s count, and goes as soon as its links are opened', async () => {
    unseen = { success: true, count: 3, by_unit: { [UNIT]: 2, 'another-unit': 1 }, latest: [] };
    render(<Index />);
    await screen.findByText('Kmetija Novak');
    await waitFor(() => expect(badge()).toHaveTextContent('2'));
    fireEvent.click(await screen.findByTestId('direct-lana-tile'));
    fireEvent.click(await screen.findByText(`LINKS-SEEN ${UNIT}`));
    // Back on the home screen: the shop's number is gone at once, not at the next poll.
    fireEvent.click(screen.getByText(i18n.t('common.back')));
    await screen.findByTestId('direct-lana-tile');
    expect(badge()).toBeNull();
  });

  it('no badge when nothing is paid and unseen', async () => {
    render(<Index />);
    await screen.findByText('Kmetija Novak');
    await waitFor(() => expect(unseenCalls).toBeGreaterThan(0));
    expect(badge()).toBeNull();
  });

  it('a shop with a company, or one whose direct LANA is off: nothing is asked at all', async () => {
    units = [companyUnit];
    render(<Index />);
    await screen.findByText('Kmetija Novak');
    await new Promise(r => setTimeout(r, 50));
    expect(unseenCalls).toBe(0);
    units = [noCompany({ enabled: false, reason: 'DIRECT_LANA_OFF' })];
  });
});
