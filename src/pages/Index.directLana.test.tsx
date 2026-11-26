/**
 * The "LANA neposredno" tile on the home screen (SPEC §4, phase 2).
 *
 * Only for a shop without a company (payout_account 'none') whose server
 * answer says its direct button is on (direct_lana.enabled: the switch, a
 * readable margin, a valid wallet, a LANA price; server/lib/directLanaUnit.ts).
 * Never beside the brain's LANA tiles, never for a shop with a company, not
 * greyed by Direct Fund capacity or by a Split. When it is off for a reason the
 * seller can fix, the reason is said; when the switch is simply off, nothing.
 * A switch on shop.lanapays.us or in the admin setting reaches the till with
 * the next poll, and an open direct tab is never taken away. The Lana-online
 * tile stays for such a shop (26 Nov 2026) and is handed the shop's direct view:
 * its request is a LANA neposredno link, or, with the switch off, the reason.
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

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: { nostrHexId: '5e'.repeat(32), currency: 'EUR' } }) }));
vi.mock('@/components/TopBar', () => ({ default: () => <div>TOP-BAR</div> }));
vi.mock('@/components/MenuDrawer', () => ({ default: () => null }));
vi.mock('@/components/MobileQuotaPanel', () => ({ default: () => null }));
vi.mock('@/components/tabs/CashTab', () => ({ default: () => <div>CASH-TAB</div> }));
vi.mock('@/components/tabs/LanaTab', () => ({ default: () => <div>LANA-TAB</div> }));
vi.mock('@/components/tabs/LanaOnlineTab', () => ({
  default: (p: any) => <div>LANA-ONLINE-TAB noCompany={String(p.noCompany)} direct={JSON.stringify(p.directLana ?? null)}</div>,
}));
vi.mock('@/components/tabs/DirectLanaTab', () => ({
  default: (p: any) => <div>DIRECT-LANA-TAB unit={p.unit.unit_id} wallet={p.unit.lanapays_payout_wallet} owner={p.unit.owner_hex}</div>,
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
let split = false;
let fundLimit: number | null = 5000;

const json = (body: any) => Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  units = [noCompany(ON)];
  split = false;
  fundLimit = 5000;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.startsWith('/api/business-units/')) return json({ units });
    if (url.startsWith('/api/system-params')) return json({ data: { splitApproaching: false, splitHappening: split, splitHappeningUntil: null } });
    if (url.startsWith('/api/payment-requests/unseen-count')) return json({ success: true, count: 0, latest: [] });
    if (url.startsWith('/api/payment-requests/mark-seen')) return json({ success: true });
    if (url.startsWith('/api/orders/pending-count')) return json({ success: true, count: 0, latest: [] });
    if (url.startsWith('/api/max-transaction')) return json({ max_amount: 200, source: 'merchant', merchant_limit: 200, fund_limit: fundLimit, currency: 'EUR' });
    return json({});
  }) as any);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const directTile = () => screen.queryByTestId('direct-lana-tile');
const directNotice = () => screen.queryByTestId('direct-lana-notice');
const brainLanaTile = () => screen.queryByText(i18n.t('home.payWithLana'));
const lanaOnlineTile = () => screen.queryByText(i18n.t('home.payLanaOnline'));

async function open() {
  render(<Index />);
  await screen.findByText('Kmetija Novak');
}

describe('a shop without a company whose direct button is on', () => {
  it('the "LANA direct" tile, no brain LANA tile; Lana-online stays and makes a LANA neposredno link', async () => {
    await open();
    expect(await screen.findByTestId('direct-lana-tile')).toHaveTextContent(i18n.t('directLana.tileTitle'));
    expect(brainLanaTile()).not.toBeInTheDocument();
    expect(lanaOnlineTile()).toBeInTheDocument();
    expect(directNotice()).not.toBeInTheDocument();
    fireEvent.click(lanaOnlineTile()!);
    expect(await screen.findByText(`LANA-ONLINE-TAB noCompany=true direct=${JSON.stringify(ON)}`)).toBeInTheDocument();
    expect(screen.queryByTestId('no-company-lana-closed')).not.toBeInTheDocument();
  });

  it('opens the direct till for this shop, with its wallet and its owner', async () => {
    await open();
    fireEvent.click(await screen.findByTestId('direct-lana-tile'));
    expect(await screen.findByText(`DIRECT-LANA-TAB unit=${UNIT} wallet=${WALLET} owner=${SELLER}`)).toBeInTheDocument();
    expect(screen.queryByText('LANA-TAB')).not.toBeInTheDocument();
  });

  it('the calm note says the shop also takes LANA directly, only now (Slovenian: the SPEC sentence)', async () => {
    await i18n.changeLanguage('sl');
    await open();
    expect(await screen.findByTestId('no-company-note')).toHaveTextContent('Ta trgovina prodaja za gotovino in sprejema LANE neposredno.');
  });

  it('a reason the seller can act on: the note says cash only, beside the notice', async () => {
    units = [noCompany({ enabled: false, reason: 'WALLET_INVALID' })];
    await i18n.changeLanguage('sl');
    await open();
    expect(await screen.findByTestId('no-company-note')).toHaveTextContent('Ta trgovina prodaja za gotovino.');
    expect(screen.getByTestId('no-company-note')).not.toHaveTextContent('LANE');
  });

  it('in Slovenian: "LANA neposredno"', async () => {
    await i18n.changeLanguage('sl');
    await open();
    expect(await screen.findByTestId('direct-lana-tile')).toHaveTextContent('LANA neposredno');
  });

  it('is not greyed by a Split, nor by Direct Fund capacity: neither is used', async () => {
    split = true;
    fundLimit = 0;
    await open();
    const tile = await screen.findByTestId('direct-lana-tile');
    await waitFor(() => expect(screen.getByText(i18n.t('split.happening.bodyNoCompany', { lng: 'en' }))).toBeInTheDocument());
    expect(tile).not.toBeDisabled();
    fireEvent.click(tile);
    expect(await screen.findByText(/DIRECT-LANA-TAB/)).toBeInTheDocument();
  });
});

describe('off: a reason the seller can act on is said, a switch that is off says nothing', () => {
  it('the switch is off: no tile and no notice, only the calm note, which says cash only', async () => {
    units = [noCompany({ enabled: false, reason: 'DIRECT_LANA_OFF' })];
    await open();
    // (Review: it used to say "… and accepts LANA directly" with no button to do so.)
    expect(await screen.findByTestId('no-company-note')).toHaveTextContent(i18n.t('home.noCompanyNoteCashOnly'));
    expect(screen.getByTestId('no-company-note')).not.toHaveTextContent(i18n.t('home.noCompanyNote'));
    expect(directTile()).not.toBeInTheDocument();
    expect(directNotice()).not.toBeInTheDocument();
    expect(brainLanaTile()).not.toBeInTheDocument();
  });

  it('the switch is off: Lana-online is there and its tab is told so (it says the administrator switches it on), never "no bank account"', async () => {
    const OFF = { enabled: false, reason: 'DIRECT_LANA_OFF' };
    units = [noCompany(OFF)];
    await open();
    await screen.findByTestId('no-company-note');
    fireEvent.click(lanaOnlineTile()!);
    expect(await screen.findByText(`LANA-ONLINE-TAB noCompany=true direct=${JSON.stringify(OFF)}`)).toBeInTheDocument();
    expect(screen.queryByTestId('no-company-lana-closed')).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t('purchase.unitNoPayoutAccount'))).not.toBeInTheDocument();
  });

  for (const reason of ['WALLET_INVALID', 'PAYEE_FROZEN', 'RATE_UNAVAILABLE', 'MARGIN_INVALID']) {
    it(`${reason}: its own notice, no tile`, async () => {
      units = [noCompany({ enabled: false, reason })];
      await open();
      expect(await screen.findByTestId('direct-lana-notice')).toHaveTextContent(i18n.t(`directLana.notice.${reason}`));
      expect(directTile()).not.toBeInTheDocument();
      expect(brainLanaTile()).not.toBeInTheDocument();
    });
  }

  it('any other reason: the general notice', async () => {
    units = [noCompany({ enabled: false, reason: 'UNIT_AUTHOR_MISMATCH' })];
    await open();
    expect(await screen.findByTestId('direct-lana-notice')).toHaveTextContent(i18n.t('directLana.notice.OTHER'));
    expect(directTile()).not.toBeInTheDocument();
  });

  it('a wallet to fix says where: shop.lanapays.us (English and Slovenian)', () => {
    expect(i18n.t('directLana.notice.WALLET_INVALID', { lng: 'en' })).toContain('shop.lanapays.us');
    expect(i18n.t('directLana.notice.WALLET_INVALID', { lng: 'sl' })).toContain('shop.lanapays.us');
  });
});

describe('never both LANA buttons, never for a shop with a company', () => {
  it('a shop with a company: the brain\'s LANA tiles, no direct tile, even if an answer claimed one', async () => {
    units = [{ ...companyUnit, direct_lana: ON }];
    await open();
    await waitFor(() => expect(brainLanaTile()).toBeInTheDocument());
    expect(lanaOnlineTile()).toBeInTheDocument();
    expect(directTile()).not.toBeInTheDocument();
    expect(directNotice()).not.toBeInTheDocument();
  });

  it('a shop without a company and no direct_lana field (an older server): no direct tile', async () => {
    const { direct_lana, ...older } = noCompany(ON);
    void direct_lana;
    units = [older];
    await open();
    expect(await screen.findByTestId('no-company-note')).toBeInTheDocument();
    expect(directTile()).not.toBeInTheDocument();
    expect(directNotice()).not.toBeInTheDocument();
  });
});

describe('a change reaches the till by itself with the next poll', () => {
  async function nextPoll() {
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  }

  it('switched on: the tile comes; the wallet frozen: the tile goes and the notice comes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    units = [noCompany({ enabled: false, reason: 'DIRECT_LANA_OFF' })];
    await open();
    await screen.findByTestId('no-company-note');
    expect(directTile()).not.toBeInTheDocument();

    units = [noCompany(ON)];
    await nextPoll();
    await waitFor(() => expect(directTile()).toBeInTheDocument());

    units = [noCompany({ enabled: false, reason: 'PAYEE_FROZEN' })];
    await nextPoll();
    await waitFor(() => expect(directNotice()).toHaveTextContent(i18n.t('directLana.notice.PAYEE_FROZEN')));
    expect(directTile()).not.toBeInTheDocument();
  });

  it('an open direct tab is not taken away when its button turns off: a payment may still be answered there', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    fireEvent.click(await screen.findByTestId('direct-lana-tile'));
    expect(await screen.findByText(/DIRECT-LANA-TAB/)).toBeInTheDocument();

    units = [noCompany({ enabled: false, reason: 'PAYEE_FROZEN' })];
    await nextPoll();
    expect(screen.getByText(/DIRECT-LANA-TAB/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(i18n.t('common.back')));
    await waitFor(() => expect(directNotice()).toBeInTheDocument());
    expect(directTile()).not.toBeInTheDocument();
  });
});
