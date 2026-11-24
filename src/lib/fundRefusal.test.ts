/**
 * Which of the till's words the brain's two refusals about the investors'
 * money read as, and that those words exist in all 12 languages: the brain's
 * own `error` is English, so a missing translation would leave the seller with
 * nothing better than before.
 */
import { describe, it, expect } from 'vitest';
import { fundRefusalKey, NO_INVESTOR_BUDGET, FUND_UNREACHABLE } from './fundRefusal';
import en from '@/i18n/locales/en.json';
import sl from '@/i18n/locales/sl.json';
import hu from '@/i18n/locales/hu.json';
import it_ from '@/i18n/locales/it.json';
import es from '@/i18n/locales/es.json';
import pl from '@/i18n/locales/pl.json';
import pt from '@/i18n/locales/pt.json';
import de from '@/i18n/locales/de.json';
import hr from '@/i18n/locales/hr.json';
import sr from '@/i18n/locales/sr.json';
import ru from '@/i18n/locales/ru.json';
import zh from '@/i18n/locales/zh.json';

const LOCALES: Record<string, Record<string, string>> = { en, sl, hu, it: it_, es, pl, pt, de, hr, sr, ru, zh };

describe('fundRefusalKey', () => {
  it('no investor for the sale reads as the no-funds wording', () => {
    expect(fundRefusalKey({ success: false, error: 'No investor can fund this sale in GBP right now.', code: NO_INVESTOR_BUDGET, currency: 'GBP' }))
      .toBe('cash.noFunds');
  });

  it('the money not checkable reads as a failed purchase to try again', () => {
    expect(fundRefusalKey({ success: false, error: 'Investor funds cannot be checked right now.', code: FUND_UNREACHABLE }))
      .toBe('cash.purchaseFailed');
  });

  it('only `code` is read: the brain\'s words in `error` decide nothing', () => {
    expect(fundRefusalKey({ success: false, error: NO_INVESTOR_BUDGET })).toBeNull();
    expect(fundRefusalKey({ success: false, error: FUND_UNREACHABLE })).toBeNull();
  });

  it('every other answer is not one of these', () => {
    for (const data of [
      null, undefined, {}, { error: 'Purchase processing failed' }, { error: 'Preview failed' },
      { code: 'NO_FUND_CAPACITY' }, { code: 'MERCHANT_QUOTA_EXCEEDED' }, { code: 'SELLER_CHECK_FAILED' }, { code: 7 },
    ]) {
      expect(fundRefusalKey(data)).toBeNull();
    }
  });
});

describe.each(Object.keys(LOCALES))('locale %s', (name) => {
  it.each(['cash.noFunds', 'cash.purchaseFailed'])('%s is there', (key) => {
    expect(LOCALES[name][key], `${name} is missing ${key}`).toBeTruthy();
    if (name !== 'en') expect(LOCALES[name][key], `${name} ${key} is English`).not.toBe((en as Record<string, string>)[key]);
  });
});
