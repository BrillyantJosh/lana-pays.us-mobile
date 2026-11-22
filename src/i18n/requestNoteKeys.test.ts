/**
 * The payment-request NOTE strings exist, are not empty, and are translated in
 * all 12 locales — and the hint that the customer sees the note is there in
 * every one of them, because the pay page shows it.
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
const KEYS = ['lanaOnline.noteLabel', 'lanaOnline.noteOptional', 'lanaOnline.notePlaceholder', 'lanaOnline.noteHint', 'pay.noteFromSeller'];
/** Words that are genuinely the same in a language as in English. */
const SAME_AS_ENGLISH = new Set(['de:lanaOnline.noteOptional']);

describe('payment-request note strings', () => {
  for (const [lng, dict] of Object.entries(LOCALES)) {
    it(`${lng}: every key present, non-empty, translated`, () => {
      for (const k of KEYS) {
        expect(typeof dict[k], `${lng}:${k}`).toBe('string');
        expect(dict[k].trim().length, `${lng}:${k}`).toBeGreaterThan(0);
        if (lng !== 'en' && !SAME_AS_ENGLISH.has(`${lng}:${k}`)) expect(dict[k], `${lng}:${k} is English`).not.toBe(EN[k]);
      }
    });
  }
});
