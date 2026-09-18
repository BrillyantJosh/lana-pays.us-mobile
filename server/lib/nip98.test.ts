// @vitest-environment node
/**
 * The signature gate in front of the online-payments overview.
 *
 * What is pinned: a valid token passes and names its signer; the method, the
 * path and a 61-second skew in either direction each refuse; a token is spent
 * once, while two tokens that differ only by nonce in the same second both
 * pass; a victim's pubkey pasted over a real token, or edited tags, fail the
 * signature; a header that is not `Nostr …` is MALFORMED; and an object that
 * carries nostr-tools' "already verified" flag does not get past verification.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, verifiedSymbol } from 'nostr-tools/pure';
import { verifyNip98, verifySignature, forgetSpentTokens, requireSignedMerchant, MAX_SKEW_SEC } from './nip98.js';

const PATH = '/api/payment-requests/overview';
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const victim = getPublicKey(generateSecretKey());
const nowSec = () => Math.floor(Date.now() / 1000);

function token(opts: Partial<{ method: string; u: string; createdAt: number; nonce: string; kind: number; key: Uint8Array }> = {}) {
  return finalizeEvent({
    kind: opts.kind ?? 27235,
    created_at: opts.createdAt ?? nowSec(),
    tags: [['u', opts.u ?? PATH], ['method', opts.method ?? 'GET'], ['nonce', opts.nonce ?? crypto.randomBytes(16).toString('hex')]],
    content: '',
  }, opts.key ?? sk) as any;
}

const header = (ev: any) => 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');

beforeEach(() => forgetSpentTokens());

describe('verifyNip98', () => {
  it('a valid token passes and names its signer, lower-case', () => {
    const r = verifyNip98(header(token()), 'GET', PATH);
    expect(r).toMatchObject({ ok: true, hex: pk });
  });

  it('accepts the absolute URL form of the u tag, and ignores the query', () => {
    expect(verifyNip98(header(token({ u: `https://mobile.lanapays.us${PATH}?limit=20` })), 'GET', PATH).ok).toBe(true);
    expect(verifyNip98(header(token({ u: `${PATH}?offset=20` })), 'GET', PATH).ok).toBe(true);
  });

  it('a token for another method is refused', () => {
    expect(verifyNip98(header(token({ method: 'POST' })), 'GET', PATH)).toEqual({ ok: false, reason: 'METHOD_MISMATCH' });
  });

  it('a token for another path is refused', () => {
    expect(verifyNip98(header(token({ u: '/api/payment-requests' })), 'GET', PATH)).toEqual({ ok: false, reason: 'PATH_MISMATCH' });
  });

  it('61 s in the past or the future is STALE; 60 s is still good', () => {
    const now = nowSec();
    expect(verifyNip98(header(token({ createdAt: now - (MAX_SKEW_SEC + 1) })), 'GET', PATH, { nowSec: now })).toEqual({ ok: false, reason: 'STALE' });
    expect(verifyNip98(header(token({ createdAt: now + (MAX_SKEW_SEC + 1) })), 'GET', PATH, { nowSec: now })).toEqual({ ok: false, reason: 'STALE' });
    expect(verifyNip98(header(token({ createdAt: now - MAX_SKEW_SEC })), 'GET', PATH, { nowSec: now }).ok).toBe(true);
  });

  it('a replayed token is refused', () => {
    const h = header(token());
    expect(verifyNip98(h, 'GET', PATH).ok).toBe(true);
    expect(verifyNip98(h, 'GET', PATH)).toEqual({ ok: false, reason: 'REPLAYED' });
  });

  it('a spent token stays spent through the last second it is fresh (default store)', () => {
    // The freshness check accepts created_at + 60; the spent entry must still
    // be there in that second, or the same token is accepted a second time.
    const t0 = nowSec();
    const h = header(token({ createdAt: t0 }));
    expect(verifyNip98(h, 'GET', PATH, { nowSec: t0 + 1 }).ok).toBe(true);
    expect(verifyNip98(h, 'GET', PATH, { nowSec: t0 + 30 })).toEqual({ ok: false, reason: 'REPLAYED' });
    expect(verifyNip98(h, 'GET', PATH, { nowSec: t0 + MAX_SKEW_SEC })).toEqual({ ok: false, reason: 'REPLAYED' });
    expect(verifyNip98(h, 'GET', PATH, { nowSec: t0 + MAX_SKEW_SEC + 1 })).toEqual({ ok: false, reason: 'STALE' });
  });

  it('two tokens in the same second with different nonces both pass', () => {
    const at = nowSec();
    const a = token({ createdAt: at, nonce: 'aa' });
    const b = token({ createdAt: at, nonce: 'bb' });
    expect(a.id).not.toBe(b.id);
    expect(verifyNip98(header(a), 'GET', PATH).ok).toBe(true);
    expect(verifyNip98(header(b), 'GET', PATH).ok).toBe(true);
  });

  it('a victim\'s pubkey pasted over a real token fails the signature', () => {
    const ev = { ...token(), pubkey: victim };
    expect(verifyNip98(header(ev), 'GET', PATH)).toEqual({ ok: false, reason: 'BAD_SIG' });
  });

  it('edited tags fail the signature', () => {
    const ev = token({ u: '/api/payment-requests' });
    ev.tags = ev.tags.map((t: string[]) => (t[0] === 'u' ? ['u', PATH] : t));
    expect(verifyNip98(header(ev), 'GET', PATH)).toEqual({ ok: false, reason: 'BAD_SIG' });
  });

  it('a header that is not "Nostr …" is MALFORMED; none is MISSING', () => {
    expect(verifyNip98('Bearer abc', 'GET', PATH)).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verifyNip98(pk, 'GET', PATH)).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verifyNip98(undefined, 'GET', PATH)).toEqual({ ok: false, reason: 'MISSING' });
  });

  it('a different kind, garbage base64 and non-string tags are refused', () => {
    expect(verifyNip98(header(token({ kind: 1 })), 'GET', PATH)).toEqual({ ok: false, reason: 'BAD_KIND' });
    expect(verifyNip98('Nostr %%%not-base64%%%', 'GET', PATH).ok).toBe(false);
    const ev = token();
    ev.tags = [['u', PATH], ['method', 'GET'], [1, 2]];
    expect(verifyNip98(header(ev), 'GET', PATH)).toEqual({ ok: false, reason: 'BAD_TAGS' });
  });

  it('a failed token is not spent — the signer can still use a good one', () => {
    const good = token();
    const forged = { ...good, pubkey: victim };
    expect(verifyNip98(header(forged), 'GET', PATH).ok).toBe(false);
    expect(verifyNip98(header(good), 'GET', PATH).ok).toBe(true);
  });
});

describe('verifySignature', () => {
  it('a spread object carrying the verified flag does not pass on the flag alone', () => {
    const real = token();
    expect(verifyEvent(real)).toBe(true); // sets real[verifiedSymbol] = true
    const forged = { ...real, pubkey: victim } as any;
    expect(forged[verifiedSymbol]).toBe(true); // the flag rode along with the spread
    expect(verifyEvent(forged)).toBe(true);    // …and nostr-tools believes it
    expect(verifySignature(forged)).toBe(false); // this file does not
    expect(verifySignature(real)).toBe(true);
  });
});

describe('requireSignedMerchant', () => {
  const run = (authorization?: string, method = 'GET', originalUrl = `${PATH}?limit=20`) => new Promise<{ status: number; body: any; req: any }>((resolve) => {
    const req: any = { method, originalUrl, url: originalUrl, headers: authorization ? { authorization } : {} };
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json(b: any) { resolve({ status: this.statusCode, body: b, req }); return this; },
    };
    requireSignedMerchant(req, res, () => resolve({ status: 200, body: null, req }));
  });

  it('sets req.signedHex on success', async () => {
    const r = await run(header(token()));
    expect(r.status).toBe(200);
    expect(r.req.signedHex).toBe(pk);
  });

  it('answers 401 SIGNATURE_REQUIRED with the reason, and sets nothing', async () => {
    const r = await run(undefined);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ success: false, error: 'SIGNATURE_REQUIRED', reason: 'MISSING' });
    expect(r.req.signedHex).toBeUndefined();
  });
});
