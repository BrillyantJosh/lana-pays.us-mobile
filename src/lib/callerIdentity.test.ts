/**
 * The name the till sends with a request that costs money.
 *
 * /api/brain/purchase carried the customer and the unit but never the person
 * operating the till, and /api/upload, /api/receipt/upload and
 * /api/receipt/analyze carried no identity at all — so the gate had nothing to
 * refuse, an excluded merchant kept selling, and an excluded merchant kept
 * spending the Claude receipt-analysis budget.
 *
 * What is pinned here is only that the name is attached, and attached in the
 * shape the server reads it: a header for JSON, a form field for multipart.
 * It is NOT authentication and this file does not pretend otherwise — see the
 * module header. Nothing signs it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callerHex, withCallerHex, withCallerField, SESSION_KEY } from './callerIdentity';

const PERSON = 'ab'.repeat(32);

/** This runner has no real Storage — see src/lib/exclusion.test.ts. */
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

const signIn = (over: Record<string, unknown> = {}) =>
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    walletId: 'LZZZ', nostrHexId: PERSON, nostrNpubId: 'npub1', privateKeyHex: '00'.repeat(32),
    currency: 'EUR', expiresAt: Date.now() + 60 * 60 * 1000, ...over,
  }));

beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('who the till says it is', () => {
  it('is the signed-in person', () => {
    signIn();
    expect(callerHex()).toBe(PERSON);
  });

  it('is nobody when nobody is signed in', () => {
    expect(callerHex()).toBeNull();
  });

  it('is nobody when the session has run out', () => {
    signIn({ expiresAt: Date.now() - 1000 });
    expect(callerHex()).toBeNull();
  });

  it('is nobody when the stored session is corrupt, rather than throwing at the call site', () => {
    localStorage.setItem(SESSION_KEY, '{not json');
    expect(callerHex()).toBeNull();
  });

  it('is nobody when the stored hex is not a hex', () => {
    signIn({ nostrHexId: 'not-a-key' });
    expect(callerHex()).toBeNull();
  });

  it('survives a browser that refuses storage entirely', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('access denied'); },
    } as any);
    expect(callerHex()).toBeNull();
  });
});

describe('attaching it to a request', () => {
  it('puts the name in x-lana-hex without losing the caller\'s own headers', () => {
    signIn();
    expect(withCallerHex({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
      'x-lana-hex': PERSON,
    });
  });

  it('sends no name at all rather than an empty one when nobody is signed in', () => {
    const headers = withCallerHex({ 'Content-Type': 'application/json' });
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
    expect('x-lana-hex' in headers, 'a blank name is worse than none — the server cannot tell them apart').toBe(false);
  });

  it('puts the name in the multipart body, where multer leaves it on req.body', () => {
    signIn();
    const form = withCallerField(new FormData());
    expect(form.get('hex')).toBe(PERSON);
  });

  it('returns the SAME FormData so the call site can use it inline', () => {
    signIn();
    const form = new FormData();
    form.append('receipt', new Blob(['x']), 'r.jpg');
    expect(withCallerField(form)).toBe(form);
    expect(form.get('receipt')).not.toBeNull();
  });

  it('adds no field when nobody is signed in — the server then refuses, which is the point', () => {
    expect(withCallerField(new FormData()).get('hex')).toBeNull();
  });
});

describe('every call site that costs money actually attaches it', () => {
  /**
   * Read out of the source, because a helper nobody calls is not a fix. Three
   * tabs share these routes and a future edit that adds a fourth purchase call
   * with a plain `headers: { 'Content-Type': ... }` would silently go back to
   * sending no merchant identity at all.
   */
  const read = (rel: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');
  const TABS = ['components/tabs/CashTab.tsx', 'components/tabs/LanaTab.tsx', 'components/tabs/LanaOnlineTab.tsx'];

  const callsIn = (src: string, needle: string) => {
    const out: string[] = [];
    const lines = src.split('\n');
    lines.forEach((l, i) => {
      if (l.includes(needle)) out.push(lines.slice(i, i + 4).join('\n'));
    });
    return out;
  };

  for (const tab of TABS) {
    it(`${tab} sends x-lana-hex on every /api/brain/purchase* call`, () => {
      for (const call of callsIn(read(tab), "fetch('/api/brain/purchase")) {
        expect(call, `a purchase call in ${tab} carries no merchant identity`).toContain('withCallerHex(');
      }
    });

    it(`${tab} sends the hex field on every upload / analyse call`, () => {
      const src = read(tab);
      for (const needle of ["'/api/receipt/upload'", "'/api/receipt/analyze'", 'UPLOAD_URL']) {
        for (const call of callsIn(src, `fetch(${needle}`)) {
          expect(call, `an upload in ${tab} names nobody`).toContain('withCallerField(');
        }
      }
    });
  }

  it('the till refuses to sell to a blank name rather than sending customer_hex: \'\'', () => {
    const cash = read('components/tabs/CashTab.tsx');
    expect(cash, 'a blank identity is being sent again').not.toContain("customer_hex: resolvedHexId || ''");
    expect(cash).toContain("t('cash.customerNotIdentified')");
  });
});

describe('the till says WHY the money was refused', () => {
  /**
   * A clean merchant serving an excluded shopper used to get the raw English
   * refusal body printed at them — the money was correctly refused and the
   * person at the counter was told nothing they could act on. Both money tabs
   * must translate a 403 PERSON_EXCLUDED into the seller's own language and
   * carry the commission's own words with it.
   */
  const read = (rel: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');

  for (const tab of ['components/tabs/CashTab.tsx', 'components/tabs/LanaTab.tsx']) {
    it(`${tab} reads the refusal and shows the ground`, () => {
      const src = read(tab);
      expect(src, 'a PERSON_EXCLUDED refusal is printed raw again').toContain('exclusionFromRefusal(');
      expect(src).toContain("t('purchase.personExcluded')");
      expect(src, 'the commission\'s own words are dropped').toContain('refusal.ground');
    });
  }
});
