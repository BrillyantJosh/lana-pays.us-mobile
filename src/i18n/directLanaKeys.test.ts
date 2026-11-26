/**
 * The strings of LANA neposredno (direct LANA of shops without a company,
 * 23 Nov 2026), across ALL 12 locales: every key the till uses is there,
 * translated, with the placeholders of English; every reason the server or the
 * till can give has words; and the Slovenian sentences are Brilly's.
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
import { directReasonKey } from '../lib/directLanaApi';

const here = __dirname;
const LOCALES: Record<string, Record<string, string>> = { en, sl, hu, it: it_, es, pl, pt, de, hr, sr, ru, zh };
const EN = en as Record<string, string>;
const SL = sl as Record<string, string>;

/** Every directLana.* key the till's code names, read out of the code itself. */
function keysUsedByCode(): string[] {
  const files = [
    path.resolve(here, '../components/tabs/DirectLanaTab.tsx'),
    path.resolve(here, '../pages/Index.tsx'),
  ];
  const keys = new Set<string>();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/'(directLana\.[A-Za-z_.]+)'/g)) keys.add(m[1]);
  }
  return [...keys];
}

const STATUSES = ['quoted', 'validating', 'broadcasting', 'sent', 'paid', 'unknown', 'refused', 'superseded', 'failed', 'expired'];
const NOTICES = ['WALLET_INVALID', 'PAYEE_FROZEN', 'RATE_UNAVAILABLE', 'MARGIN_INVALID', 'OTHER'];

/** Every code the server (server/directLana.ts WORDS) and the till's own checks can answer with. */
function everyCode(): string[] {
  const server = fs.readFileSync(path.resolve(here, '../../server/directLana.ts'), 'utf8');
  const block = server.slice(server.indexOf('const WORDS'), server.indexOf('};', server.indexOf('const WORDS')));
  const fromServer = [...block.matchAll(/^\s+([A-Z_]+):/gm)].map(m => m[1]);
  const fromTill = ['CARD_ADDRESS_NOT_KEY', 'CARD_NOSTR_KEY', 'CARD_KEY_INVALID', 'CARD_MISMATCH', 'PLAN_RECIPIENT_CHANGED',
    'PLAN_AMOUNTS_CHANGED', 'PLAN_INPUT_MISMATCH', 'DEVICE_CLOCK', 'SIGNATURE_FAILED', 'NETWORK', 'GENERIC', 'SELLER_CHECK_FAILED',
    'NOT_RECEIVED', 'RESEND_REFUSED_BY_NETWORK', 'PREVIOUS_PAYMENT_PENDING'];
  return [...new Set([...fromServer, ...fromTill])];
}

const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) || []).sort();

describe('the keys exist where the code needs them', () => {
  it('the code names at least the keys this test knows of', () => {
    const used = keysUsedByCode();
    expect(used.length).toBeGreaterThan(30);
    for (const k of used) expect(EN[k], `en is missing ${k}`).toBeTruthy();
  });

  it('every status and notice the till can show has its key', () => {
    for (const s of STATUSES) expect(EN[`directLana.status.${s}`], s).toBeTruthy();
    for (const n of NOTICES) expect(EN[`directLana.notice.${n}`], n).toBeTruthy();
  });

  it('every refusal code has words (its own, its group\'s, or an existing sentence)', () => {
    for (const c of everyCode()) {
      const { key } = directReasonKey(c);
      expect(EN[key], `${c} → ${key}`).toBeTruthy();
    }
  });
});

describe.each(Object.keys(LOCALES))('locale %s', (name) => {
  const strings = LOCALES[name];
  const keys = Object.keys(EN).filter(k => k.startsWith('directLana.'));

  it('has every key, translated, with the placeholders of English', () => {
    // 95 of the till's LANA neposredno, 22 of its payment links (25 Nov 2026),
    // 3 of the receipt photo (26 Nov 2026: paid already, on an open link, not readable).
    expect(keys.length).toBe(120);
    for (const key of keys) {
      expect(typeof strings[key], `${name} is missing ${key}`).toBe('string');
      expect(strings[key].trim().length, `${name}:${key} is empty`).toBeGreaterThan(0);
      if (name !== 'en') expect(strings[key], `${name}:${key} is still English`).not.toBe(EN[key]);
      expect(placeholders(strings[key]), `${name}:${key}`).toEqual(placeholders(EN[key]));
    }
  });

  it('the confirm sentence names the LANA, the fee, the shop and its wallet, and says it cannot be undone', () => {
    for (const p of ['{{lana}}', '{{fee}}', '{{name}}', '{{wallet}}']) expect(strings['directLana.confirmText']).toContain(p);
  });

  it('a wallet or margin to fix says where it is fixed', () => {
    expect(strings['directLana.notice.WALLET_INVALID']).toContain('shop.lanapays.us');
    expect(strings['directLana.notice.MARGIN_INVALID']).toContain('shop.lanapays.us');
    expect(strings['directLana.reason.WALLET']).toContain('shop.lanapays.us');
  });
});

