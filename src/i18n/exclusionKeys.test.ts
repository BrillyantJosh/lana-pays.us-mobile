/**
 * The two things the KIND 87058 gate has to be able to SAY, in every language.
 *
 * A refusal the person at the till cannot read is a refusal that gets retried,
 * argued with, or worked around. Both of these were added because the app was
 * silent exactly where it needed words:
 *
 *   cash.customerNotIdentified — the till used to send `customer_hex: ''` for a
 *     customer it could not put a name to, and the sale went through on the
 *     wallet alone. It now refuses, so it must be able to say why.
 *   purchase.personExcluded — every gated route answers 403 PERSON_EXCLUDED, and
 *     the till used to print the raw English body at the seller.
 *   purchase.merchantUnavailable — a sale refused because of the SHOP. It reaches
 *     a clean buyer or a clean staff member, who are the subject of nothing, so it
 *     must never read as "your access is paused" and must never carry the ground.
 *
 * Same rule as ordersKeys.test.ts: present, non-empty, in all 12 locales.
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

const KEYS = ['cash.customerNotIdentified', 'purchase.personExcluded', 'purchase.merchantUnavailable'];

describe('the gate can speak every language this app speaks', () => {
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
