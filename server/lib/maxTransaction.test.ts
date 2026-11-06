/**
 * Server-side twin of the cash clamp — the authoritative backstop in the
 * purchase proxy. Cases mirror src/lib/max-tx.test.ts where the semantics
 * are shared, plus the merge/quota logic that only exists here.
 */
import { describe, it, expect } from 'vitest';
import { computeEffectiveMax, foldQuotaRemaining, foldCustomerWindow, clampCashAmount, exceedsVolumeLimit } from './maxTransaction';

describe('computeEffectiveMax', () => {
  it('merchant only', () => {
    expect(computeEffectiveMax({ merchantLimit: 500, fundLimit: null, defaultLimit: 0 }))
      .toEqual({ maxAmount: 500, source: 'merchant' });
  });
  it('fund only', () => {
    expect(computeEffectiveMax({ merchantLimit: null, fundLimit: 800, defaultLimit: 0 }))
      .toEqual({ maxAmount: 800, source: 'fund' });
  });
  it('both → the smaller wins with the right source', () => {
    expect(computeEffectiveMax({ merchantLimit: 500, fundLimit: 800, defaultLimit: 0 }))
      .toEqual({ maxAmount: 500, source: 'merchant' });
    expect(computeEffectiveMax({ merchantLimit: 900, fundLimit: 800, defaultLimit: 0 }))
      .toEqual({ maxAmount: 800, source: 'fund' });
  });
  it('a lower default overrides', () => {
    expect(computeEffectiveMax({ merchantLimit: 500, fundLimit: 800, defaultLimit: 300 }))
      .toEqual({ maxAmount: 300, source: 'default' });
  });
  it('default 0 means not configured', () => {
    expect(computeEffectiveMax({ merchantLimit: null, fundLimit: null, defaultLimit: 0 }))
      .toEqual({ maxAmount: null, source: 'none' });
  });
  it('fund 0 is a REAL 0 (no budget available), not null', () => {
    expect(computeEffectiveMax({ merchantLimit: null, fundLimit: 0, defaultLimit: 0 }))
      .toEqual({ maxAmount: 0, source: 'fund' });
  });
});

describe('foldQuotaRemaining', () => {
  const unit = { quota_volume_limit: 1000, quota_volume_used: 700, quota_currency: 'EUR', currency: 'EUR' };

  it('same currency reduces the max to the remaining volume', () => {
    expect(foldQuotaRemaining(500, unit, 'EUR')).toBe(300);
  });
  it('remaining above the max leaves the max alone', () => {
    expect(foldQuotaRemaining(200, unit, 'EUR')).toBe(200);
  });
  it('cross-currency is left to the brain (untouched)', () => {
    expect(foldQuotaRemaining(500, unit, 'GBP')).toBe(500);
  });
  it('no quota configured → untouched', () => {
    expect(foldQuotaRemaining(500, { quota_volume_limit: 0 }, 'EUR')).toBe(500);
    expect(foldQuotaRemaining(500, null, 'EUR')).toBe(500);
  });
  it('quota fully used → 0 (which the clamp refuses, so it stays a block)', () => {
    expect(foldQuotaRemaining(500, { ...unit, quota_volume_used: 1200 }, 'EUR')).toBe(0);
  });
  it('null max with a quota becomes the remaining volume', () => {
    expect(foldQuotaRemaining(null, unit, 'EUR')).toBe(300);
  });
  it('a hair under the limit is nothing left to charge: refused, not sent on as 0', () => {
    const at = { ...unit, quota_volume_limit: 3000, quota_volume_used: 2999.9999999999995 };
    expect(foldQuotaRemaining(500, at, 'EUR')).toBe(0);
    expect(clampCashAmount(100, foldQuotaRemaining(500, at, 'EUR'))).toEqual({ amount: 100, adjusted: false });
    expect(exceedsVolumeLimit(at.quota_volume_used, 100, 3000)).toBe(true);
    expect(exceedsVolumeLimit(at.quota_volume_used, 0.01, 3000)).toBe(true);
  });
  it('a hair over a whole cent: what remains is charged, and the pre-flight lets it through', () => {
    const at = { ...unit, quota_volume_limit: 3000, quota_volume_used: 2930.2100000000005 };
    const remaining = foldQuotaRemaining(500, at, 'EUR');
    expect(remaining).toBe(69.79);
    expect(at.quota_volume_used + 69.79 > 3000).toBe(true); // what a bare comparison sees
    expect(clampCashAmount(69.79, remaining)).toEqual({ amount: 69.79, adjusted: false });
    expect(exceedsVolumeLimit(at.quota_volume_used, 69.79, 3000)).toBe(false);
    expect(clampCashAmount(69.8, remaining)).toEqual({ amount: 69.79, adjusted: true });
    expect(exceedsVolumeLimit(at.quota_volume_used, 69.8, 3000)).toBe(true);
  });
  it('whatever a counter holds, what remains always passes the pre-flight it is checked by', () => {
    // Whole cents, a fraction of a cent, half a cent, and sums of floats.
    const counters = [2930.214, 2930.185, 2930.2100000000005, 2930.2099999999996, 0.004, 0.005, 2999.994, 2999.995, 2999.99];
    for (let n = 0; n < 3000; n++) counters.push(n + (n % 1000) / 1000);
    let sum = 0;
    for (let n = 0; n < 2000; n++) { sum += ((n * 37) % 15000) / 100; if (sum < 3000) counters.push(sum); }
    for (const used of counters) {
      const remaining = foldQuotaRemaining(null, { ...unit, quota_volume_limit: 3000, quota_volume_used: used }, 'EUR') as number;
      if (remaining > 0) expect(exceedsVolumeLimit(used, remaining, 3000), `used ${used}, remaining ${remaining}`).toBe(false);
      // ...and it is never more than half a cent over the limit.
      expect(used + remaining).toBeLessThanOrEqual(3000.005 + 1e-9);
    }
  });
});

