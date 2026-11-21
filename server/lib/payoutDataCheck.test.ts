// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { checkPayoutData, validSepaIban, validBic } from './payoutDataCheck.js';

// A well-formed test IBAN (check digits valid), not anybody's account.
const GOOD_IBAN = 'SI56 1920 0123 4567 892';

const unit = (over: Record<string, string> = {}, fields: Record<string, string> = { iban: GOOD_IBAN, account_holder: 'Ana Novak' }) => {
  const t: Record<string, string> = {
    payment_scheme: 'EU.IBAN', payment_scheme_fields: JSON.stringify(fields),
    receiver_name: 'Ana Novak', receiver_type: 'person', receiver_address: 'Cesta 1', receiver_zip: '1000',
    receiver_city: 'Ljubljana', receiver_country: 'SI', ...over,
  };
  return Object.entries(t).filter(([, v]) => v !== '__drop').map(([k, v]) => [k, v]);
};

describe('the bank file rules, read from the signed unit', () => {
  it('a complete unit has nothing to fix', () => {
    expect(checkPayoutData(unit())).toEqual({ problems: [], advice: [] });
  });
  it('no IBAN, a wrong IBAN, a non-SEPA IBAN — the bank refuses', () => {
    expect(checkPayoutData(unit({}, { account_holder: 'Ana Novak' })).problems).toEqual(['ACCOUNT_MISSING']);
    expect(checkPayoutData(unit({}, { iban: 'SI56 1920 0123 4567 893', account_holder: 'Ana Novak' })).problems).toEqual(['IBAN_INVALID']);
    expect(validSepaIban('BR15 0000 0000 0000 1093 2840 814 P2')).toBe(false);
  });
  it('the word "IBAN" typed in front of a right IBAN, or only the country part typed', () => {
    expect(checkPayoutData(unit({}, { iban: `IBAN ${GOOD_IBAN}`, account_holder: 'Ana Novak' })).problems).toEqual(['IBAN_HAS_WORD']);
    expect(checkPayoutData(unit({}, { iban: 'SI56', account_holder: 'Ana Novak' })).problems).toEqual(['ACCOUNT_MISSING']);
    expect(checkPayoutData(unit({}, { iban: 'IBAN SI56 1920 0123 4567 893', account_holder: 'Ana Novak' })).problems).toEqual(['IBAN_INVALID']);
  });
  it('an older unit with only the legacy bank_account tag is read too', () => {
    const legacy = unit({ payment_scheme: '__drop', payment_scheme_fields: '__drop', bank_account: GOOD_IBAN });
    expect(checkPayoutData(legacy).problems).toEqual([]);
  });
  it('no street or no town — the bank refuses', () => {
    expect(checkPayoutData(unit({ receiver_address: '', receiver_city: '' })).problems).toEqual(['STREET_MISSING', 'TOWN_MISSING']);
  });
  it('a UK account needs its number and sort code, not an IBAN', () => {
    const uk = unit({ payment_scheme: 'UK.ACCT_SORT', receiver_country: 'GB' }, { account_number: '12345678', sort_code: '123456', account_holder: 'Ana Novak' });
    expect(checkPayoutData(uk).problems).toEqual([]);
    expect(checkPayoutData(unit({ payment_scheme: 'UK.ACCT_SORT' }, { account_holder: 'Ana Novak' })).problems).toEqual(['ACCOUNT_MISSING']);
  });
  it('advice: a typed receiver, a different holder, a country name, a bad BIC, no post code', () => {
    const c = checkPayoutData(unit({ receiver_type: '', receiver_country: 'Slovenija', receiver_zip: '' },
      { iban: GOOD_IBAN, bic: 'NOTABIC', account_holder: 'Eko pridelki' }));
    expect(c.problems).toEqual([]);
    expect(c.advice.sort()).toEqual(['BIC_INVALID', 'COUNTRY_UNCLEAR', 'HOLDER_DIFFERS', 'RECEIVER_NOT_CHOSEN', 'ZIP_MISSING']);
  });
  it('BIC shapes', () => {
    expect(validBic('LJBASI2X')).toBe(true);
    expect(validBic('HDELSI22XXX')).toBe(true);
    expect(validBic('LJBA SI2X')).toBe(false);
  });
});
