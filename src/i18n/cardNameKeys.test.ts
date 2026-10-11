/**
 * What the till says when a card has no name — in every language.
 *
 * 8 Oct 2026, Živa center: a new card was registered nameless by the LANA tab
 * and then sold to as a bare hex. The LANA tab and the remote-pay page no longer
 * register a new card (they say so instead), the cash tab asks for the name of a
 * registered card that has none, and a nameless regular customer is sent back
 * to a card scan. Each of those is a sentence the seller or the buyer must be
 * able to read, so — same rule as exclusionKeys.test.ts — present, non-empty
 * and translated in all 12 locales.
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

const KEYS = [
  'cash.completeProfileTitle',
  'cash.completeProfileSubtitle',
  'cash.completeProfileAndContinue',
  'cash.regularNeedsName',
  'lana.newCardNoLana',
  'pay.newCardNoLana',
];

describe('a card without a name can be explained in every language', () => {
  for (const [lang, dict] of Object.entries(LOCALES)) {
    for (const key of KEYS) {
      it(`${lang} carries ${key}`, () => {
        expect(typeof dict[key], `${lang} is missing ${key}`).toBe('string');
        expect(dict[key].trim().length, `${lang}.${key} is empty`).toBeGreaterThan(0);
      });
    }
  }

  it('no locale was left with the English text pasted in', () => {
    for (const key of KEYS) {
      for (const [lang, dict] of Object.entries(LOCALES)) {
        if (lang === 'en') continue;
        expect(dict[key], `${lang}.${key} is still the English string`).not.toBe(en[key as keyof typeof en]);
      }
    }
  });
});
