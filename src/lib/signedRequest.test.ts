/**
 * The browser half of the signed overview request, checked against the SERVER's
 * verifier — the two halves were written apart, and the shop's copy of this
 * file once read a session field this app does not have (every call 401).
 *
 * A session shaped the way AuthContext stores it (`privateKeyHex`) must produce
 * a header the server accepts and that names exactly the session's own hex.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { signedAuthHeaders, signedFetch, signedPath, signatureAdvice } from './signedRequest';
import { verifyNip98, forgetSpentTokens } from '../../server/lib/nip98';

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const PATH = '/api/payment-requests/overview';

/** What AuthContext writes to localStorage after a login (the fields that matter here). */
function sessionLikeAuthContext() {
  const sk = generateSecretKey();
  return { privateKeyHex: toHex(sk), nostrHexId: getPublicKey(sk), walletId: 'Lx', nostrNpubId: 'npub1x', currency: 'EUR', expiresAt: Date.now() + 3600_000 };
}

afterEach(() => { vi.unstubAllGlobals(); forgetSpentTokens(); });

describe('signedAuthHeaders', () => {
  it('produces a header the server accepts, naming the session\'s own hex', () => {
    const session = sessionLikeAuthContext();
    const headers = signedAuthHeaders(session.privateKeyHex, 'GET', `${PATH}?limit=20&offset=0`);
    const r = verifyNip98(headers.Authorization, 'GET', PATH);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hex).toBe(getPublicKey(Uint8Array.from(session.privateKeyHex.match(/../g)!.map((h) => parseInt(h, 16)))));
      expect(r.hex).toBe(session.nostrHexId);
    }
  });

  it('sends no hex header — the signature is the only statement of who asks', () => {
    const headers = signedAuthHeaders(sessionLikeAuthContext().privateKeyHex, 'GET', PATH);
    expect(Object.keys(headers)).toEqual(['Authorization']);
  });

  it('two calls in the same second are two different, both-valid tokens', () => {
    const { privateKeyHex } = sessionLikeAuthContext();
    const a = signedAuthHeaders(privateKeyHex, 'GET', PATH).Authorization;
    const b = signedAuthHeaders(privateKeyHex, 'GET', PATH).Authorization;
    expect(a).not.toBe(b);
    expect(verifyNip98(a, 'GET', PATH).ok).toBe(true);
    expect(verifyNip98(b, 'GET', PATH).ok).toBe(true);
  });

  it('with no key (or a malformed one) the result is {}', () => {
    expect(signedAuthHeaders(undefined, 'GET', PATH)).toEqual({});
    expect(signedAuthHeaders('', 'GET', PATH)).toEqual({});
    expect(signedAuthHeaders('zz'.repeat(32), 'GET', PATH)).toEqual({});
  });

  it('binds the path without origin or query', () => {
    expect(signedPath(`https://mobile.lanapays.us${PATH}?offset=20`)).toBe(PATH);
    expect(signedPath(`${PATH}?offset=20`)).toBe(PATH);
  });
});

describe('signedAuthHeaders with a body', () => {
  const POST_PATH = '/api/brain/purchase';
  const text = JSON.stringify({ unit_id: 'u', amount: 10, customer_name: 'Živa 日本 🌱' });
  const bytes = () => Buffer.from(text, 'utf8');

  it('binds the token to the exact bytes fetch will send', () => {
    const { privateKeyHex, nostrHexId } = sessionLikeAuthContext();
    const { Authorization } = signedAuthHeaders(privateKeyHex, 'POST', POST_PATH, { body: text });
    expect(verifyNip98(Authorization, 'POST', POST_PATH, { body: bytes() })).toMatchObject({ ok: true, hex: nostrHexId });
  });

  it('another body does not match the same token', () => {
    const { privateKeyHex } = sessionLikeAuthContext();
    const { Authorization } = signedAuthHeaders(privateKeyHex, 'POST', POST_PATH, { body: text });
    expect(verifyNip98(Authorization, 'POST', POST_PATH, { body: Buffer.from(text.replace('10', '11')) })).toEqual({ ok: false, reason: 'PAYLOAD_MISMATCH' });
  });

  it('with no body there is no payload tag, and the route that binds a body says so', () => {
    const { privateKeyHex } = sessionLikeAuthContext();
    const { Authorization } = signedAuthHeaders(privateKeyHex, 'POST', POST_PATH);
    expect(verifyNip98(Authorization, 'POST', POST_PATH, { body: bytes() })).toEqual({ ok: false, reason: 'PAYLOAD_MISSING' });
  });

  it('signs as of the second it is told to, not this device\'s clock', () => {
    const { privateKeyHex } = sessionLikeAuthContext();
    const told = Math.floor(Date.now() / 1000) + 86400;
    const { Authorization } = signedAuthHeaders(privateKeyHex, 'POST', POST_PATH, { body: text, nowSec: told });
    const ev = JSON.parse(atob(Authorization.replace('Nostr ', '')));
    expect(ev.created_at).toBe(told);
    expect(verifyNip98(Authorization, 'POST', POST_PATH, { body: bytes(), nowSec: told }).ok).toBe(true);
    expect(verifyNip98(Authorization, 'POST', POST_PATH, { body: bytes() })).toMatchObject({ ok: false, reason: 'STALE' });
  });

  it('the same body twice in a second is two tokens', () => {
    const { privateKeyHex } = sessionLikeAuthContext();
    const a = signedAuthHeaders(privateKeyHex, 'POST', POST_PATH, { body: text }).Authorization;
    const b = signedAuthHeaders(privateKeyHex, 'POST', POST_PATH, { body: text }).Authorization;
    expect(a).not.toBe(b);
    expect(verifyNip98(a, 'POST', POST_PATH, { body: bytes() }).ok).toBe(true);
    expect(verifyNip98(b, 'POST', POST_PATH, { body: bytes() }).ok).toBe(true);
  });
});

describe('signedFetch', () => {
  it('attaches the signature and keeps the caller\'s headers', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const { privateKeyHex } = sessionLikeAuthContext();
    await signedFetch(privateKeyHex, `${PATH}?limit=20`, { headers: { Accept: 'application/json' } });
    const init = fetchSpy.mock.calls[0][1];
    expect(init.headers.Accept).toBe('application/json');
    expect(verifyNip98(init.headers.Authorization, 'GET', PATH).ok).toBe(true);
  });
});

describe('signatureAdvice', () => {
  it('a clock problem is fixed on the device; everything else needs a fresh sign-in', () => {
    expect(signatureAdvice('STALE')).toBe('clock');
    expect(signatureAdvice('BAD_TIME')).toBe('clock');
    for (const r of ['MISSING', 'MALFORMED', 'BAD_SIG', 'BAD_BASE64', 'REPLAYED', undefined]) {
      expect(signatureAdvice(r)).toBe('relogin');
    }
  });
});
