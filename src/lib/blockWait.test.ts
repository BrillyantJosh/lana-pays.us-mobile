/**
 * "Still waiting for a block" vs "failed" vs "being verified".
 *
 * The numbers are the real ones from 19 Oct 2026 (invoice »ziva center
 * 243640«, 643.359375 LANA): at 08:49 the buyer's wallet held 2143.50745637
 * LANA confirmed and -66.406943 LANA unconfirmed — a payment of 08:44:41 had
 * spent a 1216.90099088 LANA coin and not been mined yet. The page showed
 * 2077.1 LANA, "enough", signed with that same coin six times and was refused
 * six times with -22.
 */
import { describe, it, expect } from 'vitest';
import {
  blockWaitBeforeSigning, blockWaitAfterRejection, isStaleInputRejection, isOutcomeUnknown,
} from './blockWait';
import en from '@/i18n/locales/en.json';
import sl from '@/i18n/locales/sl.json';
import hu from '@/i18n/locales/hu.json';
import it_ from '@/i18n/locales/it.json';
import es from '@/i18n/locales/es.json';
import pl from '@/i18n/locales/pl.json';
import pt from '@/i18n/locales/pt.json';
import de from '@/i18n/locales/de.json';
import hr from '@/i18n/locales/hr.json';
import sr from '@/i18n/locales/sr.json';
import ru from '@/i18n/locales/ru.json';
import zh from '@/i18n/locales/zh.json';

const NEEDED = 64335937500; // 643.359375 LANA
const AT_0849 = { confirmed: 2143.51, unconfirmed: -66.41, unconfirmedLanoshis: -6640694300 };
const AFTER_BLOCK = { confirmed: 2077.1, unconfirmed: 0, unconfirmedLanoshis: 0 };
const BROKER_REASON = "Broadcast rejected: {u'message': u'TX rejected', u'code': -22}";

describe('before signing', () => {
  it('19 Oct 08:49: an earlier payment is still waiting for its block → wait, do not sign', () => {
    expect(blockWaitBeforeSigning(AT_0849, NEEDED)).toBe('outgoing');
  });

  it('08:56, after that block: nothing unconfirmed → go ahead', () => {
    expect(blockWaitBeforeSigning(AFTER_BLOCK, NEEDED)).toBeNull();
  });

  it('a pending consolidation (net = only its fee) still counts — that is why the exact lanoshis are sent', () => {
    const consolidating = { confirmed: 2143.51, unconfirmed: 0, unconfirmedLanoshis: -546600 };
    expect(blockWaitBeforeSigning(consolidating, NEEDED)).toBe('outgoing');
    // Without the exact figure the 2-decimal rounding hides it.
    expect(blockWaitBeforeSigning({ confirmed: 2143.51, unconfirmed: 0 }, NEEDED)).toBeNull();
  });

  it('falls back to the rounded figure when the server sends no exact one', () => {
    expect(blockWaitBeforeSigning({ confirmed: 2143.51, unconfirmed: -66.41 }, NEEDED)).toBe('outgoing');
  });

  it('LANA still arriving: wait only when the confirmed coins do not cover the payment', () => {
    expect(blockWaitBeforeSigning({ confirmed: 500, unconfirmed: 200 }, NEEDED)).toBe('incoming');
    expect(blockWaitBeforeSigning({ confirmed: 700, unconfirmed: 200 }, NEEDED)).toBeNull();
  });

  it('an unreadable balance never blocks (the node refuses a double spend by itself)', () => {
    expect(blockWaitBeforeSigning(null, NEEDED)).toBeNull();
    expect(blockWaitBeforeSigning(undefined, NEEDED)).toBeNull();
    expect(blockWaitBeforeSigning({}, NEEDED)).toBeNull();
  });
});

