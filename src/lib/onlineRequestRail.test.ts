/**
 * Which rail the Lana-online form takes (lib/onlineRequestRail.ts, Brilly
 * 26 Nov 2026): a shop without a company makes a LANA neposredno link when the
 * switch names it, is told plainly when it does not, and every other shop takes
 * the brain's request exactly as before.
 */
import { describe, it, expect } from 'vitest';
import { onlineRequestRail, closedReasonKey, isDirectAmount, DIRECT_LANA_OFF } from './onlineRequestRail';

const ON = { enabled: true, reason: null };
const OFF = { enabled: false, reason: DIRECT_LANA_OFF };

describe('a shop without a company', () => {
  it('the switch names it: a LANA neposredno payment link', () => {
    expect(onlineRequestRail(true, ON)).toEqual({ rail: 'direct' });
  });

  it('the switch does not name it: closed, with the reason the server gave', () => {
    expect(onlineRequestRail(true, OFF)).toEqual({ rail: 'closed', reason: DIRECT_LANA_OFF });
  });

  it('what the shop lacks: closed, with that reason', () => {
    for (const reason of ['WALLET_INVALID', 'PAYEE_FROZEN', 'RATE_UNAVAILABLE', 'MARGIN_INVALID', 'UNIT_AUTHOR_MISMATCH']) {
      expect(onlineRequestRail(true, { enabled: false, reason })).toEqual({ rail: 'closed', reason });
    }
    expect(onlineRequestRail(true, { enabled: false, reason: null })).toEqual({ rail: 'closed', reason: 'OTHER' });
  });

  it('no view of it (an older server, a switch the till has not heard of): the link is tried and the server answers', () => {
    expect(onlineRequestRail(true, undefined)).toEqual({ rail: 'direct' });
    expect(onlineRequestRail(true, null)).toEqual({ rail: 'direct' });
  });
});

describe('every other shop: the brain\'s request, as before', () => {
  it('whatever a direct view would say', () => {
    expect(onlineRequestRail(false)).toEqual({ rail: 'brain' });
    expect(onlineRequestRail(false, ON)).toEqual({ rail: 'brain' });
    expect(onlineRequestRail(false, OFF)).toEqual({ rail: 'brain' });
  });
});

describe('what the seller reads when no link can be made', () => {
  it('the switch is off: "not switched on yet, the administrator switches it on", never the bank', () => {
    expect(closedReasonKey(DIRECT_LANA_OFF)).toBe('lanaOnline.directOff');
  });

  it('what the shop lacks: the notice of the home screen', () => {
    for (const reason of ['WALLET_INVALID', 'PAYEE_FROZEN', 'RATE_UNAVAILABLE', 'MARGIN_INVALID']) {
      expect(closedReasonKey(reason)).toBe(`directLana.notice.${reason}`);
    }
    for (const reason of ['UNIT_AUTHOR_MISMATCH', 'CURRENCY_UNSUPPORTED', 'OTHER', '', null, undefined]) {
      expect(closedReasonKey(reason as any)).toBe('directLana.notice.OTHER');
    }
  });
});

describe('the invoice amount of a link, as the server reads it', () => {
  it('whole, with one or two decimals, a point or a comma, above zero', () => {
    for (const ok of ['10', '10.5', '10,50', ' 12,50 ', '0.01', '1234567890123']) expect(isDirectAmount(ok), ok).toBe(true);
  });
  it('nothing else', () => {
    for (const no of ['', '0', '0,00', '12.505', '1.2.3', '-5', '12,5,0', 'abc', '12345678901234', '.5']) expect(isDirectAmount(no), no).toBe(false);
  });
});
