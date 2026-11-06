/**
 * The till's half of a signed sale, checked against the SERVER's verifier.
 *
 * Pinned: every sale is signed by the key of whoever is signed in, over the exact
 * bytes that go out; a sale leaves whatever happens to the signing; a stale or spent
 * token is signed afresh once, and every other answer goes back to the till untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import { getPublicKey } from 'nostr-tools/pure';
import { sendPurchase, sellerRefusalKey } from './purchaseRequest';
import { SESSION_KEY } from './callerIdentity';
import { convertWifToIds, generateCompressedPublicKey } from './crypto';
import { verifyNip98, forgetSpentTokens } from '../../server/lib/nip98';

const breakSigning = vi.hoisted(() => ({ on: false }));
vi.mock('nostr-tools/pure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-tools/pure')>();
  return {
    ...actual,
    finalizeEvent: (...args: Parameters<typeof actual.finalizeEvent>) => {
      if (breakSigning.on) throw new Error('signing failed');
      return actual.finalizeEvent(...args);
    },
  };
});

const PATH = '/api/brain/purchase';
const KEY = '11'.repeat(32);
const SALE = { unit_id: 'u1', payment_type: 'cash', amount: 12.5, customer_name: 'Živa 日本 🌱', receipt_url: undefined };

const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map(x => parseInt(x, 16)));
const HEX = getPublicKey(fromHex(KEY));
const SESSION = { privateKeyHex: KEY, nostrHexId: HEX };

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** What the fake server was asked, in order. */
let calls: Array<{ url: string; init: any }>;
let answers: Array<Response | Error>;

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
  calls = [];
  answers = [];
  breakSigning.on = false;
  forgetSpentTokens();
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    new Headers(init.headers); // a value the browser would refuse fails here too, as it would there
    calls.push({ url, init });
    const next = answers.shift() ?? answer(200, { success: true });
    if (next instanceof Error) throw next;
    return next;
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const verified = (call: { init: any }, nowSec?: number) =>
  verifyNip98(call.init.headers.Authorization, 'POST', PATH, { body: Buffer.from(call.init.body, 'utf8'), nowSec });

describe('a sale leaves the till signed', () => {
  it('by the key it was given, over the exact bytes that go out', async () => {
    await sendPurchase(SESSION, SALE);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(PATH);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(calls[0].init.body).toBe(JSON.stringify(SALE));
    expect(verified(calls[0])).toMatchObject({ ok: true, hex: HEX });
  });

  it('still carries the name the exclusion gate reads', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ nostrHexId: HEX, expiresAt: Date.now() + 60_000 }));
    await sendPurchase(SESSION, SALE);
    expect(calls[0].init.headers['x-lana-hex']).toBe(HEX);
  });

  it('two sales of the same thing are two tokens', async () => {
    await sendPurchase(SESSION, SALE);
    await sendPurchase(SESSION, SALE);
    expect(calls[0].init.headers.Authorization).not.toBe(calls[1].init.headers.Authorization);
    expect(verified(calls[0]).ok).toBe(true);
    expect(verified(calls[1]).ok).toBe(true);
  });
});

describe('the key a real sign-in gives', () => {
  /** A WIF the way wallets write them, from a throwaway key. */
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const base58 = (bytes: Uint8Array) => {
    let n = BigInt('0x' + toHex(bytes));
    let out = '';
    while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
    return out;
  };
  const wif = (keyHex: string, compressed: boolean) => {
    const payload = Uint8Array.from([compressed ? 0x41 : 0xb0, ...fromHex(keyHex), ...(compressed ? [0x01] : [])]);
    const check = sha256(sha256(payload)).slice(0, 4);
    return base58(Uint8Array.from([...payload, ...check]));
  };

  // Keys whose public point has an even and an odd Y: the Nostr hex drops the parity,
  // and the signature has to verify under that hex either way.
  const keyWithParity = (prefix: '02' | '03') => {
    for (let i = 1; i < 200; i++) {
      const k = i.toString(16).padStart(64, '0');
      if (generateCompressedPublicKey(k).startsWith(prefix)) return k;
    }
    throw new Error('no key found');
  };

  it.each([
    ['uncompressed, even Y', keyWithParity('02'), false],
    ['uncompressed, odd Y', keyWithParity('03'), false],
    ['compressed, even Y', keyWithParity('02'), true],
    ['compressed, odd Y', keyWithParity('03'), true],
  ])('%s: the signer is the hex the units are listed under', async (_label, key, compressed) => {
    const ids = await convertWifToIds(wif(key, compressed));
    expect(ids.privateKeyHex).toBe(key);
    await sendPurchase(ids, SALE);
    expect(verified(calls[0])).toMatchObject({ ok: true, hex: ids.nostrHexId });
  });
});

