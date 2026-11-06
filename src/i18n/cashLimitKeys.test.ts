/**
 * The cash limit strings, across ALL 12 locales.
 *
 * Brilly, 6 Nov 2026: the rolling per-customer window is gone. No locale may
 * still carry its refusal, and the notice shown when a sale is reduced must keep
 * its placeholders, or the seller reads a sentence with holes in it.
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

describe.each(Object.keys(LOCALES))('locale %s', (name) => {
  const strings = LOCALES[name];

  it('has no string for the per-customer window', () => {
    expect(Object.keys(strings).filter(k => /customerWindow/i.test(k))).toEqual([]);
  });

  it.each(['cash.amountAdjusted', 'cash.willAdjustToMax', 'cash.monthlyCashLimitReached'])('%s is there, with the placeholders of English', (key) => {
    expect(strings[key], `${name} is missing ${key}`).toBeTruthy();
    const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) || []).sort();
    expect(placeholders(strings[key])).toEqual(placeholders((en as Record<string, string>)[key]));
  });

  // The same notice is shown when the fund, the default or the rest of the month
  // reduced the sale, so it may not claim the cause was the transaction limit.
  it('the notice about a reduced sale names no single cause', () => {
    expect(strings['cash.amountAdjusted']).not.toMatch(/transacti|transakcij|transaktions|tranzakci|transação|transacción|транзакци|交易/i);
  });
});
