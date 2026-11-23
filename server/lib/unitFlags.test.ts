import { describe, it, expect } from 'vitest';
import { isOnlineShopUnit, isNoPayoutAccountUnit, isStrictNoPayoutAccountUnit, unitMarginPercent, unitPayoutWallet, MAX_MARGIN_PERCENT } from './unitFlags.js';

const ev = (tags: string[][]) => JSON.stringify({ kind: 30901, tags, content: '' });

describe('isOnlineShopUnit — the Orders tile gate', () => {
  it('is true only for an exact online_shop=true tag', () => {
    expect(isOnlineShopUnit(ev([['d', 'u1'], ['online_shop', 'true']]))).toBe(true);
  });

  it('is false when the merchant switched it off', () => {
    expect(isOnlineShopUnit(ev([['online_shop', 'false']]))).toBe(false);
  });

  it('is false when the tag is absent (a unit that never opted in)', () => {
    expect(isOnlineShopUnit(ev([['d', 'u1'], ['name', 'Shop']]))).toBe(false);
  });

  it('THE PREFIX TRAP: a shipping fee alone does not mean the unit sells online', () => {
    // online_shop_shipping_fee / online_shop_free_shipping_from share the prefix.
    // A substring or startsWith match here would show the Orders tile to every
    // merchant who ever typed a shipping fee and then switched selling off.
    expect(isOnlineShopUnit(ev([
      ['online_shop_shipping_fee', '2.50'],
      ['online_shop_free_shipping_from', '50.00'],
      ['online_shop_pickup', 'true'],
    ]))).toBe(false);
  });

  it('is false for a value that is not exactly "true" (matches the shop parser)', () => {
    expect(isOnlineShopUnit(ev([['online_shop', 'TRUE']]))).toBe(false);
    expect(isOnlineShopUnit(ev([['online_shop', '1']]))).toBe(false);
    expect(isOnlineShopUnit(ev([['online_shop']]))).toBe(false);
  });

  it('is undefined — never false — when we cannot tell', () => {
    // undefined ⇒ the key is dropped from the JSON ⇒ the client shows the tile.
    // Reporting false here would hide a real delivery obligation.
    expect(isOnlineShopUnit(undefined)).toBeUndefined();
    expect(isOnlineShopUnit(null)).toBeUndefined();
    expect(isOnlineShopUnit('')).toBeUndefined();
    expect(isOnlineShopUnit('   ')).toBeUndefined();
    expect(isOnlineShopUnit('{not json')).toBeUndefined();
    expect(isOnlineShopUnit('"a string"')).toBeUndefined();
    expect(isOnlineShopUnit(JSON.stringify({ kind: 30901 }))).toBeUndefined();
    expect(isOnlineShopUnit(JSON.stringify({ tags: 'nope' }))).toBeUndefined();
  });

  it('ignores malformed tag entries instead of throwing', () => {
    expect(isOnlineShopUnit(JSON.stringify({ tags: [null, 5, ['online_shop', 'true']] }))).toBe(true);
    expect(isOnlineShopUnit(JSON.stringify({ tags: [null, 5] }))).toBe(false);
  });
});

// The cases a reader cannot tell, shared by the three readers below: none of
// them may answer as if it had read a tag.
const UNREADABLE: unknown[] = [
  undefined, null, '', '   ', '{not json', '"a string"',
  JSON.stringify({ kind: 30901 }), JSON.stringify({ tags: 'nope' }),
];

