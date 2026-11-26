/**
 * The words of Lana-online for a shop without a company (26 Nov 2026), across
 * ALL 12 locales. LANA neposredno has no switch any more (Brilly, 26 Nov 2026),
 * so the sentence "not switched on for this shop yet, the administrator
 * switches it on" is gone from every language: no seller can be sent to an
 * administrator for it. Every key the tab and its list of links name exists in
 * English (the other languages fall back to it).
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

describe.each(Object.keys(LOCALES))('locale %s', (name) => {
  it('no longer has the "not switched on" sentence, nor any word of an admin switch for it', () => {
    const strings = LOCALES[name];
    expect(strings['lanaOnline.directOff']).toBeUndefined();
    for (const [k, v] of Object.entries(strings)) {
      if (k.startsWith('lanaOnline.') || k.startsWith('directLana.')) expect(String(v), `${name}:${k}`).not.toContain('mobile.lanapays.us/admin');
    }
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
    for (const r of ['WALLET_INVALID', 'PAYEE_FROZEN', 'RATE_UNAVAILABLE', 'MARGIN_INVALID', 'UNIT_AUTHOR_MISMATCH', 'UNIT_BLOCKED', null]) {
      expect(EN[closedReasonKey(r)], r).toBeTruthy();
    }
  });
});
