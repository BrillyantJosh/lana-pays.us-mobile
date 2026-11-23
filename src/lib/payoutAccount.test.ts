/**
 * Shops without a company and without a bank account, at the till
 * (lib/payoutAccount.ts): the flag, the words of a refusal, and the text a
 * no-company cash sale sends to the brain as its invoice number.
 */
import { describe, it, expect } from 'vitest';
import {
  isNoPayoutAccountUnit, isUnitNoPayoutAccount, payoutRefusalKey, saleInvoiceNumber, readSaleNumber,
  SALE_DESCRIPTION_MAX, UNIT_NO_PAYOUT_ACCOUNT, NO_PAYOUT_ACCOUNT, REWARD_WALLET_INVALID,
} from './payoutAccount';

describe('isNoPayoutAccountUnit — strictly the server\'s "none"', () => {
  it('only payout_account === "none"', () => {
    expect(isNoPayoutAccountUnit({ payout_account: 'none' })).toBe(true);
  });

  it('absent (an older server, any unit as before) and anything else is a shop as before', () => {
    expect(isNoPayoutAccountUnit({})).toBe(false);
    expect(isNoPayoutAccountUnit(null)).toBe(false);
    expect(isNoPayoutAccountUnit(undefined)).toBe(false);
    for (const v of ['None', 'NONE', '', 'bank', true, 1, null]) expect(isNoPayoutAccountUnit({ payout_account: v }), String(v)).toBe(false);
  });
});

describe('payoutRefusalKey — the seller\'s words, never the raw answer', () => {
  it('this server\'s shape: the code in `code`, words in `error`', () => {
    const body = { success: false, code: UNIT_NO_PAYOUT_ACCOUNT, error: 'This shop has no bank account, so…', message: '…' };
    expect(payoutRefusalKey(body)).toBe('purchase.unitNoPayoutAccount');
    expect(isUnitNoPayoutAccount(body)).toBe(true);
  });

  it('the brain\'s shape: the code in `error` (and in `code`)', () => {
    expect(payoutRefusalKey({ success: false, error: NO_PAYOUT_ACCOUNT, message: 'x' })).toBe('purchase.noPayoutAccount');
    expect(payoutRefusalKey({ success: false, error: REWARD_WALLET_INVALID, code: REWARD_WALLET_INVALID })).toBe('purchase.rewardWalletInvalid');
    expect(payoutRefusalKey({ success: false, error: UNIT_NO_PAYOUT_ACCOUNT, code: UNIT_NO_PAYOUT_ACCOUNT })).toBe('purchase.unitNoPayoutAccount');
  });

  it('every other refusal is somebody else\'s to word', () => {
    for (const body of [
      { error: 'MERCHANT_QUOTA_EXCEEDED' }, { error: 'DUPLICATE_INVOICE' }, { code: 'SIGNATURE_REQUIRED', error: 'This till could not confirm who is selling.' },
      { error: 'Missing required fields' }, { error: 'no bank account' }, null, undefined, {}, 'x',
    ]) {
      expect(payoutRefusalKey(body), JSON.stringify(body)).toBeNull();
      expect(isUnitNoPayoutAccount(body)).toBe(false);
    }
  });
});

describe('saleInvoiceNumber — what was sold, plus the unit\'s sale number and its day', () => {
  const sale42 = { number: 42, date: '23.11.2026' };

  it('"eggs, 10 pieces" as sale 42', () => {
    expect(saleInvoiceNumber('jajca, 10 kosov', sale42)).toBe('jajca, 10 kosov (#42, 23.11.2026)');
  });

  it('two sales described the same way send two different texts: the brain refuses neither as a duplicate', () => {
    const a = saleInvoiceNumber('jajca', { number: 42, date: '23.11.2026' });
    const b = saleInvoiceNumber('jajca', { number: 43, date: '23.11.2026' });
    expect(a).not.toBe(b);
  });

  it('the same sale sends the same text every time it is retried', () => {
    expect(saleInvoiceNumber('  jajca ', sale42)).toBe(saleInvoiceNumber('jajca', sale42));
  });

  it('a counter restored from an older backup cannot repeat another day\'s text', () => {
    expect(saleInvoiceNumber('jajca', { number: 42, date: '23.11.2026' }))
      .not.toBe(saleInvoiceNumber('jajca', { number: 42, date: '24.11.2026' }));
  });

  it('a long description is cut, the number always stays', () => {
    const text = saleInvoiceNumber('x'.repeat(500), sale42);
    expect(text).toBe(`${'x'.repeat(SALE_DESCRIPTION_MAX)} (#42, 23.11.2026)`);
  });
});

describe('readSaleNumber — only a well-formed answer of the server', () => {
  it('takes { success, number, date }', () => {
    expect(readSaleNumber({ success: true, number: 7, date: '01.12.2026' })).toEqual({ number: 7, date: '01.12.2026' });
  });

  it('anything else is no number (nothing is sent then)', () => {
    for (const body of [
      null, {}, { success: false, number: 7, date: '01.12.2026' }, { success: true, number: 0, date: '01.12.2026' },
      { success: true, number: 1.5, date: '01.12.2026' }, { success: true, number: '7', date: '01.12.2026' },
      { success: true, number: 7, date: '2026-12-01' }, { success: true, number: 7 },
    ]) {
      expect(readSaleNumber(body), JSON.stringify(body)).toBeNull();
    }
  });
});
