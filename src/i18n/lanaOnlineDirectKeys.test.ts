/**
 * The words of Lana-online for a shop without a company (26 Nov 2026), across
 * ALL 12 locales: the sentence for "LANA neposredno is not switched on for this
 * shop yet" is there, translated, says the administrator switches it on and
 * where, and never sends the seller to a bank. Every key the tab and its list
 * of links name exists in English (the other languages fall back to it).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
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
import { closedReasonKey } from '../lib/onlineRequestRail';

const LOCALES: Record<string, Record<string, string>> = { en, sl, hu, it: it_, es, pl, pt, de, hr, sr, ru, zh };
const EN = en as Record<string, string>;
const KEY = 'lanaOnline.directOff';

/** "bank", in the words each language uses for it. */
const BANK: Record<string, RegExp> = {
  en: /bank/i, sl: /bank|banč/i, de: /bank/i, es: /banc/i, hr: /bank/i, hu: /bank/i, it: /banc/i,
  pl: /bank/i, pt: /banc/i, ru: /банк/i, sr: /bank/i, zh: /银行/,
};

describe.each(Object.keys(LOCALES))('locale %s', (name) => {
  const strings = LOCALES[name];

  it('has the sentence, translated', () => {
    expect(typeof strings[KEY], `${name} is missing ${KEY}`).toBe('string');
    expect(strings[KEY].trim().length).toBeGreaterThan(0);
    if (name !== 'en') expect(strings[KEY], `${name}:${KEY} is still English`).not.toBe(EN[KEY]);
    expect(strings[KEY].match(/\{\{\w+\}\}/g)).toBeNull();
  });

  it('says where the administrator switches it on, and never names a bank', () => {
    expect(strings[KEY]).toContain('mobile.lanapays.us/admin');
    expect(strings[KEY]).not.toMatch(BANK[name]);
  });
});

describe('Slovenian', () => {
  it('as it is shown', () => {
    expect((sl as Record<string, string>)[KEY]).toBe(
      'LANA neposredno za to trgovino še ni vklopljeno, zato povezave za plačilo ni mogoče ustvariti. Vklopi ga administrator na mobile.lanapays.us/admin. Do takrat trgovina sprejema gotovino.',
    );
  });
});

describe('every key the code names exists', () => {
  const files = ['../components/tabs/LanaOnlineTab.tsx', '../components/DirectLinkRequestList.tsx'];

  it('in the tab and its list of links', () => {
    const keys = new Set<string>();
    for (const f of files) {
      const src = fs.readFileSync(path.resolve(__dirname, f), 'utf8');
      for (const m of src.matchAll(/\bt\('([A-Za-z]+\.[A-Za-z0-9_.]+)'/g)) keys.add(m[1]);
    }
    expect(keys.size).toBeGreaterThan(40);
    for (const k of keys) expect(EN[k], `en is missing ${k}`).toBeTruthy();
  });

  it('for every status a link can have and every reason the closed box can give', () => {
    for (const s of ['open', 'paying', 'paid', 'cancelled', 'expired']) expect(EN[`directLana.linkStatus.${s}`], s).toBeTruthy();
    for (const r of ['DIRECT_LANA_OFF', 'WALLET_INVALID', 'PAYEE_FROZEN', 'RATE_UNAVAILABLE', 'MARGIN_INVALID', 'UNIT_AUTHOR_MISMATCH']) {
      expect(EN[closedReasonKey(r)], r).toBeTruthy();
    }
  });
});