describe('after the brain answered CUSTOMER_LANA_FAILED', () => {
  it('recognises the refusal the brain relayed on 19 Oct', () => {
    expect(isStaleInputRejection(BROKER_REASON)).toBe(true);
    expect(isStaleInputRejection('txn-mempool-conflict')).toBe(true);
    expect(isStaleInputRejection('bad-txns-inputs-missingorspent')).toBe(true);
    expect(isStaleInputRejection('too-long-mempool-chain')).toBe(true);
    expect(isStaleInputRejection('min relay fee not met')).toBe(false);
    expect(isStaleInputRejection(undefined)).toBe(false);
  });

  it('-22 and a payment still unconfirmed → the wait, not a failure', () => {
    expect(blockWaitAfterRejection(BROKER_REASON, AT_0849)).toBe('outgoing');
    expect(blockWaitAfterRejection(BROKER_REASON, { confirmed: 10, unconfirmed: 5 })).toBe('incoming');
  });

  it('-22 with nothing unconfirmed, any other reason, or no balance → a genuine failure', () => {
    expect(blockWaitAfterRejection(BROKER_REASON, AFTER_BLOCK)).toBeNull();
    expect(blockWaitAfterRejection('min relay fee not met', AT_0849)).toBeNull();
    expect(blockWaitAfterRejection(BROKER_REASON, null)).toBeNull();
  });
});

describe('outcome unknown', () => {
  it('brain in doubt, or no answer from the brain → "being verified"', () => {
    expect(isOutcomeUnknown(409, { error: 'CUSTOMER_LANA_IN_DOUBT' })).toBe(true);
    expect(isOutcomeUnknown(502, { error: 'Failed to reach Brain service' })).toBe(true);
  });

  it('a refusal we understand is not "unknown"', () => {
    expect(isOutcomeUnknown(402, { error: 'CUSTOMER_LANA_FAILED' })).toBe(false);
    expect(isOutcomeUnknown(409, { error: 'DUPLICATE_INVOICE' })).toBe(false);
    expect(isOutcomeUnknown(409, { error: 'PREVIEW_STALE' })).toBe(false);
  });
});

describe('the words, in all 12 languages', () => {
  const LOCALES: Record<string, Record<string, string>> = { en, sl, hu, it: it_, es, pl, pt, de, hr, sr, ru, zh };
  const KEYS = [
    'lana.previousPaymentPending', 'lana.incomingPaymentPending',
    'purchase.waitingForBlockTitle', 'purchase.previousPaymentPending', 'purchase.incomingPaymentPending',
    'purchase.inReviewTitle', 'purchase.customerLanaInReview',
    'pay.inReview', 'pay.checkStatus',
  ];

  it('every key is present, non-empty and translated', () => {
    for (const [loc, d] of Object.entries(LOCALES)) {
      for (const k of KEYS) {
        expect(typeof d[k], `${loc}:${k}`).toBe('string');
        expect(d[k].trim().length, `${loc}:${k}`).toBeGreaterThan(0);
        if (loc !== 'en') expect(d[k], `${loc}:${k} is still English`).not.toBe((en as Record<string, string>)[k]);
      }
    }
  });

  it('the buyer reads the sentence Brilly asked for', () => {
    expect((sl as Record<string, string>)['lana.previousPaymentPending'])
      .toBe('Prejšnje plačilo še čaka na potrditev v bloku (običajno nekaj minut). Počakajte in poskusite znova.');
  });

  it('a wait or an unknown outcome is never worded as a failure', () => {
    const calm = KEYS.filter((k) => k !== 'pay.checkStatus');
    for (const k of calm) {
      expect((sl as Record<string, string>)[k], `sl:${k}`).not.toMatch(/ni uspel|ni prejeto/);
      expect((en as Record<string, string>)[k], `en:${k}`).not.toMatch(/failed|not received/i);
    }
    // The outcome may be paid: no "do not hand over the goods" verdict, only "once confirmed".
    for (const k of ['pay.inReview', 'purchase.customerLanaInReview']) {
      expect((sl as Record<string, string>)[k], `sl:${k}`).not.toMatch(/ne izročite/i);
      expect((en as Record<string, string>)[k], `en:${k}`).not.toMatch(/do not hand over/i);
    }
  });

  it('the wait says it is a block, and the unknown outcome says not to pay again', () => {
    for (const k of ['lana.previousPaymentPending', 'lana.incomingPaymentPending', 'purchase.previousPaymentPending', 'purchase.incomingPaymentPending']) {
      expect((sl as Record<string, string>)[k], `sl:${k}`).toMatch(/v bloku/);
      expect((en as Record<string, string>)[k], `en:${k}`).toMatch(/in a block/);
    }
    expect((sl as Record<string, string>)['pay.inReview']).toMatch(/Ne plačajte znova/);
    expect((sl as Record<string, string>)['purchase.customerLanaInReview']).toMatch(/ne prosite, naj plača znova/);
  });
});
