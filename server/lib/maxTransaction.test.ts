/**
 * Server-side twin of the cash clamp — the authoritative backstop in the
 * purchase proxy. Cases mirror src/lib/max-tx.test.ts where the semantics
 * are shared, plus the merge/quota logic that only exists here.
 */
import { describe, it, expect } from 'vitest';
import { computeEffectiveMax, foldQuotaRemaining, clampCashAmount } from './maxTransaction';

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
