/**
 * What the browser believes when it cannot get an answer.
 *
 * The two rules pull opposite ways and both matter:
 *   - a failed check must never RELEASE someone we already know is excluded,
 *   - a failed check must never INVENT a sanction against someone we don't.
 *
 * The second one is not politeness: this is a shop till, and a server hiccup
 * that locked every merchant out of their own POS behind a "you are excluded"
 * screen would be its own kind of harm.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkExclusion, rememberedExclusion, forgetExclusion, exclusionFromRefusal, isMerchantUnavailable } from './exclusion';

const PERSON = '56e8670aa65491f8595dc3a71c94aa7445dcdca755ca5f77c07218498a362061';
// Synthetic on purpose — see server/lib/exclusionGate.test.ts.
const FREE = 'dededededededededededededededededededededededededededededededede';

const refusalBody = {
  excluded: true,
  ground: 'the stated ground',
  since: 1700000000,
  untilSplit: null,
  eventId: 'ev1',
};

const answers = (body: any, ok = true, status = 200) =>
  vi.fn().mockResolvedValue({ ok, status, json: async () => body } as any);

/**
 * A real Storage, because this runner does not have one: under Node 22 the
 * `localStorage` global is an empty object with no getItem/setItem at all, and
 * it shadows jsdom's. The module under test guards every access in try/catch —
 * which is exactly why the missing API would make these tests pass for the
 * wrong reason, silently proving nothing about remembering a decision.
 */
const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a clear answer', () => {
  it('excludes, and remembers it', async () => {
    vi.stubGlobal('fetch', answers(refusalBody));
    const verdict = await checkExclusion(PERSON);
    expect(verdict).not.toBeNull();
    expect(verdict!.ground).toBe('the stated ground');
    expect(verdict!.untilSplit).toBeNull();
    expect(rememberedExclusion(PERSON)!.ground).toBe('the stated ground');
  });

  it('a clear "no" releases, and forgets', async () => {
    vi.stubGlobal('fetch', answers(refusalBody));
    await checkExclusion(PERSON);
    vi.stubGlobal('fetch', answers({ excluded: false, ground: null, since: null, untilSplit: null, eventId: null }));
    expect(await checkExclusion(PERSON)).toBeNull();
    expect(rememberedExclusion(PERSON)).toBeNull();
  });

  it('asks about the person it was given', async () => {
    const f = answers({ excluded: false });
    vi.stubGlobal('fetch', f);
    await checkExclusion(PERSON);
    expect(f.mock.calls[0][0]).toBe(`/api/exclusion/${PERSON}`);
  });
});

describe('a check that cannot get through', () => {
  const brokenAnswers = [
    ['the network is down', () => vi.fn().mockRejectedValue(new Error('offline'))],
    ['the server says 500', () => answers({ error: 'boom' }, false, 500)],
    ['the rate limiter says 429', () => answers('Too many requests', false, 429)],
    ['the body will not parse', () => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('not json'); } })],
    ['the SPA catch-all answered index.html with 200', () => answers({ some: 'html-ish object' })],
  ] as const;

  for (const [label, makeFetch] of brokenAnswers) {
    it(`never releases a person we already know about — ${label}`, async () => {
      vi.stubGlobal('fetch', answers(refusalBody));
      await checkExclusion(PERSON);           // learn it once
      vi.stubGlobal('fetch', makeFetch());
      const verdict = await checkExclusion(PERSON);
      expect(verdict, 'an outage lifted a standing decision').not.toBeNull();
      expect(verdict!.ground).toBe('the stated ground');
      expect(rememberedExclusion(PERSON)).not.toBeNull();
    });

    it(`never invents one against a person we do not — ${label}`, async () => {
      vi.stubGlobal('fetch', makeFetch());
      expect(await checkExclusion(FREE), 'an outage locked out someone who was never excluded').toBeNull();
    });
  }
});

