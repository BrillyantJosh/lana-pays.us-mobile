/**
 * Lana Online Shop — i18n completeness across ALL 12 locales.
 *
 * "Mark shipped" is a delivery obligation, not decoration: a merchant whose
 * app falls back to English for the Orders button may not understand what
 * they are confirming. The key NAMES are frozen in SPEC.md §13; this pins
 * that every locale carries every one of them, non-empty, with the same
 * {{placeholders}} as English.
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

/** SPEC.md §13 — mobile locales (ALL 12). */
const SPEC_KEYS = [
  'home.orders', 'home.ordersSubtitle',
  'orders.title', 'orders.pending', 'orders.all', 'orders.empty', 'orders.history', 'orders.historyTitle',
  'orders.items', 'orders.shippingFee', 'orders.buyer', 'orders.showDetails', 'orders.hideDetails',
  'orders.decryptFailed', 'orders.markShipped', 'orders.markDelivered', 'orders.confirmShipped',
  'orders.confirmDelivered', 'orders.carrier', 'orders.tracking', 'orders.paidToast', 'orders.publishFailed',
  'orders.statusUnpaid', 'orders.statusPaid', 'orders.statusAmountMismatch', 'orders.statusReceived',
  'orders.statusConfirmed', 'orders.statusPacked', 'orders.statusShipped', 'orders.statusDelivered',
  'orders.statusCompleted', 'orders.statusRejected', 'orders.statusRefunded', 'orders.statusExpired',
  'orders.statusCancelled',
];

/** UI strings the Orders screens need beyond the frozen list (same rule: every locale). */
const EXTRA_KEYS = [
  'orders.reject', 'orders.confirmReject', 'orders.confirmRefunded', 'orders.total',
  'orders.fulfillmentShipping', 'orders.fulfillmentPickup', 'orders.priceChanged',
];

const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) || []).sort();

describe('orders i18n keys', () => {
  it('lists exactly 12 locales', () => {
    expect(Object.keys(LOCALES)).toHaveLength(12);
  });

  for (const [lang, dict] of Object.entries(LOCALES)) {
    it(`${lang} has every SPEC §13 key (+ the UI extras), non-empty, same placeholders as en`, () => {
      const missing = [...SPEC_KEYS, ...EXTRA_KEYS].filter(k => typeof dict[k] !== 'string' || dict[k].trim() === '');
      expect(missing).toEqual([]);
      for (const k of [...SPEC_KEYS, ...EXTRA_KEYS]) {
        expect(placeholders(dict[k]), `${lang}:${k}`).toEqual(placeholders((en as Record<string, string>)[k]));
      }
    });
  }

  it('the frozen list is the one the components use for statuses', () => {
    for (const s of ['unpaid', 'paid', 'amount_mismatch', 'received', 'confirmed', 'packed', 'shipped', 'delivered', 'completed', 'rejected', 'refunded', 'expired', 'cancelled']) {
      const cap = s.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
      expect(SPEC_KEYS).toContain(`orders.status${cap}`);
    }
  });
});