describe('isNoPayoutAccountUnit — a shop without a company and without a bank account (KIND 30901 v1.4.0)', () => {
  it('is true only for an exact payout_account=none tag', () => {
    expect(isNoPayoutAccountUnit(ev([['d', 'u1'], ['payout_account', 'none']]))).toBe(true);
  });

  it('is false for every unit as it was before the tag existed (old units stay exactly as they are)', () => {
    expect(isNoPayoutAccountUnit(ev([['d', 'u1'], ['name', 'Shop'], ['bank_account', 'SI56 1910 0000 0123 438']]))).toBe(false);
    expect(isNoPayoutAccountUnit(ev([['receiver_type', 'person']]))).toBe(false);
  });

  it('matches name and value exactly, as the shop writes them: no other value means "none"', () => {
    for (const value of ['None', 'NONE', ' none', 'none ', 'no', 'false', '', 'bank']) {
      expect(isNoPayoutAccountUnit(ev([['payout_account', value]])), value).toBe(false);
    }
    expect(isNoPayoutAccountUnit(ev([['payout_account']]))).toBe(false);
    // A prefix is not the tag.
    expect(isNoPayoutAccountUnit(ev([['payout_account_type', 'none']]))).toBe(false);
  });

  it('never borrows the markers the fleet already uses for other things', () => {
    // cash_only names a Direct.Fund investor; lana_only / unit_type are Simple's.
    expect(isNoPayoutAccountUnit(ev([['cash_only', 'true']]))).toBe(false);
    expect(isNoPayoutAccountUnit(ev([['lana_only', 'true'], ['unit_type', 'simple.lanapays.us']]))).toBe(false);
  });

  it('two payout_account tags that disagree: one "none" is enough (refusing LANA moves no money)', () => {
    expect(isNoPayoutAccountUnit(ev([['payout_account', 'bank'], ['payout_account', 'none']]))).toBe(true);
    expect(isNoPayoutAccountUnit(ev([['payout_account', 'none'], ['payout_account', 'bank']]))).toBe(true);
  });

  it('is undefined when it cannot tell, and ignores malformed entries', () => {
    for (const raw of UNREADABLE) expect(isNoPayoutAccountUnit(raw)).toBeUndefined();
    expect(isNoPayoutAccountUnit(JSON.stringify({ tags: [null, 5, 'x', ['payout_account', 'none']] }))).toBe(true);
    expect(isNoPayoutAccountUnit(JSON.stringify({ tags: [null, 5] }))).toBe(false);
  });
});

describe('unitMarginPercent — the KIND 30905 reading of margin_percent, for direct LANA sales only', () => {
  const margin = (...values: Array<string | undefined>) =>
    unitMarginPercent(ev([['d', 'u1'], ...values.map(v => (v === undefined ? ['margin_percent'] : ['margin_percent', v]))]));

  it('absent, empty or "0" is 0', () => {
    expect(unitMarginPercent(ev([['d', 'u1']]))).toBe(0);
    expect(margin('')).toBe(0);
    expect(margin('   ')).toBe(0);
    expect(margin('0')).toBe(0);
    expect(margin(undefined)).toBe(0);
  });

  it('every whole percent from 1 to 20 as written', () => {
    expect(MAX_MARGIN_PERCENT).toBe(20);
    for (let m = 1; m <= 20; m++) expect(margin(String(m))).toBe(m);
    // Trimmed, as the 30905 reader trims.
    expect(margin(' 10 ')).toBe(10);
  });

  it('anything else is null: such a unit takes no direct LANA sale (fail closed)', () => {
    for (const value of ['21', '100', '-1', '-0', '01', '00', '10.0', '10.5', '1e1', '10%', 'ten', '+5', '0x10', '２']) {
      expect(margin(value), value).toBeNull();
    }
  });

  it('two margin_percent tags say two prices: neither is taken', () => {
    expect(margin('10', '10')).toBeNull();
    expect(margin('10', '20')).toBeNull();
  });

  it('a value that is not text is null', () => {
    expect(unitMarginPercent(JSON.stringify({ tags: [['margin_percent', 10]] }))).toBeNull();
  });

  it('is undefined when it cannot tell', () => {
    for (const raw of UNREADABLE) expect(unitMarginPercent(raw)).toBeUndefined();
  });
});

describe('unitPayoutWallet — the one wallet the unit names', () => {
  const W1 = 'LbtLTSACAREiT513CVNpbg6NeE5cFbrhkC';
  const W2 = 'LN4sFqQS2w3LiFmjMRVMvYPDuU9gsJpxef';

  it('the one wallet named, trimmed', () => {
    expect(unitPayoutWallet(ev([['lanapays_payout_wallet', W1]]))).toBe(W1);
    expect(unitPayoutWallet(ev([['lanapays_payout_wallet', ` ${W1} `]]))).toBe(W1);
    // The same wallet twice is still one wallet.
    expect(unitPayoutWallet(ev([['lanapays_payout_wallet', W1], ['lanapays_payout_wallet', W1]]))).toBe(W1);
  });

  it('none, an empty one, or two different ones: null, never a guess about where money goes', () => {
    expect(unitPayoutWallet(ev([['d', 'u1']]))).toBeNull();
    expect(unitPayoutWallet(ev([['lanapays_payout_wallet', '']]))).toBeNull();
    expect(unitPayoutWallet(ev([['lanapays_payout_wallet']]))).toBeNull();
    expect(unitPayoutWallet(ev([['lanapays_payout_wallet', W1], ['lanapays_payout_wallet', W2]]))).toBeNull();
  });

  it('is undefined when it cannot tell', () => {
    for (const raw of UNREADABLE) expect(unitPayoutWallet(raw)).toBeUndefined();
  });
});