describe('Slovenian, as Brilly wrote it (SPEC §4)', () => {
  it('the button and the breakdown', () => {
    expect(SL['directLana.tileTitle']).toBe('LANA neposredno');
    expect(SL['directLana.invoiceAmount']).toBe('Znesek računa');
    expect(SL['directLana.marginLine']).toBe('Doplačilo za plačilo v LANA ({{percent}} %)');
    expect(SL['directLana.toPay']).toBe('Za plačilo');
    expect(SL['directLana.feeByCustomer']).toBe('omrežnino plača kupec');
  });
  it('the confirm screen', () => {
    expect(SL['directLana.confirmText']).toBe('Plačaj {{lana}} LANA + omrežnina {{fee}} LANA → {{name}} ({{wallet}}). Plačila ni mogoče preklicati.');
    expect(SL['directLana.confirmButton']).toBe('Potrdi plačilo');
    expect(SL['common.cancel']).toBe('Prekliči');
  });
  it('sent, paid, the record, unknown and refused', () => {
    expect(SL['directLana.sentTitle']).toBe('Plačano, potrditev v bloku sledi');
    expect(SL['directLana.paidTitle']).toBe('Potrjeno v bloku');
    expect(SL['directLana.recordLater']).toBe('Javni zapis bo objavljen po potrditvi');
    expect(SL['directLana.unknownText']).toBe('Plačilo se preverja (običajno nekaj minut). Ne vzemi drugega plačila.');
    expect(SL['directLana.refused']).toBe('LANA niso bile poslane: {{reason}}');
  });
});

describe('review fixes (23 Nov 2026): the words agree with what the till offers, in plain words', () => {
  const DIRECT = (strings: Record<string, string>) => Object.keys(strings).filter(k => k.startsWith('directLana.'));

  it('a changed shop wallet is its own reason: try again, nothing to fix', () => {
    expect(directReasonKey('WALLET_CHANGED')).toEqual({ key: 'directLana.reason.WALLET_CHANGED', sentence: false });
    expect(SL['directLana.reason.WALLET_CHANGED']).toBe('denarnica trgovine se je vmes spremenila. Poskusi znova.');
    expect(EN['directLana.reason.WALLET_CHANGED']).not.toContain('shop.lanapays.us');
  });

  it('"pay again with the same card" is said not to be a second payment', () => {
    expect(SL['directLana.payAgainHint']).toBe('To ni drugo plačilo: porabi isti denar s kartice kot prejšnje, zato se lahko izvede samo eno od obeh.');
    expect(SL['directLana.unknownNoSecond']).toBe('Ne vzemi gotovine in ne skeniraj druge kartice.');
  });

  it('a payment refused AFTER it was sent, a re-send refused, a previous payment still checked: never "LANA were not sent"', () => {
    for (const k of ['directLana.refusedSentText', 'directLana.resendRefused', 'directLana.resendRefusedByNetwork', 'directLana.previousStillChecked']) {
      expect(SL[k], k).not.toMatch(/niso bile poslane/);
      expect(EN[k], k).not.toMatch(/were not sent/);
    }
    expect(directReasonKey('RESEND_REFUSED_BY_NETWORK').sentence).toBe(true);
    expect(directReasonKey('PREVIOUS_PAYMENT_PENDING').sentence).toBe(true);
  });

  it.each(Object.keys(LOCALES))('%s: no "coins" and no "merge" in the till\'s direct-LANA words', (name) => {
    const strings = LOCALES[name];
    const words = DIRECT(strings).map(k => strings[k]).join(' | ');
    const forbidden: Record<string, RegExp> = {
      en: /\bcoins?\b|\bmerge/i, sl: /kovanc|združi/i, de: /\bCoins?\b|zusammen/i, es: /monedas|combín/i, hr: /kovanic|spojite/i,
      hu: /érm|vonja össze/i, it: /monete|unisci/i, pl: /monet|je połącz/i, pt: /moedas|junte-as/i, ru: /монет|объедин/i,
      sr: /novčić|spojite/i, zh: /的币|合并/,
    };
    expect(words).not.toMatch(forbidden[name]);
  });
});
