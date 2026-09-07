/**
 * UNTIL WHEN CASH IS BLOCKED.
 *
 * The Split lock is an operator switch: cash stays blocked until an admin turns
 * it off. This is the deadline that goes NEXT to it — what the seller is told,
 * so a blocked cash button is a wait with an end rather than a mystery.
 *
 * Two rules keep it honest:
 *
 *  1. The deadline never unblocks anything. Only the switch does. If the moment
 *     passes with the lock still on, this stops printing a date instead of
 *     showing one that is already in the past.
 *  2. Midnight is said the way people say it. The deadline for "Wednesday until
 *     midnight" is the instant the day ends, which a clock renders as 00:00 on
 *     THURSDAY — and "blocked until Thursday 00:00" reads like a whole extra
 *     day. When the instant falls on midnight in the reader's own timezone it
 *     is named as midnight at the end of the previous day.
 *
 * Everything is formatted in the READER's timezone, which is the only one they
 * can act on; a seller abroad sees their own clock, not Ljubljana's.
 */

/** A stored deadline, or null when unset/unparseable. */
export function parseUntil(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const at = new Date(String(iso));
  return Number.isNaN(at.getTime()) ? null : at;
}

export interface BlockedUntil {
  /** The deadline itself. */
  at: Date;
  /** True when it lands on midnight in the reader's timezone. */
  isMidnight: boolean;
  /** The day to name: the deadline's day, or the previous one at midnight. */
  day: Date;
}

/**
 * The deadline as something worth showing, or null when there is nothing
 * honest to say (unset, unparseable, or already past).
 */
export function blockedUntil(
  iso: string | null | undefined,
  now: Date = new Date(),
): BlockedUntil | null {
  const at = parseUntil(iso);
  if (!at) return null;
  if (at.getTime() <= now.getTime()) return null;
  const isMidnight = at.getHours() === 0 && at.getMinutes() === 0;
  const day = isMidnight ? new Date(at.getTime() - 24 * 60 * 60 * 1000) : at;
  return { at, isMidnight, day };
}

/** Weekday + date, in the reader's language: "Wed, 9 Sept 2026" / "sre., 9. 9. 2026". */
export function formatDay(day: Date, lng: string): string {
  try {
    return new Intl.DateTimeFormat(lng, {
      weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric',
    }).format(day);
  } catch {
    return day.toISOString().slice(0, 10);
  }
}

/** Clock time, in the reader's language: "18:30". */
export function formatTime(at: Date, lng: string): string {
  try {
    return new Intl.DateTimeFormat(lng, { hour: '2-digit', minute: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(11, 16);
  }
}

/**
 * The i18n key and its values for one deadline — the caller runs them through
 * `t`, so every language keeps its own sentence rather than a stitched string.
 */
export function untilMessage(
  iso: string | null | undefined,
  lng: string,
  now: Date = new Date(),
): { key: 'split.happening.untilMidnight' | 'split.happening.until'; values: Record<string, string> } | null {
  const until = blockedUntil(iso, now);
  if (!until) return null;
  const day = formatDay(until.day, lng);
  return until.isMidnight
    ? { key: 'split.happening.untilMidnight', values: { day } }
    : { key: 'split.happening.until', values: { day, time: formatTime(until.at, lng) } };
}