describe('exceedsVolumeLimit', () => {
  it('compares in cents, the same comparison as the brain', () => {
    expect(exceedsVolumeLimit(295, 5, 300)).toBe(false);
    expect(exceedsVolumeLimit(295, 5.01, 300)).toBe(true);
    expect(exceedsVolumeLimit(301, 1, 300)).toBe(true);
    expect(exceedsVolumeLimit(2930.2100000000005, 69.79, 3000)).toBe(false);
    expect(exceedsVolumeLimit(2930.214, 69.79, 3000)).toBe(false);
  });
});

describe('foldCustomerWindow', () => {
  it('a smaller customer remainder tightens the max', () => {
    expect(foldCustomerWindow(200, 150)).toBe(150);
  });
  it('a larger remainder leaves the max alone', () => {
    expect(foldCustomerWindow(100, 150)).toBe(100);
  });
  it('null max takes the remainder', () => {
    expect(foldCustomerWindow(null, 150)).toBe(150);
  });
  it('null remainder (fail-open) leaves the max alone', () => {
    expect(foldCustomerWindow(200, null)).toBe(200);
  });
  it('remainder 0 propagates — the caller blocks BEFORE clamping', () => {
    // clampCashAmount refuses maxTx <= 0, so 0 here must be handled by the
    // caller's explicit CUSTOMER_WINDOW_EXCEEDED block, not by the clamp.
    expect(foldCustomerWindow(200, 0)).toBe(0);
  });
});

describe('clampCashAmount (server twin)', () => {
  it('at the limit → untouched', () => {
    expect(clampCashAmount(500, 500)).toEqual({ amount: 500, adjusted: false });
  });
  it('above → clamped to the limit', () => {
    expect(clampCashAmount(1000, 500)).toEqual({ amount: 500, adjusted: true });
  });
  it('null / zero limit never clamps', () => {
    expect(clampCashAmount(1000, null)).toEqual({ amount: 1000, adjusted: false });
    expect(clampCashAmount(1000, 0)).toEqual({ amount: 1000, adjusted: false });
  });
  it('fractional limit clamps to cents', () => {
    expect(clampCashAmount(600, 499.999)).toEqual({ amount: 500, adjusted: true });
  });
});
