// @vitest-environment node
/**
 * GET /api/business-units: what the till is told about each unit (lib/tillUnitView.ts).
 *
 * The mapping moved out of index.ts on 23 Nov 2026. `beforeThisChange` below is
 * the code index.ts ran until then, copied as it was, and every old unit must
 * come out of the new code as the SAME bytes. A unit without a company
 * (payout_account "none") additionally carries payout_account, margin_percent
 * and its wallet, and has nothing about a bank to fix.
 */
import { describe, it, expect } from 'vitest';
import { tillUnitView, payoutConfigured } from './tillUnitView.js';
import { checkPayoutData } from './payoutDataCheck.js';
import { isOnlineShopUnit } from './unitFlags.js';

/** index.ts, GET /api/business-units/:hexId, before 23 Nov 2026 — verbatim. */
function beforeThisChange(units: any[]): any[] {
  const hasPayout = (u: any): boolean => {
    try {
      const ev = JSON.parse(u.raw_event || '{}');
      const tag = (ev.tags || []).find((t: any[]) => t[0] === 'payment_scheme_fields');
      if (tag && tag[1]) {
        const f = JSON.parse(tag[1]);
        if (f && typeof f === 'object' && Object.values(f).some(v => String(v ?? '').trim() !== '')) {
          return true;
        }
      }
    } catch { /* fall through to legacy / false */ }
    return !!(u.bank_account && String(u.bank_account).trim() !== '');
  };

  return units.map((u) => {
    const { raw_event, bank_account, ...rest } = u;
    let tags: any[] = [];
    try { tags = JSON.parse(raw_event || '{}').tags || []; } catch { tags = []; }
    const payout = checkPayoutData(tags);
    const simple = tags.some((t: any[]) => Array.isArray(t) && t[0] === 'unit_type' && t[1] === 'simple.lanapays.us');
    return {
      ...rest,
      payout_configured: hasPayout({ raw_event, bank_account }),
      online_shop: isOnlineShopUnit(raw_event),
      payout_problems: payout.problems,
      payout_advice: payout.advice,
      payout_fix_url: simple ? 'https://simple.lanapays.us' : 'https://shop.lanapays.us',
    };
  });
}

// A well-formed test IBAN (check digits valid), not anybody's account.
const GOOD_IBAN = 'SI56 1920 0123 4567 892';
const WALLET = 'LbtLTSACAREiT513CVNpbg6NeE5cFbrhkC';

/** A row as the route selects it. */
function row(tags: string[][] | null, over: Record<string, unknown> = {}) {
  return {
    unit_id: 'u'.repeat(32), name: 'Kmetija Novak', owner_hex: 'a'.repeat(64), authorized_hex: '[]',
    category: 'Food', category_detail: 'Eggs', currency: 'EUR', country: 'SI', image: null, logo: null,
    status: 'active', receiver_city: 'Ljubljana', lanapays_payout_method: 'fiat',
    suspension_status: 'active', suspension_reason: null, suspension_until: null, suspension_content: null,
    quota_volume_used: 0, quota_volume_limit: 300, quota_tx_used: 0, quota_tx_limit: 5,
    quota_currency: 'EUR', quota_period: '2026-11', updated_at: '2026-11-23 08:00:00',
    bank_account: null,
    raw_event: tags === null ? null : JSON.stringify({ kind: 30901, tags, content: '' }),
    ...over,
  };
}

const company = [
  ['d', 'u1'], ['name', 'Kmetija Novak'], ['receiver_name', 'Novak d.o.o.'], ['receiver_type', 'company'],
  ['receiver_address', 'Cesta 1'], ['receiver_zip', '1000'], ['receiver_city', 'Ljubljana'], ['receiver_country', 'SI'],
  ['payment_scheme', 'EU.IBAN'], ['payment_scheme_fields', JSON.stringify({ iban: GOOD_IBAN, account_holder: 'Novak d.o.o.' })],
  ['lanapays_payout_method', 'fiat'],
];

/** Every kind of unit that exists today, none with the new tag. */
const OLD_UNITS: Array<[string, any]> = [
  ['a company with a complete IBAN', row(company)],
  ['a person paid to a personal account, legacy bank_account column only', row([['d', 'u1'], ['receiver_type', 'person']], { bank_account: GOOD_IBAN })],
  ['no bank and no address at all (the bank would refuse it)', row([['d', 'u1'], ['name', 'Shop']])],
  ['an account holder alone counts as payout data, as before', row([['payment_scheme_fields', JSON.stringify({ account_holder: 'Ana' })]])],
  ['a simple.lanapays.us unit', row([['d', 'u1'], ['unit_type', 'simple.lanapays.us'], ['lana_only', 'true']])],
  ['an online seller', row([...company, ['online_shop', 'true']])],
  ['a reward paid in LANA, with its wallet', row([...company, ['lanapays_payout_method', 'lana'], ['lanapays_payout_wallet', WALLET]], { lanapays_payout_method: 'lana' })],
  ['raw_event missing', row(null)],
  ['raw_event unreadable', row(null, { raw_event: '{not json' })],
  ['payout_account with any other value', row([...company, ['payout_account', 'bank']])],
  ['payout_account "None" (not the exact value)', row([...company, ['payout_account', 'None']])],
  ['a margin without payout_account means nothing', row([...company, ['margin_percent', '10']])],
];

