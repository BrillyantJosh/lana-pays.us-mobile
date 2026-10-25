import { describe, it, expect } from 'vitest';
import { canContinueAfterHit, duplicateRefusal, freshReceiptFields, localDate } from './receiptDedup';

describe('freshReceiptFields', () => {
  it('a new photo starts empty', () => {
    expect(freshReceiptFields()).toEqual({ invoiceNumber: '', amount: '' });
  });
  it('only what another tab handed over survives', () => {
    expect(freshReceiptFields({ invoiceNumber: 'ziva center 243640', amount: 164.7 })).toEqual({ invoiceNumber: 'ziva center 243640', amount: '164.7' });
  });
});

describe('canContinueAfterHit', () => {
  it('no hit: go on', () => {
    expect(canContinueAfterHit(null, '')).toBe(true);
  });
  it('a hit on the photo: never — a new photo is needed', () => {
    expect(canContinueAfterHit({ by: 'receipt_image', date: '' }, 'anything')).toBe(false);
  });
  it('a hit on the number: only with a different, non-empty number', () => {
    const hit = { by: 'invoice' as const, date: '', number: 'TRG1-L0001-521' };
    expect(canContinueAfterHit(hit, 'TRG1-L0001-521')).toBe(false);
    expect(canContinueAfterHit(hit, ' TRG1-L0001-521 ')).toBe(false);
    expect(canContinueAfterHit(hit, '   ')).toBe(false);
    expect(canContinueAfterHit(hit, 'TRG1-L0001-52160')).toBe(true);
  });
});

describe('duplicateRefusal', () => {
  it('DUPLICATE_INVOICE → the number field, with the number that was refused', () => {
    expect(duplicateRefusal(409, { error: 'DUPLICATE_INVOICE', original_created_at: '2026-10-14 07:10:44' }, ' TRG1-L0001-521 '))
      .toMatchObject({ by: 'invoice', number: 'TRG1-L0001-521' });
  });
  it('DUPLICATE_RECEIPT_IMAGE → the photo', () => {
    expect(duplicateRefusal(409, { error: 'DUPLICATE_RECEIPT_IMAGE' }, 'x')).toMatchObject({ by: 'receipt_image' });
  });
  it('anything else is not a duplicate', () => {
    expect(duplicateRefusal(409, { error: 'SELF_PURCHASE' }, 'x')).toBeNull();
    expect(duplicateRefusal(400, { error: 'DUPLICATE_INVOICE' }, 'x')).toBeNull();
  });
});

describe('localDate', () => {
  it('reads the brain UTC timestamp as UTC', () => {
    const shown = localDate('2026-10-13 08:44:53');
    expect(shown).toBe(new Date(Date.UTC(2026, 9, 13, 8, 44, 53)).toLocaleString());
  });
  it('nothing or garbage → empty', () => {
    expect(localDate(null)).toBe('');
    expect(localDate('not a date')).toBe('');
  });
});
