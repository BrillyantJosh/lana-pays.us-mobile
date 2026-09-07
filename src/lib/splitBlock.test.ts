/**
 * A deadline may only ever say something true. It disappears once it is past
 * (the switch, not the clock, ends the block), and midnight is named as the end
 * of the day it closes rather than as 00:00 of the next one.
 */
import { describe, it, expect } from 'vitest';
import { blockedUntil, parseUntil, untilMessage, formatDay, formatTime } from './splitBlock';

// The deadline the operator set for the Split: the end of Wednesday
// 9 Sept 2026, local time. In Ljubljana (CEST, UTC+2) that instant is 22:00 UTC.
const END_OF_WED = '2026-09-09T22:00:00.000Z';
const at = (iso: string) => new Date(iso);

describe('parseUntil', () => {
  it('takes an ISO instant and refuses anything else', () => {
    expect(parseUntil(END_OF_WED)?.toISOString()).toBe(END_OF_WED);
    expect(parseUntil('')).toBeNull();
    expect(parseUntil(null)).toBeNull();
    expect(parseUntil('soon')).toBeNull();
  });
});

describe('blockedUntil', () => {
  it('shows a deadline that is still ahead', () => {
    const b = blockedUntil(END_OF_WED, at('2026-09-07T10:00:00Z'));
    expect(b).not.toBeNull();
    expect(b!.at.toISOString()).toBe(END_OF_WED);
  });

  it('says NOTHING once the moment has passed — the lock is the switch, not the clock', () => {
    expect(blockedUntil(END_OF_WED, at('2026-09-09T22:00:01Z'))).toBeNull();
    expect(blockedUntil(END_OF_WED, at('2026-09-11T08:00:00Z'))).toBeNull();
  });

  it('is null at the deadline itself, not one second later', () => {
    expect(blockedUntil(END_OF_WED, at(END_OF_WED))).toBeNull();
    expect(blockedUntil(END_OF_WED, at('2026-09-09T21:59:59Z'))).not.toBeNull();
  });
});

describe('the wording', () => {
  it('names midnight as the end of the day it closes, not 00:00 of the next', () => {
    // Only meaningful where the runner sits at UTC+2; elsewhere the instant is
    // not local midnight and the exact-time wording is the correct answer.
    const b = blockedUntil(END_OF_WED, at('2026-09-07T10:00:00Z'))!;
    if (b.isMidnight) {
      expect(b.day.getDate()).toBe(9);
      expect(untilMessage(END_OF_WED, 'sl', at('2026-09-07T10:00:00Z'))!.key)
        .toBe('split.happening.untilMidnight');
    } else {
      expect(untilMessage(END_OF_WED, 'sl', at('2026-09-07T10:00:00Z'))!.key)
        .toBe('split.happening.until');
    }
  });

  it('a deadline in the middle of a day carries its clock time', () => {
    // 18:30 local, whatever the runner's zone: built from local parts.
    const local = new Date(2026, 8, 9, 18, 30, 0);
    const msg = untilMessage(local.toISOString(), 'en', new Date(2026, 8, 7))!;
    expect(msg.key).toBe('split.happening.until');
    expect(msg.values.time).toBe(formatTime(local, 'en'));
    expect(msg.values.day).toBe(formatDay(local, 'en'));
  });

  it('midnight local is described as the previous day, in any zone', () => {
    const midnight = new Date(2026, 8, 10, 0, 0, 0);   // 10 Sept 00:00 local
    const msg = untilMessage(midnight.toISOString(), 'sl', new Date(2026, 8, 7))!;
    expect(msg.key).toBe('split.happening.untilMidnight');
    expect(msg.values.day).toBe(formatDay(new Date(2026, 8, 9), 'sl'));
  });

  it('says nothing at all when there is no deadline', () => {
    expect(untilMessage('', 'en')).toBeNull();
    expect(untilMessage(null, 'sl')).toBeNull();
  });
});