describe('every old unit: the same answer, byte for byte', () => {
  it.each(OLD_UNITS)('%s', (_label, unit) => {
    const now = JSON.stringify(tillUnitView(unit));
    const before = JSON.stringify(beforeThisChange([unit])[0]);
    expect(now).toBe(before);
    expect(now).not.toContain('payout_account');
    expect(now).not.toContain('margin_percent');
    expect(now).not.toContain('lanapays_payout_wallet');
  });

  it('a whole list, in one go, as the route maps it', () => {
    const units = OLD_UNITS.map(([, u]) => u);
    expect(JSON.stringify(units.map(u => tillUnitView(u)))).toBe(JSON.stringify(beforeThisChange(units)));
  });

  it('the raw event and the bank account never leave the server', () => {
    for (const [, u] of OLD_UNITS) {
      const view = tillUnitView(u);
      expect(view).not.toHaveProperty('raw_event');
      expect(view).not.toHaveProperty('bank_account');
      expect(JSON.stringify(view)).not.toContain('1920 0123');
    }
  });
});

describe('a shop without a company and without a bank account', () => {
  const noCompany = (extra: string[][] = []) => row([
    ['d', 'u1'], ['name', 'Kmetija Novak'], ['payout_account', 'none'], ['margin_percent', '10'],
    ['receiver_address', 'Cesta 1'], ['receiver_zip', '1000'], ['receiver_city', 'Ljubljana'], ['receiver_country', 'SI'],
    ['lanapays_payout_method', 'lana'], ['lanapays_payout_wallet', WALLET], ['online_shop', 'false'],
    ...extra,
  ], { lanapays_payout_method: 'lana' });

  it('carries payout_account, its margin and its wallet', () => {
    const view = tillUnitView(noCompany());
    expect(view.payout_account).toBe('none');
    expect(view.margin_percent).toBe(10);
    expect(view.lanapays_payout_wallet).toBe(WALLET);
  });

  it('has nothing about a bank to fix, although the bank-file rules would list it', () => {
    const unit = noCompany();
    expect(checkPayoutData(JSON.parse(unit.raw_event as string).tags).problems.length).toBeGreaterThan(0);
    const view = tillUnitView(unit);
    expect(view.payout_problems).toEqual([]);
    expect(view.payout_advice).toEqual([]);
  });

  it('keeps every other field as before (payout_configured is still the honest false)', () => {
    const unit = noCompany();
    const view = tillUnitView(unit);
    const before = beforeThisChange([unit])[0];
    for (const key of Object.keys(before)) {
      if (key === 'payout_problems' || key === 'payout_advice') continue;
      expect(view[key], key).toEqual(before[key]);
    }
    expect(view.payout_configured).toBe(false);
    expect(view.online_shop).toBe(false);
    expect(view).not.toHaveProperty('raw_event');
    expect(view).not.toHaveProperty('bank_account');
  });

  it('a margin it cannot read is null (no direct LANA sale), never a guess', () => {
    const unit = row([['d', 'u1'], ['payout_account', 'none'], ['margin_percent', '25']]);
    expect(tillUnitView(unit).margin_percent).toBeNull();
    const two = row([['d', 'u1'], ['payout_account', 'none'], ['margin_percent', '5'], ['margin_percent', '6']]);
    expect(tillUnitView(two).margin_percent).toBeNull();
    // Absent is 0.
    expect(tillUnitView(row([['d', 'u1'], ['payout_account', 'none']])).margin_percent).toBe(0);
  });

  it('no wallet named: null', () => {
    expect(tillUnitView(row([['d', 'u1'], ['payout_account', 'none']])).lanapays_payout_wallet).toBeNull();
  });
});

describe('payoutConfigured — unchanged', () => {
  it('reads the scheme fields, then the legacy column', () => {
    expect(payoutConfigured(JSON.stringify({ tags: [['payment_scheme_fields', JSON.stringify({ iban: GOOD_IBAN })]] }), null)).toBe(true);
    expect(payoutConfigured(JSON.stringify({ tags: [] }), GOOD_IBAN)).toBe(true);
    expect(payoutConfigured(JSON.stringify({ tags: [] }), '  ')).toBe(false);
    expect(payoutConfigured(null, null)).toBe(false);
    expect(payoutConfigured('{not json', GOOD_IBAN)).toBe(true);
  });
});
