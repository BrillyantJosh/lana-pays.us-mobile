/**
 * Client side of the gross-violation gate (Nostr KIND 87058).
 *
 * The server holds the standing set and answers one question at
 * GET /api/exclusion/:hexId. This module asks it, and — importantly — decides
 * what to believe when it cannot get an answer.
 *
 * TWO RULES, and they pull in opposite directions on purpose:
 *
 *   1. A failed check must never RELEASE anyone. So a decision we have already
 *      been told about is remembered in localStorage under `lana_excluded_<hex>`
 *      and keeps standing while the server is unreachable.
 *   2. A failed check must never INVENT a sanction. So somebody we have never
 *      been told about stays un-excluded when the check fails — an outage must
 *      not lock a whole till out of its own POS.
 *
 * Only a clear, successful "no" clears the memory; that is what lets a withdrawn
 * decision actually lift.
 */

export interface ExclusionVerdict {
  /** The commission's own words. Empty when the report itself could not be read. */
  ground?: string;
  /** Unix seconds the decision took effect. */
  since?: number;
  /** The SPLIT round it runs to, or null when it has no end. */
  untilSplit?: number | null;
  eventId?: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;

const storageKey = (hex: string) => `lana_excluded_${hex.toLowerCase()}`;

/** What we were last told about this person, if anything. */
export function rememberedExclusion(hex: string | null | undefined): ExclusionVerdict | null {
  if (!hex || !HEX64.test(hex)) return null;
  try {
    const raw = localStorage.getItem(storageKey(hex));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as ExclusionVerdict) : null;
  } catch {
    return null;
  }
}

export function rememberExclusion(hex: string, verdict: ExclusionVerdict): void {
  try { localStorage.setItem(storageKey(hex), JSON.stringify(verdict)); } catch { /* private mode */ }
}

export function forgetExclusion(hex: string): void {
  try { localStorage.removeItem(storageKey(hex)); } catch { /* private mode */ }
}

/**
 * Ask the server about one person.
 *
 * Returns the standing decision, or null when this person may use the app.
 * Anything that is not a clean answer — network error, 429, 5xx, HTML from the
 * SPA catch-all, unparseable body — falls back to what we already knew.
 */
export async function checkExclusion(hex: string | null | undefined): Promise<ExclusionVerdict | null> {
  if (!hex || !HEX64.test(hex)) return null;

  let res: Response;
  try {
    res = await fetch(`/api/exclusion/${hex}`, { headers: { Accept: 'application/json' } });
  } catch {
    return rememberedExclusion(hex);
  }

  if (!res.ok) return rememberedExclusion(hex);

  let body: any;
  try {
    body = await res.json();
  } catch {
    return rememberedExclusion(hex);
  }

  // The SPA catch-all would answer index.html with 200; a body that is not the
  // shape we asked for is not an answer, so it must not release anyone either.
  if (!body || typeof body !== 'object' || typeof body.excluded !== 'boolean') {
    return rememberedExclusion(hex);
  }

  if (!body.excluded) {
    // "Nobody is excluded" and "I have never been told about anybody" are the
    // same sentence from an empty table, and a freshly deployed container says
    // it with total confidence. `known: false` means this server has never had
    // a report from a trusted signer, so its "no" is not an all-clear — it must
    // not lift a decision this device is already showing.
    //
    // `known` absent entirely (a server from before this field existed) is
    // treated as an answer, so a rolling deploy does not freeze every device on
    // a remembered verdict.
    if (body.known === false) return rememberedExclusion(hex);
    forgetExclusion(hex);
    return null;
  }

  const verdict: ExclusionVerdict = {
    ground: typeof body.ground === 'string' ? body.ground : '',
    since: Number(body.since) || undefined,
    untilSplit: body.untilSplit == null ? null : Number(body.untilSplit),
    eventId: typeof body.eventId === 'string' ? body.eventId : undefined,
  };
  rememberExclusion(hex, verdict);
  return verdict;
}

/**
 * The exclusion carried by a server refusal, or null if that is not what it was.
 *
 * Every gated route answers 403 with `code: 'PERSON_EXCLUDED'`, so a client that
 * only ever sees the refusal can still show the person the real reason.
 *
 * `MERCHANT_UNAVAILABLE` is deliberately NOT this. That refusal is about the
 * SHOP, it reaches a buyer or a clean staff member who is the subject of
 * nothing, and reading it as a personal exclusion is how a clean person ends up
 * looking at the closed-door screen.
 */
export const MERCHANT_UNAVAILABLE_CODE = 'MERCHANT_UNAVAILABLE';

/** True when a sale was refused because of the seller, not the person asking. */
export function isMerchantUnavailable(body: any): boolean {
  return !!body && typeof body === 'object' && body.code === MERCHANT_UNAVAILABLE_CODE;
}

export function exclusionFromRefusal(body: any): ExclusionVerdict | null {
  if (!body || typeof body !== 'object' || body.code !== 'PERSON_EXCLUDED') return null;
  return {
    ground: typeof body.ground === 'string' ? body.ground : '',
    since: Number(body.since) || undefined,
    untilSplit: body.untilSplit == null ? null : Number(body.untilSplit),
    eventId: typeof body.eventId === 'string' ? body.eventId : undefined,
  };
}
