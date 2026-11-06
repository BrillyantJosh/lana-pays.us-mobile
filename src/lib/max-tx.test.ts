/**
 * THE RULE: a cash invoice above the limit is ADJUSTED, never blocked —
 * and what must NOT happen matters as much as what must: no clamp without a
 * known positive limit, and clamping to 0 is forbidden (that state is a
 * BLOCK, because silently charging nothing would be worse than either).
 */
import { describe, it, expect } from 'vitest';
import { parseAmountInput, clampCashAmount, cashBlockReason, round2 } from './max-tx';

describe('clampCashAmount', () => {
  it('exactly AT the limit is not an adjustment', () => {
    expect(clampCashAmount(500, 500)).toEqual({ amount: 500, adjusted: false });
  });

  it('just above clamps to the limit', () => {
    expect(clampCashAmount(500.01, 500)).toEqual({ amount: 500, adjusted: true });
  });

  it('the reported scenario: limit 500, invoice 1000 → charged 500', () => {
    expect(clampCashAmount(1000, 500)).toEqual({ amount: 500, adjusted: true });
  });

  it('below the limit passes through untouched', () => {
    expect(clampCashAmount(499.99, 500)).toEqual({ amount: 499.99, adjusted: false });
  });

  it('no known limit (null/undefined) never adjusts', () => {
    expect(clampCashAmount(1000000, null)).toEqual({ amount: 1000000, adjusted: false });
    expect(clampCashAmount(1000000, undefined)).toEqual({ amount: 1000000, adjusted: false });
  });

  it('a zero or negative limit never adjusts — that state is a BLOCK elsewhere', () => {
    expect(clampCashAmount(100, 0)).toEqual({ amount: 100, adjusted: false });
    expect(clampCashAmount(100, -5)).toEqual({ amount: 100, adjusted: false });
  });

  it('a fractional limit is rounded to cents on clamp', () => {
    expect(clampCashAmount(600, 499.999)).toEqual({ amount: 500, adjusted: true });
  });
});

describe('cashBlockReason', () => {
  const unit = { currency: 'EUR', quota_currency: 'EUR', quota_volume_limit: 3000, quota_volume_used: 500, quota_tx_limit: 50, quota_tx_used: 5 };

  it('nothing in the way', () => {
    expect(cashBlockReason(unit, 200)).toBeNull();
    expect(cashBlockReason(unit, null)).toBeNull();
    expect(cashBlockReason(null, 200)).toBeNull();
  });
  it('the month\'s transactions are used up: the month, though the maximum reads 0', () => {
    expect(cashBlockReason({ ...unit, quota_tx_used: 50 }, 0)).toBe('month');
    expect(cashBlockReason({ ...unit, quota_tx_used: 50 }, null)).toBe('month');
    expect(cashBlockReason({ ...unit, quota_volume_limit: 0, quota_tx_used: 50 }, 0)).toBe('month');
  });
  it('the month\'s volume is used up: the month, though the maximum reads 0', () => {
    expect(cashBlockReason({ ...unit, quota_volume_used: 3000 }, 0)).toBe('month');
    expect(cashBlockReason({ ...unit, quota_volume_used: 3000 }, null)).toBe('month');
    expect(cashBlockReason({ ...unit, quota_volume_used: 2999.9999999999995 }, 0)).toBe('month');
    expect(cashBlockReason({ ...unit, quota_volume_used: 3100 }, 0)).toBe('month');
  });
  it('a cent left is not used up', () => {
    expect(cashBlockReason({ ...unit, quota_volume_used: 2999.99 }, 0.01)).toBeNull();
  });
  it('the month has room and the maximum is 0: the funds', () => {
    expect(cashBlockReason(unit, 0)).toBe('funds');
    expect(cashBlockReason(null, 0)).toBe('funds');
  });
  it('a quota in another currency cannot be compared here, so it says nothing', () => {
    expect(cashBlockReason({ ...unit, quota_currency: 'GBP', quota_volume_used: 3000 }, 200)).toBeNull();
  });
});

describe('parseAmountInput', () => {
  it('single comma is the decimal separator (existing convention)', () => {
    expect(parseAmountInput('500,5')).toBe(500.5);
  });
  it('single dot is the decimal separator', () => {
    expect(parseAmountInput('500.5')).toBe(500.5);
  });
  it('European thousands: 1.000,50', () => {
    expect(parseAmountInput('1.000,50')).toBe(1000.5);
  });
  it('Anglo thousands: 1,000.50', () => {
    expect(parseAmountInput('1,000.50')).toBe(1000.5);
  });
  it('empty is NaN', () => {
    expect(parseAmountInput('')).toBeNaN();
  });
});

describe('round2', () => {
  it('rounds to cents', () => {
    expect(round2(499.999)).toBe(500);
    expect(round2(1.006)).toBe(1.01);
  });
});
