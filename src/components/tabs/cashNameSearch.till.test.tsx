/**
 * A cash sale to a customer found BY NAME (Brilly 24 Nov 2026): the same
 * directory search as the Regular customers tab, inside the cash sale, so the
 * seller does not have to scan the card.
 *
 * The wallet on a profile is only the person's own word. The sale goes through
 * only when the registrar says that wallet is registered to this very person,
 * the same check a scanned wallet goes through; otherwise nothing is sent.
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
import en from '@/i18n/locales/en.json';
import sl from '@/i18n/locales/sl.json';
import hu from '@/i18n/locales/hu.json';
import it_ from '@/i18n/locales/it.json';
import es from '@/i18n/locales/es.json';
import pl from '@/i18n/locales/pl.json';
import pt from '@/i18n/locales/pt.json';
import de from '@/i18n/locales/de.json';
import hr from '@/i18n/locales/hr.json';
import sr from '@/i18n/locales/sr.json';
import ru from '@/i18n/locales/ru.json';
import zh from '@/i18n/locales/zh.json';

vi.mock('@/components/QRScanner', () => ({ QRScanner: () => null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: { currency: 'EUR', nostrHexId: '5e'.repeat(32) } }) }));
vi.mock('@/lib/compress-image', () => ({ compressImage: vi.fn(async (f: File) => ({ file: f })) }));

const UNIT = '8d20dd51c92f4f0ba003d33e66e23d3f';
const PERSON = '2f'.repeat(32);
const WALLET = 'LfDJmg13pwCjG3u6T6GH4Y3MUEdRuj68Nd';

/** What the registrar says about the profile's wallet. */
let registrar: { registered: boolean; hex?: string };
let purchaseCalls: any[] = [];
let searchCalls: any[] = [];

const json = (status: number, body: any) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body, clone() { return this; } } as unknown as Response);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  purchaseCalls = [];
  searchCalls = [];
  registrar = { registered: true, hex: PERSON };
  try { localStorage.clear(); } catch { /* no storage */ }
  (window as any).__selectedUnit = { currency: 'EUR', owner_hex: 'aa'.repeat(32) };
  (window as any).__maxTransactionAmount = null;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
    if (url.startsWith('/api/profile-search')) {
      searchCalls.push(JSON.parse(init.body));
      return json(200, { profiles: [
        { pubkey: PERSON, name: 'Ana Novak', lanaWalletID: WALLET },
        { pubkey: '3c'.repeat(32), name: 'Ana Brez Denarnice' },
      ] });
    }
    if (url.startsWith('/api/check-wallet')) {
      return json(200, registrar.registered
        ? { success: true, registered: true, wallet: { nostr_hex_id: registrar.hex, frozen: false } }
        : { success: true, registered: false });
    }
    if (url.startsWith('/api/brain/purchase/check-dedup')) return json(200, { duplicate: false });
    if (url.startsWith('/api/cash-sale-recorded')) return json(200, { success: true, recorded: false });
    if (url.startsWith('/api/brain/purchase')) {
      purchaseCalls.push(JSON.parse(init.body));
      return json(200, { success: true, data: { transaction_id: `t${purchaseCalls.length}` } });
    }
    if (url.startsWith('/api/regular-customers/')) return json(200, { customers: [] });
    if (url.startsWith('/api/balance/')) return json(200, { confirmed: 1, unconfirmed: 0, lana: 1, fiatValue: 1, currency: 'EUR' });
    if (url.startsWith('/api/users/by-wallet/')) return json(200, { user: null });
    return json(404, {});
  }) as any);
});

afterEach(() => {
  (window as any).__selectedUnit = undefined;
  (window as any).__maxTransactionAmount = null;
});

async function toSaleStepAndSearch() {
  render(<CashTab unitCurrency="EUR" unitId={UNIT} />);
  fireEvent.click(screen.getByText(i18n.t('cash.skipNoReceipt')));
  await screen.findByText(i18n.t('cash.scanCustomerWallet'));
  fireEvent.change(screen.getByPlaceholderText(i18n.t('cash.invoicePlaceholder')), { target: { value: 'R-77' } });
  fireEvent.change(screen.getByPlaceholderText(i18n.t('cash.amountPlaceholder')), { target: { value: '12,50' } });
  // Offered even when the unit has no regular customers yet.
  expect(screen.getByText(i18n.t('cash.orSearchProfile'))).toBeInTheDocument();
  fireEvent.click(screen.getByText(i18n.t('cash.searchProfileButton')));
  fireEvent.change(screen.getByPlaceholderText(i18n.t('cash.searchProfilePlaceholder')), { target: { value: 'ana' } });
  return screen.findByText('Ana Novak');
}

describe('cash sale to a customer found by name', () => {
  it('sells to the person when the registrar says the wallet is theirs', async () => {
    const hit = await toSaleStepAndSearch();
    expect(searchCalls).toEqual([{ search: 'ana' }]);
    // A profile without a wallet cannot be sold to, so it is not offered.
    expect(screen.queryByText('Ana Brez Denarnice')).not.toBeInTheDocument();

    fireEvent.click(hit);
    await waitFor(() => expect(purchaseCalls).toHaveLength(1));
    expect(purchaseCalls[0]).toMatchObject({
      unit_id: UNIT, payment_type: 'cash', customer_hex: PERSON, customer_wallet: WALLET,
      customer_name: 'Ana Novak', amount: 12.5, currency: 'EUR', invoice_number: 'R-77',
    });
    await screen.findByText(i18n.t('cash.confirmedTitle'));
  });

  it('sends nothing when the wallet on the profile is registered to someone else', async () => {
    registrar = { registered: true, hex: '9b'.repeat(32) };
    fireEvent.click(await toSaleStepAndSearch());
    await screen.findByText(i18n.t('cash.searchProfileNotRegistered'));
    expect(purchaseCalls).toHaveLength(0);
  });

  it('sends nothing when the wallet on the profile is not registered at all', async () => {
    registrar = { registered: false };
    fireEvent.click(await toSaleStepAndSearch());
    await screen.findByText(i18n.t('cash.searchProfileNotRegistered'));
    expect(purchaseCalls).toHaveLength(0);
  });
});

describe('the name-search texts', () => {
  const LOCALES: Record<string, Record<string, string>> = { en, sl, hu, it: it_, es, pl, pt, de, hr, sr, ru, zh };
  const KEYS = [
    'cash.orSearchProfile', 'cash.searchProfileButton', 'cash.searchProfilePlaceholder',
    'cash.searchProfileNoResults', 'cash.searchProfileNotRegistered', 'cash.searchProfileClose',
  ];
  it.each(Object.keys(LOCALES))('are all present and translated in %s', (lang) => {
    for (const k of KEYS) {
      expect(typeof LOCALES[lang][k], `${lang} ${k}`).toBe('string');
      expect(LOCALES[lang][k].trim().length, `${lang} ${k}`).toBeGreaterThan(0);
      if (lang !== 'en') expect(LOCALES[lang][k], `${lang} ${k} is still English`).not.toBe((en as Record<string, string>)[k]);
    }
  });
});