describe('signing never stops a sale from leaving', () => {
  it.each([
    ['no session at all', undefined],
    ['a null session', null],
    ['a session with no key', { nostrHexId: HEX }],
    ['an empty key', { privateKeyHex: '', nostrHexId: HEX }],
    ['a key that is not a key', { privateKeyHex: 'zz'.repeat(32), nostrHexId: HEX }],
  ])('%s: it goes out unsigned', async (_label, session) => {
    const res = await sendPurchase(session as any, SALE);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(calls[0].init.body).toBe(JSON.stringify(SALE));
  });

  it('the signing code throwing: it goes out unsigned', async () => {
    breakSigning.on = true;
    const res = await sendPurchase(SESSION, SALE);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  it('a browser that refuses storage: it goes out signed all the same', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('access denied'); } } as any);
    await sendPurchase(SESSION, SALE);
    expect(verified(calls[0]).ok).toBe(true);
  });
});

describe('what the record needs to read a sale', () => {
  const signedIn = (expiresAt: number) =>
    localStorage.setItem(SESSION_KEY, JSON.stringify({ nostrHexId: HEX, expiresAt }));

  it('the marker goes out with every sale, signed', async () => {
    await sendPurchase(SESSION, SALE);
    expect(calls[0].init.headers['x-till-signs']).toBe('1');
    expect(verified(calls[0]).ok).toBe(true);
  });

  it.each([
    ['no session', undefined],
    ['no key', { nostrHexId: HEX }],
    ['a bad key', { privateKeyHex: 'zz'.repeat(32), nostrHexId: HEX }],
  ])('the marker goes out unsigned too: %s', async (_label, session) => {
    await sendPurchase(session as any, SALE);
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(calls[0].init.headers['x-till-signs']).toBe('1');
  });

  it('the marker goes out when the signing code throws', async () => {
    breakSigning.on = true;
    await sendPurchase(SESSION, SALE);
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(calls[0].init.headers['x-till-signs']).toBe('1');
  });

  it('past the session\'s 8 hours the seller is still named for the record, and not for the gate', async () => {
    signedIn(Date.now() - 1000);
    await sendPurchase(SESSION, SALE);
    expect(calls[0].init.headers['x-till-seller']).toBe(HEX);
    expect(calls[0].init.headers['x-lana-hex'], 'the gate reads this one: what it is asked must not change').toBeUndefined();
    expect(verified(calls[0])).toMatchObject({ ok: true, hex: HEX });
  });

  it('inside the 8 hours both names go out, and they are the same person', async () => {
    signedIn(Date.now() + 60_000);
    await sendPurchase(SESSION, SALE);
    expect(calls[0].init.headers['x-till-seller']).toBe(HEX);
    expect(calls[0].init.headers['x-lana-hex']).toBe(HEX);
  });

  it('a signing failure past the 8 hours still names the seller, so the row can be read', async () => {
    signedIn(Date.now() - 1000);
    breakSigning.on = true;
    await sendPurchase(SESSION, SALE);
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(calls[0].init.headers['x-lana-hex']).toBeUndefined();
    expect(calls[0].init.headers['x-till-seller']).toBe(HEX);
  });

  it.each([
    ['a line break', 'not\na\nheader'],
    ['too short', 'abc'],
    ['not hex', 'zz'.repeat(32)],
    ['not a string', 12345],
    ['nothing', undefined],
  ])('a stored id that is %s is left out, and the sale still goes', async (_label, nostrHexId) => {
    const res = await sendPurchase({ privateKeyHex: KEY, nostrHexId } as any, SALE);
    expect(res.status).toBe(200);
    expect(calls[0].init.headers['x-till-seller']).toBeUndefined();
    expect(verified(calls[0]).ok).toBe(true);
  });

  it('the private key goes nowhere but into the signature', async () => {
    await sendPurchase(SESSION, SALE);
    const { Authorization, ...named } = calls[0].init.headers;
    expect(JSON.stringify(named)).not.toContain(KEY);
    expect(calls[0].init.body).not.toContain(KEY);
    expect(atob(Authorization.replace('Nostr ', ''))).not.toContain(KEY);
  });
});