describe('the remembered decision', () => {
  it('survives a reload, because it lives in localStorage', async () => {
    vi.stubGlobal('fetch', answers(refusalBody));
    await checkExclusion(PERSON);
    // A fresh page has no module state, only what is on disk.
    expect(rememberedExclusion(PERSON)!.since).toBe(1700000000);
  });

  it('is per person, not per browser', async () => {
    vi.stubGlobal('fetch', answers(refusalBody));
    await checkExclusion(PERSON);
    expect(rememberedExclusion(FREE)).toBeNull();
  });

  it('is keyed the way the fleet keys it', async () => {
    vi.stubGlobal('fetch', answers(refusalBody));
    await checkExclusion(PERSON);
    expect(localStorage.getItem(`lana_excluded_${PERSON}`)).toBeTruthy();
  });

  it('ignores a hex that is not a hex, and rubbish in storage', async () => {
    expect(await checkExclusion('nope')).toBeNull();
    expect(await checkExclusion('')).toBeNull();
    expect(await checkExclusion(null)).toBeNull();
    localStorage.setItem(`lana_excluded_${PERSON}`, 'not json');
    expect(rememberedExclusion(PERSON)).toBeNull();
  });

  it('can be cleared', async () => {
    vi.stubGlobal('fetch', answers(refusalBody));
    await checkExclusion(PERSON);
    forgetExclusion(PERSON);
    expect(rememberedExclusion(PERSON)).toBeNull();
  });
});

describe('a refusal from any gated route', () => {
  it('carries enough to show the same screen', () => {
    const v = exclusionFromRefusal({ code: 'PERSON_EXCLUDED', ...refusalBody });
    expect(v!.ground).toBe('the stated ground');
    expect(v!.since).toBe(1700000000);
  });

  it('is not confused with any other 403 this app already returns', () => {
    expect(exclusionFromRefusal({ error: 'MERCHANT_SUSPENDED' })).toBeNull();
    expect(exclusionFromRefusal({ success: false, error: 'NOT_AUTHORIZED' })).toBeNull();
    expect(exclusionFromRefusal({ error: 'SPLIT_HAPPENING', until: 'x' })).toBeNull();
    expect(exclusionFromRefusal(null)).toBeNull();
    expect(exclusionFromRefusal('nope')).toBeNull();
  });
});

describe('a server that has never been told anything', () => {
  it('does not release a person this device is already showing the door to', async () => {
    // A freshly deployed container answers from an EMPTY table, and
    // "excluded: false" out of an empty table is not an all-clear — it is
    // "I have never heard". Believing it hands the person their till back mid
    // sanction, at exactly the moment a deploy lands.
    vi.stubGlobal('fetch', answers(refusalBody));
    await checkExclusion(PERSON);
    vi.stubGlobal('fetch', answers({ excluded: false, known: false }));
    const still = await checkExclusion(PERSON);
    expect(still, 'a deploy with an empty table released a standing decision').not.toBeNull();
    expect(still!.ground).toBe('the stated ground');
    expect(rememberedExclusion(PERSON)).not.toBeNull();
  });

  it('still does not invent a sanction against somebody it has never heard of', async () => {
    vi.stubGlobal('fetch', answers({ excluded: false, known: false }));
    expect(await checkExclusion(FREE)).toBeNull();
  });

  it('a KNOWN all-clear does lift — that is what a withdrawal has to be able to do', async () => {
    vi.stubGlobal('fetch', answers(refusalBody));
    await checkExclusion(PERSON);
    vi.stubGlobal('fetch', answers({ excluded: false, known: true }));
    expect(await checkExclusion(PERSON)).toBeNull();
    expect(rememberedExclusion(PERSON)).toBeNull();
  });

  it('an older server that does not send `known` at all is still an answer', async () => {
    // Otherwise a rolling deploy freezes every device on its remembered verdict.
    vi.stubGlobal('fetch', answers(refusalBody));
    await checkExclusion(PERSON);
    vi.stubGlobal('fetch', answers({ excluded: false }));
    expect(await checkExclusion(PERSON)).toBeNull();
  });
});

describe('a sale refused because of the SHOP', () => {
  it('is never read as a personal exclusion', () => {
    const body = { success: false, error: 'This shop cannot take payments at the moment', code: 'MERCHANT_UNAVAILABLE' };
    expect(isMerchantUnavailable(body)).toBe(true);
    expect(exclusionFromRefusal(body), 'a clean buyer was shown the closed-door screen').toBeNull();
  });

  it('and a personal exclusion is not read as a shop problem', () => {
    expect(isMerchantUnavailable({ code: 'PERSON_EXCLUDED', ...refusalBody })).toBe(false);
    expect(isMerchantUnavailable(null)).toBe(false);
    expect(isMerchantUnavailable({ error: 'NOT_AUTHORIZED' })).toBe(false);
  });
});
