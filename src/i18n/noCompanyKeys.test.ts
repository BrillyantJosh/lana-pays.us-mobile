/**
 * The strings of shops without a company and without a bank account
 * (23 Nov 2026), across ALL 12 locales.
 *
 * Every key is there, translated, with the placeholders of English. The
 * cash-only twins of the limit and Split texts never send the seller to LANA:
 * such a shop has no LANA at this till, and "sell for LANA instead" would be
 * advice it cannot follow. The Split notice is rendered in English AND Slovenian
 * on the cash tile, so both must have their own text.
 */
import { describe, it, expect } from 'vitest';
import en from './locales/en.json';
import sl from './locales/sl.json';
import hu from './locales/hu.json';
import it_ from './locales/it.json';
import es from './locales/es.json';
import pl from './locales/pl.json';
import pt from './locales/pt.json';
import de from './locales/de.json';
import hr from './locales/hr.json';
import sr from './locales/sr.json';
import ru from './locales/ru.json';
import zh from './locales/zh.json';

const LOCALES: Record<string, Record<string, string>> = { en, sl, hu, it: it_, es, pl, pt, de, hr, sr, ru, zh };
const EN = en as Record<string, string>;

const KEYS = [
  'home.noCompanyNote',
  'home.cashLimitReachedDetailNoCompany',
  'split.happening.bodyNoCompany',
  'cash.monthlyCashLimitReachedNoCompany',
  'cash.customerWindowExceededNoCompany',
  'cash.customerWindowExceededTodayNoCompany',
  'cash.noCompanyReceiptSubtitle',
  'cash.noCompanyReceiptInstruction',
  'cash.noCompanySkipPhoto',
  'cash.noCompanyInvoiceTitle',
  'cash.noCompanyInvoiceSubtitle',
  'cash.whatDidYouSell',
  'cash.whatDidYouSellPlaceholder',
  'cash.saleNumberHint',
  'cash.saleNumberLabel',
  'cash.saleNumberFailed',
  'purchase.unitNoPayoutAccount',
  'purchase.noPayoutAccount',
  'purchase.rewardWalletInvalid',
  'pay.closedNoPayoutAccount',
  // Review fixes (23 Nov 2026): a sale sent but never confirmed, and the note
  // while the till cannot take LANA directly.
  'home.noCompanyNoteCashOnly',
  'cash.saleAlreadyRecorded',
  'cash.salePendingNotRecorded',
  'cash.salePendingUnknown',
  'cash.saleLockedHint',
  'cash.saleDiscard',
  'cash.saleDiscardUnknown',
];

/** The cash-only twins: what a shop without a company reads where the others are sent to LANA. */
const CASH_ONLY_TWINS: Array<[string, string]> = [
  ['home.cashLimitReachedDetailNoCompany', 'home.cashLimitReachedDetail'],
  ['split.happening.bodyNoCompany', 'split.happening.body'],
  ['cash.monthlyCashLimitReachedNoCompany', 'cash.monthlyCashLimitReached'],
  ['cash.customerWindowExceededNoCompany', 'cash.customerWindowExceeded'],
  ['cash.customerWindowExceededTodayNoCompany', 'cash.customerWindowExceededToday'],
];

const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) || []).sort();

describe.each(Object.keys(LOCALES))('locale %s', (name) => {
  const strings = LOCALES[name];

  it.each(KEYS)('%s is there, translated, with the placeholders of English', (key) => {
    expect(typeof strings[key], `${name} is missing ${key}`).toBe('string');
    expect(strings[key].trim().length, `${name}:${key} is empty`).toBeGreaterThan(0);
    if (name !== 'en') expect(strings[key], `${name}:${key} is still English`).not.toBe(EN[key]);
    expect(placeholders(strings[key])).toEqual(placeholders(EN[key]));
  });

  it.each(CASH_ONLY_TWINS)('%s never sends the seller to LANA', (twin) => {
    // LANA in any spelling a translation uses (LANA, Lana, LANE, LANO, LANA-ért …).
    expect(strings[twin]).not.toMatch(/\bLAN[AEOI]\b|LANA/i);
  });

  it.each(CASH_ONLY_TWINS)('%s keeps the placeholders of the text it stands in for', (twin, original) => {
    // The original is checked in English for the locales that lack it (split.happening.* exist in en/sl only).
    const source = strings[original] ?? EN[original];
    expect(placeholders(strings[twin])).toEqual(placeholders(source));
  });

  it('the window refusals still say what the customer spent, of what limit', () => {
    for (const p of ['{{spent}}', '{{limit}}', '{{days}}', '{{currency}}']) expect(strings['cash.customerWindowExceededNoCompany']).toContain(p);
    for (const p of ['{{spent}}', '{{limit}}', '{{currency}}']) expect(strings['cash.customerWindowExceededTodayNoCompany']).toContain(p);
    expect(strings['cash.customerWindowExceededTodayNoCompany']).not.toContain('{{days}}');
  });

  it('the sale number label shows the number', () => {
    expect(strings['cash.saleNumberLabel']).toContain('{{number}}');
  });

  it('a sale sent but not confirmed is named by its number and what was sold, and the cash-only note says no LANA', () => {
    for (const k of ['cash.saleAlreadyRecorded', 'cash.salePendingNotRecorded', 'cash.salePendingUnknown']) {
      expect(strings[k], k).toContain('{{number}}');
      expect(strings[k], k).toContain('{{description}}');
    }
    expect(strings['cash.saleLockedHint']).toContain('{{number}}');
    expect(strings['home.noCompanyNoteCashOnly']).not.toMatch(/\bLAN[AEOI]\b|LANA/i);
  });

  it('the payout refusals that ask for a fix name where it is fixed', () => {
    expect(strings['purchase.noPayoutAccount']).toContain('shop.lanapays.us');
    expect(strings['purchase.rewardWalletInvalid']).toContain('shop.lanapays.us');
  });
});

describe('Slovenian, as Brilly wrote it', () => {
  it('the calm note on the home screen', () => {
    expect((sl as Record<string, string>)['home.noCompanyNote']).toBe('Ta trgovina prodaja za gotovino in sprejema LANE neposredno.');
  });
  it('the note while the till cannot take LANA directly says only cash', () => {
    expect((sl as Record<string, string>)['home.noCompanyNoteCashOnly']).toBe('Ta trgovina prodaja za gotovino.');
  });
  it('the question at the cash till', () => {
    expect((sl as Record<string, string>)['cash.whatDidYouSell']).toBe('Kaj ste prodali?');
  });
  it('the reward wallet refusal carries the SPEC\'s sentence, after "this sale was not recorded"', () => {
    expect((sl as Record<string, string>)['purchase.rewardWalletInvalid'])
      .toBe('Ta prodaja ni bila zapisana: trgovina nima veljavne LANA denarnice za nagrado. Popravi jo na shop.lanapays.us.');
  });
});
