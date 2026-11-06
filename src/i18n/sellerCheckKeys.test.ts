/**
 * What the till can say when the server does not take a sale from this sign-in.
 * Same rule as exclusionKeys.test.ts: present, non-empty, in all 12 locales, and no
 * locale left with the English text pasted in.
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
const KEYS = ['purchase.sellerNotConfirmed', 'purchase.sellerNotEntitled'];

describe('the seller refusals speak every language this app speaks', () => {
  for (const [lang, dict] of Object.entries(LOCALES)) {
    for (const key of KEYS) {
      it(`${lang} carries ${key}`, () => {
        expect(typeof dict[key], `${lang} is missing ${key}`).toBe('string');
        expect(dict[key].trim().length, `${lang}.${key} is empty`).toBeGreaterThan(0);
        if (lang !== 'en') expect(dict[key], `${lang}.${key} is the English text`).not.toBe(en[key as keyof typeof en]);
      });
    }
  }
});
