/**
 * Proving, per request, that this browser holds the key it claims.
 *
 * A Nostr public key is public, so a route that believes a hex the client
 * sends believes anybody. Routes that show a merchant money owed to them ask
 * for a NIP-98 token instead (see server/lib/nip98.ts): a kind-27235 event
 * signed with the session key, bound to this method and path, good for about a
 * minute, and spendable once.
 *
 * THE KEY IS PASSED IN, from useAuth().session.privateKeyHex. This app's session
 * calls the field `privateKeyHex`; the shop's copy of this file reads
 * `nostrPrivateKey` out of localStorage, and a verbatim port would find no key,
 * send no header, and get a 401 on every call.
 *
 * ⚠ THE NONCE IS NOT DECORATION. A NIP-98 event id is sha256 over
 * [0, pubkey, created_at, kind, tags, content] — the signature is not in it. Two
 * identical GETs in the same second would therefore be the SAME event, and the
 * server, which spends each id once, would refuse the second as a replay. A
 * double click or React StrictMode does exactly that. The random `nonce` tag
 * makes every token its own event.
 *
 * No hex header is sent: the signature is the only statement of who is asking.
 */

import { finalizeEvent } from 'nostr-tools/pure';

const HEX64 = /^[0-9a-f]{64}$/i;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The path the token is bound to — what the server sees, without the query. */
export function signedPath(url: string): string {
  const withoutOrigin = /^https?:\/\//i.test(url) ? new URL(url).pathname : url;
  return withoutOrigin.split('?')[0];
}

/**
 * Headers proving this key signed this method+path. Returns {} when there is no
 * usable key, so the caller degrades to an unsigned request the server refuses
 * (with a reason the page can explain), rather than throwing mid-render.
 */
export function signedAuthHeaders(privateKeyHex: string | null | undefined, method: string, url: string): Record<string, string> {
  if (!privateKeyHex || !HEX64.test(privateKeyHex)) return {};
  try {
    const ev = finalizeEvent(
      {
        kind: 27235, // NIP-98 HTTP Auth
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['u', signedPath(url)],
          ['method', method.toUpperCase()],
          ['nonce', randomNonce()],
        ],
        content: '',
      },
      hexToBytes(privateKeyHex),
    );
    // The event is ASCII only (hex, digits, a path), so btoa is safe here.
    return { Authorization: 'Nostr ' + btoa(JSON.stringify(ev)) };
  } catch {
    return {};
  }
}

/** fetch() with the signature attached. Same arguments, same return. */
export function signedFetch(privateKeyHex: string | null | undefined, url: string, init: RequestInit = {}): Promise<Response> {
  const method = String(init.method || 'GET');
  return fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...signedAuthHeaders(privateKeyHex, method, url) },
  });
}

/**
 * Which advice fits a 401 from the signature gate. A wrong clock is fixed on
 * the device; everything else means this session cannot sign and only a fresh
 * sign-in helps. Neither is fixed by refreshing, so neither says so.
 */
export function signatureAdvice(reason?: string): 'clock' | 'relogin' {
  return reason === 'STALE' || reason === 'BAD_TIME' ? 'clock' : 'relogin';
}