describe('isStrictNoPayoutAccountUnit: the gate of LANA neposredno reads option (c) exactly', () => {
  /** What shop.lanapays.us option (c) signs (BusinessUnitForm and Fast Onboarding). */
  const c = [
    ['d', 'u1'], ['name', 'Kmetija Novak'], ['receiver_address', 'Glavna 1'], ['receiver_zip', '1000'],
    ['receiver_city', 'Ljubljana'], ['receiver_country', 'SI'], ['lanapays_payout_method', 'lana'],
    ['online_shop', 'false'], ['online_shop_shipping_fee', '0.00'], ['payout_account', 'none'], ['margin_percent', '10'],
    ['lanapays_payout_wallet', 'LbtLTSACAREiT513CVNpbg6NeE5cFbrhkC'],
  ];
  const without = (name: string) => c.filter(t => t[0] !== name);

  it('the form\'s own event is one; so is one without an online_shop tag (absent = no online shop)', () => {
    expect(isStrictNoPayoutAccountUnit(ev(c))).toBe(true);
    expect(isStrictNoPayoutAccountUnit(ev(without('online_shop')))).toBe(true);
  });

  it('one "none" among other payout_account tags is not one (it is enough to CLOSE a door, not to open this one)', () => {
    const two = ev([['payout_account', 'bank'], ...c]);
    expect(isNoPayoutAccountUnit(two)).toBe(true);
    expect(isStrictNoPayoutAccountUnit(two)).toBe(false);
    expect(isStrictNoPayoutAccountUnit(ev([...c, ['payout_account', 'none']]))).toBe(false);
    expect(isStrictNoPayoutAccountUnit(ev([...without('payout_account'), ['payout_account', 'None']]))).toBe(false);
  });

  it.each([
    'receiver_name', 'receiver_type', 'receiver_register', 'receiver_tax_number', 'receiver_registration_number',
    'bank_name', 'bank_address', 'bank_country', 'bank_swift', 'bank_account',
    'payment_scheme', 'payment_scheme_label', 'payment_scheme_fields', 'Receiver_Name', 'BANK_ACCOUNT',
  ])('a %s tag beside it, even empty: not one', (name) => {
    expect(isStrictNoPayoutAccountUnit(ev([...c, [name, '']]))).toBe(false);
    expect(isStrictNoPayoutAccountUnit(ev([...c, [name, 'x']]))).toBe(false);
  });

  it('its reward method must be exactly one "lana"', () => {
    expect(isStrictNoPayoutAccountUnit(ev(without('lanapays_payout_method')))).toBe(false);
    expect(isStrictNoPayoutAccountUnit(ev([...without('lanapays_payout_method'), ['lanapays_payout_method', 'fiat']]))).toBe(false);
    expect(isStrictNoPayoutAccountUnit(ev([...c, ['lanapays_payout_method', 'lana']]))).toBe(false);
  });

  it('an online shop, or an online_shop that is not "false": not one', () => {
    for (const v of ['true', 'TRUE', '', 'no']) {
      expect(isStrictNoPayoutAccountUnit(ev([...without('online_shop'), ['online_shop', v]])), v).toBe(false);
    }
  });

  it('an event that cannot be read: not one', () => {
    expect(isStrictNoPayoutAccountUnit(undefined)).toBe(false);
    expect(isStrictNoPayoutAccountUnit('{not json')).toBe(false);
    expect(isStrictNoPayoutAccountUnit(JSON.stringify({ kind: 30901 }))).toBe(false);
  });
});