describe('what comes back', () => {
  it.each([200, 400, 403, 404, 409, 422, 429, 500, 502])('%i goes straight to the till, sent once', async (status) => {
    answers = [answer(status, { success: status === 200, error: 'whatever' })];
    const res = await sendPurchase(SESSION, SALE);
    expect(res.status).toBe(status);
    expect(calls).toHaveLength(1);
    expect((await res.json() as any).error).toBe('whatever');
  });

  // A body that reads like a refusal does not make one: only a 401 is ever sent again.
  it.each([200, 400, 403, 404, 409, 422, 429, 500, 502, 503].flatMap(status => [
    [status, 'STALE'] as const,
    [status, 'REPLAYED'] as const,
  ]))('%i with reason %s in the body is still sent once', async (status, reason) => {
    answers = [answer(status, { success: false, code: 'SIGNATURE_REQUIRED', reason, server_time: Math.floor(Date.now() / 1000) })];
    const res = await sendPurchase(SESSION, SALE);
    expect(res.status).toBe(status);
    expect(calls).toHaveLength(1);
  });

  it('no answer at all stays no answer: the till already says what that means', async () => {
    answers = [new TypeError('Failed to fetch')];
    await expect(sendPurchase(SESSION, SALE)).rejects.toThrow('Failed to fetch');
    expect(calls).toHaveLength(1);
  });

  it('a stale token: the same bytes are signed again as of the server\'s time, once', async () => {
    const serverNow = Math.floor(Date.now() / 1000) + 7200;
    answers = [
      answer(401, { success: false, code: 'SIGNATURE_REQUIRED', reason: 'STALE', server_time: serverNow }),
      answer(200, { success: true, data: { transaction_id: 't' } }),
    ];
    const res = await sendPurchase(SESSION, SALE);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].init.body).toBe(calls[0].init.body);
    expect(verified(calls[1], serverNow)).toMatchObject({ ok: true, hex: HEX });
  });

  it('a spent token: the same bytes are signed again, once', async () => {
    answers = [
      answer(401, { success: false, code: 'SIGNATURE_REQUIRED', reason: 'REPLAYED' }),
      answer(409, { success: false, error: 'DUPLICATE_INVOICE' }),
    ];
    const res = await sendPurchase(SESSION, SALE);
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(2);
    expect(calls[0].init.headers.Authorization).not.toBe(calls[1].init.headers.Authorization);
    expect(calls[1].init.body).toBe(calls[0].init.body);
  });

  it('refused again after that: it stops, and the till gets the refusal', async () => {
    const refusal = { success: false, code: 'SIGNATURE_REQUIRED', reason: 'STALE', server_time: Math.floor(Date.now() / 1000) };
    answers = [answer(401, refusal), answer(401, refusal), answer(200, { success: true })];
    const res = await sendPurchase(SESSION, SALE);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(2);
    expect((await res.json() as any).reason).toBe('STALE');
  });

  it.each(['MISSING', 'BAD_SIG', 'PAYLOAD_MISMATCH', 'MALFORMED', undefined])('refused for %s: nothing is sent again, and the till can read the answer', async (reason) => {
    answers = [answer(401, { success: false, code: 'SIGNATURE_REQUIRED', reason })];
    const res = await sendPurchase(SESSION, SALE);
    expect(calls).toHaveLength(1);
    expect((await res.json() as any).code).toBe('SIGNATURE_REQUIRED');
  });

  it('a stale refusal with no usable server time is not sent again', async () => {
    answers = [answer(401, { success: false, reason: 'STALE', server_time: 'soon' })];
    const res = await sendPurchase(SESSION, SALE);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it('a 401 that is not JSON goes straight back', async () => {
    answers = [new Response('nope', { status: 401 })];
    const res = await sendPurchase(SESSION, SALE);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(await res.text()).toBe('nope');
  });

  it('an answer without clone() is still an answer (a 401 that cannot be read goes back)', async () => {
    const bare = { ok: false, status: 401, json: async () => ({ reason: 'STALE', server_time: 1 }) } as unknown as Response;
    answers = [bare];
    const res = await sendPurchase(SESSION, SALE);
    expect(res).toBe(bare);
    expect(calls).toHaveLength(1);
  });
});

describe('the words for a seller refusal', () => {
  it('names the three, and nothing else', () => {
    expect(sellerRefusalKey(401, { code: 'SIGNATURE_REQUIRED' })).toBe('purchase.sellerNotConfirmed');
    expect(sellerRefusalKey(503, { code: 'SELLER_CHECK_FAILED' })).toBe('purchase.sellerNotConfirmed');
    expect(sellerRefusalKey(403, { code: 'NOT_ENTITLED' })).toBe('purchase.sellerNotEntitled');
    expect(sellerRefusalKey(403, { error: 'PERSON_EXCLUDED' })).toBeNull();
    expect(sellerRefusalKey(409, { error: 'DUPLICATE_INVOICE' })).toBeNull();
    expect(sellerRefusalKey(401, null)).toBeNull();
    expect(sellerRefusalKey(200, { success: true })).toBeNull();
  });
});

describe('every sale goes through it', () => {
  /**
   * Read out of the source, because a helper nobody calls signs nothing, and the next
   * purchase call written with a plain fetch would quietly send no signature at all.
   */
  const read = (rel: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');

  it('nothing but this helper calls the route', () => {
    for (const tab of ['components/tabs/CashTab.tsx', 'components/tabs/LanaTab.tsx', 'components/tabs/LanaOnlineTab.tsx', 'lib/receiptDedup.ts', 'pages/PublicPay.tsx']) {
      expect(read(tab), `${tab} calls the purchase route itself`).not.toMatch(/fetch\(\s*['"`]\/api\/brain\/purchase['"`]/);
    }
    expect(read('lib/purchaseRequest.ts')).toContain("const PURCHASE_URL = '/api/brain/purchase'");
  });

  it('the cash tab sends all three of its sales through it, the LANA tab its one', () => {
    expect(read('components/tabs/CashTab.tsx').match(/await sendPurchase\(session,/g)).toHaveLength(3);
    expect(read('components/tabs/LanaTab.tsx').match(/await sendPurchase\(session,/g)).toHaveLength(1);
  });
});
