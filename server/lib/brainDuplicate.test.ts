// @vitest-environment node
/**
 * verifyBrainDuplicate — the pure decision behind "is this brain 409 our own
 * earlier attempt?". The end-to-end cases live with the caller; these pin the
 * edges: tolerance, clock allowance, malformed fields. Same file in POS,
 * gateway, mobile and LanaFund.
 */
import { describe, it, expect } from 'vitest';
import { verifyBrainDuplicate, parseUtc, readOriginal, isBrainDuplicate, duplicateMismatchMessage } from './brainDuplicate.js';

const order = { unitId: 'unit-1', currency: 'EUR', amount: 25.1, invoiceNumber: 'INV-9', createdAt: '2026-10-25 08:00:00' };
const body = (over: Record<string, unknown> = {}) => ({
  success: false, error: 'DUPLICATE_INVOICE',
  original: {
    id: 'tx-1', unit_id: 'unit-1', amount: 25.1, currency: 'EUR', payment_type: 'lana', status: 'processing',
    payment_status: 'PendingDirect', invoice_number: 'INV-9', created_at: '2026-10-25 08:00:05', settled_at: null, ...over,
  },
});

describe('verifyBrainDuplicate', () => {
  it('paid: same unit, currency, amount, invoice, live status, created after the order', () => {
    const v = verifyBrainDuplicate(body(), order);
    expect(v.paid).toBe(true);
    for (const status of ['created', 'processing', 'settled', 'partial']) {
      expect(verifyBrainDuplicate(body({ status }), order).paid).toBe(true);
    }
  });

  it('amount: within 0.01 is the same, beyond is not', () => {
    expect(verifyBrainDuplicate(body({ amount: 25.11 }), order).paid).toBe(true);
    expect(verifyBrainDuplicate(body({ amount: 25.09 }), order).paid).toBe(true);
    expect(verifyBrainDuplicate(body({ amount: 25.12 }), order)).toMatchObject({ paid: false, reason: 'AMOUNT_MISMATCH' });
    expect(verifyBrainDuplicate(body({ amount: 10.9 }), order)).toMatchObject({ paid: false, reason: 'AMOUNT_MISMATCH' });
  });

  it('missing or malformed original → NO_ORIGINAL (old brain is never believed)', () => {
    expect(verifyBrainDuplicate({ success: false, error: 'DUPLICATE_INVOICE', original_tx_id: 'tx-1' }, order))
      .toMatchObject({ paid: false, reason: 'NO_ORIGINAL', original: null });
    expect(verifyBrainDuplicate(null, order)).toMatchObject({ paid: false, reason: 'NO_ORIGINAL' });
    for (const over of [{ id: '' }, { amount: '25.1' }, { amount: NaN }, { unit_id: null }, { currency: undefined },
      { status: 1 }, { created_at: null }, { payment_status: undefined }, { invoice_number: 7 }]) {
      expect(verifyBrainDuplicate(body(over), order)).toMatchObject({ paid: false, reason: 'NO_ORIGINAL' });
    }
    expect(readOriginal({ original: [] })).toBeNull();
  });

  it('each other mismatch has its own reason', () => {
    expect(verifyBrainDuplicate(body({ unit_id: 'unit-2' }), order)).toMatchObject({ paid: false, reason: 'UNIT_MISMATCH' });
    expect(verifyBrainDuplicate(body({ currency: 'USD' }), order)).toMatchObject({ paid: false, reason: 'CURRENCY_MISMATCH' });
    expect(verifyBrainDuplicate(body({ currency: 'eur' }), order).paid).toBe(true);
    expect(verifyBrainDuplicate(body({ status: 'failed' }), order)).toMatchObject({ paid: false, reason: 'STATUS_NOT_LIVE' });
    expect(verifyBrainDuplicate(body({ status: 'cancelled' }), order)).toMatchObject({ paid: false, reason: 'STATUS_NOT_LIVE' });
    expect(verifyBrainDuplicate(body({ status: 'weird' }), order)).toMatchObject({ paid: false, reason: 'STATUS_NOT_LIVE' });
    expect(verifyBrainDuplicate(body({ payment_status: 'BroadcastUnverified' }), order)).toMatchObject({ paid: false, reason: 'PAYMENT_NOT_CONFIRMED' });
    expect(verifyBrainDuplicate(body({ payment_status: 'PaymentFailed' }), order)).toMatchObject({ paid: false, reason: 'PAYMENT_NOT_CONFIRMED' });
    expect(verifyBrainDuplicate(body({ invoice_number: 'INV-8' }), order)).toMatchObject({ paid: false, reason: 'INVOICE_MISMATCH' });
    expect(verifyBrainDuplicate(body({ invoice_number: null }), order)).toMatchObject({ paid: false, reason: 'INVOICE_MISMATCH' });
    expect(verifyBrainDuplicate(body({ invoice_number: ' INV-9 ' }), order).paid).toBe(true);
    expect(verifyBrainDuplicate(body(), { ...order, invoiceNumber: '' })).toMatchObject({ paid: false, reason: 'INVOICE_MISMATCH' });
  });

  it('an original older than the order is another sale; 2 minutes of clock allowance', () => {
    expect(verifyBrainDuplicate(body({ created_at: '2026-10-25 07:58:30' }), order).paid).toBe(true);
    expect(verifyBrainDuplicate(body({ created_at: '2026-10-25 07:57:59' }), order)).toMatchObject({ paid: false, reason: 'ORIGINAL_PREDATES_ORDER' });
    expect(verifyBrainDuplicate(body({ created_at: '2026-10-05 08:50:00' }), order)).toMatchObject({ paid: false, reason: 'ORIGINAL_PREDATES_ORDER' });
    expect(verifyBrainDuplicate(body({ created_at: 'yesterday' }), order)).toMatchObject({ paid: false, reason: 'ORIGINAL_PREDATES_ORDER' });
    expect(verifyBrainDuplicate(body(), { ...order, createdAt: '' })).toMatchObject({ paid: false, reason: 'ORIGINAL_PREDATES_ORDER' });
  });

  it('parseUtc reads SQLite UTC and ISO; anything else is NaN', () => {
    expect(parseUtc('2026-10-25 08:00:00')).toBe(Date.UTC(2026, 9, 25, 8, 0, 0));
    expect(parseUtc('2026-10-25T08:00:00Z')).toBe(Date.UTC(2026, 9, 25, 8, 0, 0));
    expect(parseUtc('2026-10-25T10:00:00+02:00')).toBe(Date.UTC(2026, 9, 25, 8, 0, 0));
    expect(parseUtc('25.10.2026')).toBeNaN();
    expect(parseUtc(undefined)).toBeNaN();
  });

  it('isBrainDuplicate: only 409 with a receipt-dedup code', () => {
    expect(isBrainDuplicate(409, { error: 'DUPLICATE_INVOICE' })).toBe(true);
    expect(isBrainDuplicate(409, { error: 'DUPLICATE_RECEIPT_IMAGE' })).toBe(true);
    expect(isBrainDuplicate(409, { error: 'MERCHANT_QUOTA_EXCEEDED' })).toBe(false);
    expect(isBrainDuplicate(400, { error: 'DUPLICATE_INVOICE' })).toBe(false);
  });

  it('every reason has words, none of them blank', () => {
    for (const r of ['NO_ORIGINAL', 'UNIT_MISMATCH', 'CURRENCY_MISMATCH', 'AMOUNT_MISMATCH', 'STATUS_NOT_LIVE',
      'PAYMENT_NOT_CONFIRMED', 'INVOICE_MISMATCH', 'ORIGINAL_PREDATES_ORDER'] as const) {
      expect(duplicateMismatchMessage(r)).toMatch(/stays unpaid/);
    }
  });
});
