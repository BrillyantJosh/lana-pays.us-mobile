/**
 * The words of a LANA neposredno payment link's page (src/pages/PublicDirectPay.tsx,
 * 25 Nov 2026), said to the person who PAYS, across ALL 12 locales: every key the
 * page names is there, translated, with the placeholders of English; every refusal
 * the server can answer has words for the customer; and the Slovenian sentences
 * that matter most say what they must.
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
import { directPayReasonKey, DIRECT_PAY_REASON_KEYS } from '../lib/directLanaApi';

const LOCALES: Record<string, Record<string, string>> = { en, sl, hu, it: it_, es, pl, pt, de, hr, sr, ru, zh };
const EN = en as Record<string, string>;
const SL = sl as Record<string, string>;
const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) || []).sort();

/** Every i18n key the page names in quotes, read out of the page itself. */
function keysUsedByPage(): string[] {
  const src = fs.readFileSync(path.resolve(__dirname, '../pages/PublicDirectPay.tsx'), 'utf8');
  return [...new Set([...src.matchAll(/'((?:directPay|directLana|pay|lana|common)\.[A-Za-z_.]+)'/g)].map(m => m[1]))];
}

/** Every code the server can answer the customer's routes with (server/directLana.ts WORDS) and the page's own. */
function everyCode(): string[] {
  const server = fs.readFileSync(path.resolve(__dirname, '../../server/directLana.ts'), 'utf8');
  const block = server.slice(server.indexOf('const WORDS'), server.indexOf('};', server.indexOf('const WORDS')));
  const fromServer = [...block.matchAll(/^\s+([A-Z_]+):/gm)].map(m => m[1]);
  const fromPage = ['CARD_ADDRESS_NOT_KEY', 'CARD_NOSTR_KEY', 'CARD_KEY_INVALID', 'CARD_MISMATCH', 'PLAN_RECIPIENT_CHANGED',
    'PLAN_AMOUNTS_CHANGED', 'PLAN_INPUT_MISMATCH', 'DEVICE_CLOCK', 'SIGNATURE_FAILED', 'NETWORK', 'GENERIC', 'NOT_RECEIVED',
    'RESEND_REFUSED_BY_NETWORK', 'PREVIOUS_PAYMENT_PENDING', 'QUOTE_EXPIRED'];
  return [...new Set([...fromServer, ...fromPage])];
}

describe('the keys exist where the page needs them', () => {
  it('every key the page names, in every locale', () => {
    const used = keysUsedByPage();
    expect(used.length).toBeGreaterThan(40);
    for (const [name, strings] of Object.entries(LOCALES)) {
      for (const k of used) expect(typeof strings[k], `${name} is missing ${k}`).toBe('string');
    }
  });

  it('every refusal the server or the page can give has the customer\'s words', () => {
    for (const c of everyCode()) {
      const { key } = directPayReasonKey(c);
      for (const [name, strings] of Object.entries(LOCALES)) expect(strings[key], `${name}: ${c} → ${key}`).toBeTruthy();
    }
    for (const k of DIRECT_PAY_REASON_KEYS) expect(EN[k], k).toBeTruthy();
  });

  it('the customer is never told a seller\'s exclusion: it is "this shop cannot take payments"', () => {
    expect(directPayReasonKey('MERCHANT_UNAVAILABLE')).toEqual({ key: 'purchase.merchantUnavailable', sentence: true });
    expect(directPayReasonKey('LINK_CLOSED').key).toBe('directPay.reason.UNIT');
  });
});

describe.each(Object.keys(LOCALES))('locale %s', (name) => {
  const strings = LOCALES[name];
  const keys = Object.keys(EN).filter(k => k.startsWith('directPay.'));

  it('has every directPay key, translated, with the placeholders of English', () => {
    expect(keys.length).toBe(56);
    for (const key of keys) {
      expect(typeof strings[key], `${name} is missing ${key}`).toBe('string');
      expect(strings[key].trim().length, `${name}:${key} is empty`).toBeGreaterThan(0);
      if (name !== 'en') expect(strings[key], `${name}:${key} is still English`).not.toBe(EN[key]);
      expect(placeholders(strings[key]), `${name}:${key}`).toEqual(placeholders(EN[key]));
    }
  });

  it('the confirm sentence names the LANA, the fee, the shop and its wallet', () => {
    for (const p of ['{{lana}}', '{{fee}}', '{{name}}', '{{wallet}}']) expect(strings['directPay.confirmText']).toContain(p);
  });
});

describe('Slovenian, to the person who pays', () => {
  it('the confirm screen says it cannot be undone', () => {
    expect(SL['directPay.confirmText']).toBe('Plačali boste {{lana}} LANA in omrežnino {{fee}} LANA trgovini {{name}} ({{wallet}}). Plačila ni mogoče preklicati.');
  });
  it('a payment being checked: do not pay again, not with another card either', () => {
    expect(SL['directPay.unknownText']).toBe('Plačilo se preverja (običajno nekaj minut). Ne plačajte znova in ne plačajte z drugo kartico.');
    expect(SL['directPay.payAgainHint']).toBe('To ni drugo plačilo: porabi isti denar s kartice kot prejšnje, zato se lahko izvede samo eno od obeh.');
  });
  it('refused before anything was sent, and a refusal after it was sent is never "not made"', () => {
    expect(SL['directPay.refused']).toBe('Plačilo ni bilo izvedeno: {{reason}}');
    expect(SL['directPay.refusedSentText']).not.toContain('ni bilo izvedeno');
    expect(SL['directPay.resendRefusedByNetwork']).not.toContain('ni bilo izvedeno');
  });
  it('the key never leaves the device; the payment goes straight to the shop', () => {
    expect(SL['directPay.enterKey']).toContain('Ključ nikoli ne zapusti te naprave.');
    expect(SL['directPay.directNote']).toBe('Plačilo gre naravnost na denarnico trgovine.');
  });
});
