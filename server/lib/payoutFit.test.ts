// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { checkBicAgainstIban, bicMismatch, receiverIsAddress, SI_BANK_BIC, type BicFit } from './payoutFit.js';
import { validSepaIban } from './payoutDataCheck.js';

// Made-up IBANs with right check digits and an account number of zeros —
// not anybody's account. The bank code is the 5th and 6th character.
const OTP = 'SI79 0400 0000 0000 012';
const NLB = 'SI16 0200 0000 0000 012';
const N_BANKA = 'SI25 3000 0000 0000 012';
const INTESA = 'SI74 1000 0000 0000 012';
const KDD = 'SI92 7909 5000 0000 012';      // a five-digit code: 79095
const NOT_LISTED_79 = 'SI30 7909 6000 0000 012';
const FORMER_SKB = 'SI96 0300 0000 0000 012'; // 03: merged into OTP, on no list now
const LITHUANIA = 'LT20 3250 0000 0000 0000';
const GERMANY = 'DE63 1001 0010 0000 0000 00';

describe('the BIC against the IBAN (Brilly, 28 Nov 2026)', () => {
  it('the made-up accounts are right IBANs', () => {
    for (const iban of [OTP, NLB, N_BANKA, INTESA, KDD, NOT_LISTED_79, FORMER_SKB, LITHUANIA, GERMANY]) {
      expect(validSepaIban(iban)).toBe(true);
    }
  });

  it('"KBMACI2X" on an OTP account: CI is not SI (a Halcom file of 26 Nov)', () => {
    expect(checkBicAgainstIban(OTP, 'KBMACI2X')).toBe('country_mismatch');
    expect(checkBicAgainstIban(OTP, 'KBMASI2X')).toBe('ok');
  });

  it("UniCredit's BIC on an NLB account (Halcom files of 25 and 26 Nov)", () => {
    expect(checkBicAgainstIban(NLB, 'BACXSI22')).toBe('bank_mismatch');
    expect(checkBicAgainstIban(NLB, 'LJBASI2X')).toBe('ok');
  });

  it("Banka Slovenije's BIC on an Intesa Sanpaolo account", () => {
    expect(checkBicAgainstIban(INTESA, 'BSLJSI2X')).toBe('bank_mismatch');
    expect(checkBicAgainstIban(INTESA, 'BAKOSI2X')).toBe('ok');
  });

  it('an empty BIC stays allowed', () => {
    for (const bic of ['', '   ', null, undefined]) expect(checkBicAgainstIban(NLB, bic)).toBe('empty');
  });

  it('the branch of an eleven-character BIC is not judged; spaces, lower case and the word "IBAN" do not matter', () => {
    expect(checkBicAgainstIban(NLB, 'LJBASI2XXXX')).toBe('ok');
    expect(checkBicAgainstIban(NLB, 'ljba si2x')).toBe('ok');
    expect(checkBicAgainstIban(`IBAN ${NLB}`, 'LJBASI2X')).toBe('ok');
    expect(checkBicAgainstIban(NLB, 'BACXSI22XXX')).toBe('bank_mismatch');
  });

  it('a bank that took another over keeps its code: 30 is NLB (former N Banka)', () => {
    expect(checkBicAgainstIban(N_BANKA, 'LJBASI2X')).toBe('ok');
    expect(checkBicAgainstIban(N_BANKA, 'SABRSI2X')).toBe('bank_mismatch');
  });

  it('a five-digit code is read whole; one on no list passes as unknown', () => {
    expect(checkBicAgainstIban(KDD, 'KDDSSI22')).toBe('ok');
    expect(checkBicAgainstIban(KDD, 'LJBASI2X')).toBe('bank_mismatch');
    expect(checkBicAgainstIban(NOT_LISTED_79, 'LJBASI2X')).toBe('unknown_bank');
  });

  it('a Slovenian code that is not on the list is never refused', () => {
    expect(checkBicAgainstIban(FORMER_SKB, 'SKBASI2X')).toBe('unknown_bank');
    expect(checkBicAgainstIban(FORMER_SKB, 'KBMASI2X')).toBe('unknown_bank');
    // …but its country still is held against it.
    expect(checkBicAgainstIban(FORMER_SKB, 'SKBACI2X')).toBe('country_mismatch');
  });

  it('outside Slovenia only the country is held against the IBAN', () => {
    expect(checkBicAgainstIban(LITHUANIA, 'REVOLT21')).toBe('ok');
    expect(checkBicAgainstIban(LITHUANIA, 'REVOGB21')).toBe('country_mismatch');
    expect(checkBicAgainstIban(GERMANY, 'PBNKDEFF')).toBe('ok');
    expect(checkBicAgainstIban(GERMANY, 'LJBASI2X')).toBe('country_mismatch');
  });

  it('what is not a BIC or an IBAN at all is for the other checks to say', () => {
    expect(checkBicAgainstIban(NLB, 'NOTABIC')).toBe('unknown_bank');
    expect(checkBicAgainstIban('', 'LJBASI2X')).toBe('unknown_bank');
    expect(checkBicAgainstIban('4111 1111 1111 1111', 'LJBASI2X')).toBe('unknown_bank');
  });

  it("every code on the list names a Slovenian BIC's first eight characters", () => {
    for (const [code, bic] of Object.entries(SI_BANK_BIC)) {
      expect(code).toMatch(/^\d{2}(\d{3})?$/);
      expect(bic).toMatch(/^[A-Z]{4}SI[A-Z0-9]{2}$/);
    }
    expect(SI_BANK_BIC['02']).toBe('LJBASI2X');
    expect(SI_BANK_BIC['04']).toBe('KBMASI2X');
  });

  it('only a mismatch is wrong', () => {
    const all: BicFit[] = ['ok', 'empty', 'unknown_bank', 'country_mismatch', 'bank_mismatch'];
    expect(all.filter(bicMismatch)).toEqual(['country_mismatch', 'bank_mismatch']);
  });
});

describe("the receiver's name", () => {
  it('a web or an e-mail address is not a name', () => {
    for (const s of ['Www.example.si', 'www.example.si', 'https://example.si', 'http://example.com/shop', 'info@example.si', 'Ana Novak, ana@example.si']) {
      expect(receiverIsAddress(s)).toBe(true);
    }
  });
  it('names stay names, a dot or an at sign in them included', () => {
    for (const s of ['ANA NOVAK - NOSILKA DOPOLNILNE DEJAVNOSTI NA KMETIJI', 'Booking.com B.V.', 'Ana & Bor d.o.o.', 'Kmetija @ Ponikve', '', null]) {
      expect(receiverIsAddress(s)).toBe(false);
    }
  });
});
