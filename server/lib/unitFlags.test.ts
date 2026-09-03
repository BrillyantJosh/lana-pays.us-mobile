import { describe, it, expect } from 'vitest';
import { isOnlineShopUnit } from './unitFlags.js';

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
