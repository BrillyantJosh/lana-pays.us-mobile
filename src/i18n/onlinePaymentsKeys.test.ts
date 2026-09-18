/**
 * "Online payments" — i18n completeness and WORDING across all 12 locales.
 *
 * This page tells a merchant whether an investor has paid them. The words carry
 * the money claim, so two rules are pinned beside completeness:
 *
 *   - "the investor MARKED it paid" is all anybody knows — the investor ticks a
 *     box on direct.lana.fund and no bank statement is checked. No investor
 *     string and not the explanatory note may say the bank confirmed anything.
 *     The NEGATIVE side is worded the same way: "has not marked it paid yet",
 *     never "has not paid" — an investor who wired the money but has not
 *     ticked the box yet has paid.
 *   - the page lists every request on the signer's units, whoever created it,
 *     so no string may say "you created".
 *   - the dedup self-heal case says "paid" (as the Lana-online tab and the
 *     toast do) AND that the system has not confirmed it.
 *   - the menu entry must differ from every other entry in the drawer, which
 *     renders them with key={label}; two equal labels would collide.
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

const KEYS = [
  'menu.onlinePayments',
  ...['title', 'subtitle', 'allUnits', 'customer', 'investor',
    'customerWaiting', 'customerProcessing', 'customerPaid', 'customerPaidUnconfirmed', 'customerCancelled',
    'customerExpired', 'customerUnverified',
    'investorNotApplicable', 'investorWaiting', 'investorMarkedPaid', 'investorPartly', 'investorUnknown',
    'investorUnavailable', 'investorOwnerOnly',
    'invoiceLeg', 'rewardLeg', 'markedPaidNote', 'checkedAt', 'refresh', 'empty',
    'sigClock', 'sigRelogin', 'loadError'].map((k) => `onlinePayments.${k}`),
];

/** Words that are genuinely the same in a language as in English. */
const SAME_AS_ENGLISH = new Set(['de:onlinePayments.investor']);

/** The other entries the drawer renders next to this one (MenuDrawer.tsx). */
const DRAWER_LABELS = [
  'menu.editProfile', 'menu.editShop', 'menu.myTrades', 'orders.history', 'menu.caretaker',
  'menu.checkCustomerBalance', 'menu.registerCustomer', 'menu.regularCustomers', 'menu.orderKeys',
];

const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) || []).sort();

describe('online payments i18n keys', () => {
  it('lists exactly 12 locales', () => {
    expect(Object.keys(LOCALES)).toHaveLength(12);
  });

  for (const [lang, dict] of Object.entries(LOCALES)) {
    it(`${lang} has every key, non-empty, with the same placeholders as en`, () => {
      const missing = KEYS.filter((k) => typeof dict[k] !== 'string' || dict[k].trim() === '');
      expect(missing).toEqual([]);
      for (const k of KEYS) expect(placeholders(dict[k]), `${lang}:${k}`).toEqual(placeholders(EN[k]));
    });

    if (lang !== 'en') {
      it(`${lang} is translated, not English pasted in`, () => {
        const untranslated = KEYS.filter((k) => dict[k] === EN[k] && !SAME_AS_ENGLISH.has(`${lang}:${k}`));
        expect(untranslated).toEqual([]);
      });
    }

    it(`${lang}: the menu entry differs from every other drawer entry`, () => {
      const label = (k: string) => dict[k] ?? EN[k]; // i18next falls back to English
      const mine = label('menu.onlinePayments');
      for (const other of DRAWER_LABELS) expect(label(other), `${lang}: collides with ${other}`).not.toBe(mine);
    });
  }

  it('no investor string and not the note claims the bank confirmed the payment', () => {
    const claimKeys = KEYS.filter((k) => k.startsWith('onlinePayments.investor') || k === 'onlinePayments.markedPaidNote');
    for (const k of claimKeys) {
      expect(EN[k].toLowerCase(), `en:${k}`).not.toContain('confirmed by the bank');
      expect(EN[k].toLowerCase(), `en:${k}`).not.toMatch(/bank (has )?confirmed/);
      expect((sl as Record<string, string>)[k].toLowerCase(), `sl:${k}`).not.toContain('banka je potrdila');
    }
  });

  it('"not paid yet" on the investor side says NOT MARKED, in English and in Slovenian', () => {
    expect(EN['onlinePayments.investorWaiting']).toContain('marked');
    expect(EN['onlinePayments.investorWaiting']).not.toMatch(/has not paid/);
    expect((sl as Record<string, string>)['onlinePayments.investorWaiting']).toContain('označil');
    expect((sl as Record<string, string>)['onlinePayments.investorWaiting']).not.toMatch(/ni plačal/);
  });

  it('no string says "you created" — the list is every request on the signer\'s units', () => {
    for (const k of ['onlinePayments.subtitle', 'onlinePayments.empty']) {
      expect(EN[k].toLowerCase(), `en:${k}`).not.toContain('created');
      expect((sl as Record<string, string>)[k].toLowerCase(), `sl:${k}`).not.toContain('ustvaril');
    }
  });

  it('the dedup self-heal says paid, and that the system has not confirmed it', () => {
    expect(EN['onlinePayments.customerPaidUnconfirmed']).toMatch(/^Paid/);
    expect(EN['onlinePayments.customerPaidUnconfirmed']).toContain('not confirmed');
    expect((sl as Record<string, string>)['onlinePayments.customerPaidUnconfirmed']).toMatch(/^Plačano/);
    expect((sl as Record<string, string>)['onlinePayments.customerPaidUnconfirmed']).toContain('brez potrdila');
  });

  it('"marked paid" says MARKED, in English and in Slovenian', () => {
    expect(EN['onlinePayments.investorMarkedPaid']).toContain('marked');
    expect((sl as Record<string, string>)['onlinePayments.investorMarkedPaid']).toContain('označil');
    expect(EN['onlinePayments.markedPaidNote']).toContain('not a bank confirmation');
    expect((sl as Record<string, string>)['onlinePayments.markedPaidNote']).toContain('ni potrdilo banke');
  });
});
