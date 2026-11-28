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
    // The bank file drops the word (direct.lana.fund), so it is advice, not a refusal.
    expect(checkPayoutData(unit({}, { iban: `IBAN ${GOOD_IBAN}`, account_holder: 'Ana Novak' }))).toEqual({ problems: [], advice: ['IBAN_HAS_WORD'] });
    expect(checkPayoutData(unit({}, { iban: 'SI56', account_holder: 'Ana Novak' })).problems).toEqual(['ACCOUNT_MISSING']);
    expect(checkPayoutData(unit({}, { iban: 'IBAN SI56 1920 0123 4567 893', account_holder: 'Ana Novak' })).problems).toEqual(['IBAN_INVALID']);
  });
  it('a payment card number where the IBAN goes is named as one', () => {
    // A published test card number, not anybody's card.
    expect(checkPayoutData(unit({}, { iban: '4111 1111 1111 1111', account_holder: 'Ana Novak' })).problems).toEqual(['IBAN_IS_CARD']);
    expect(checkPayoutData(unit({}, { iban: '4111 1111 1111 1112', account_holder: 'Ana Novak' })).problems).toEqual(['IBAN_INVALID']);
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
  it('a BIC of another country or another bank than the IBAN (two Halcom files made again, 25 and 26 Nov)', () => {
    // Made-up IBANs with right check digits: an OTP (04) and an NLB (02) account.
    const otp = { iban: 'SI79 0400 0000 0000 012', account_holder: 'Ana Novak' };
    const nlb = { iban: 'SI16 0200 0000 0000 012', account_holder: 'Ana Novak' };
    expect(checkPayoutData(unit({}, { ...otp, bic: 'KBMACI2X' }))).toEqual({ problems: [], advice: ['BIC_COUNTRY_MISMATCH'] });
    expect(checkPayoutData(unit({}, { ...nlb, bic: 'BACXSI22' }))).toEqual({ problems: [], advice: ['BIC_BANK_MISMATCH'] });
    expect(checkPayoutData(unit({}, { ...otp, bic: 'KBMASI2X' }))).toEqual({ problems: [], advice: [] });
    expect(checkPayoutData(unit({}, { ...nlb, bic: 'LJBASI2X' }))).toEqual({ problems: [], advice: [] });
    // The older bank_swift tag is read too, and the word "IBAN" in front does not hide it.
    expect(checkPayoutData(unit({ bank_swift: 'BACXSI22' }, nlb)).advice).toEqual(['BIC_BANK_MISMATCH']);
    expect(checkPayoutData(unit({}, { ...nlb, iban: `IBAN ${nlb.iban}`, bic: 'BACXSI22' })).advice).toEqual(['IBAN_HAS_WORD', 'BIC_BANK_MISMATCH']);
    // No BIC is fine; a wrong IBAN is told first, the BIC is not held against it.
    expect(checkPayoutData(unit({}, { ...nlb, bic: '' })).advice).toEqual([]);
    expect(checkPayoutData(unit({}, { iban: 'SI16 0200 0000 0000 013', bic: 'BACXSI22', account_holder: 'Ana Novak' }))).toEqual({ problems: ['IBAN_INVALID'], advice: [] });
  });
  it("the receiver's name: a web or e-mail address, or none", () => {
    expect(checkPayoutData(unit({ receiver_name: 'Www.example.si' }, { iban: GOOD_IBAN }))).toEqual({ problems: [], advice: ['RECEIVER_NOT_A_NAME'] });
    expect(checkPayoutData(unit({ receiver_name: 'info@example.si' }, { iban: GOOD_IBAN })).advice).toEqual(['RECEIVER_NOT_A_NAME']);
    expect(checkPayoutData(unit({ receiver_name: '' }, { iban: GOOD_IBAN })).advice).toEqual(['RECEIVER_NAME_MISSING']);
    expect(checkPayoutData(unit({ receiver_name: 'Booking.com B.V.' }, { iban: GOOD_IBAN })).advice).toEqual([]);
  });
  it('BIC shapes', () => {
    expect(validBic('LJBASI2X')).toBe(true);
    expect(validBic('HDELSI22XXX')).toBe(true);
    expect(validBic('LJBA SI2X')).toBe(false);
  });
});
