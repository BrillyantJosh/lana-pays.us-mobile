/**
 * WHO IS ASKING — proved, not claimed.
 *
 * The older merchant routes in this app believe a bare hex sent by the client
 * (`?hex=`, `merchant_hex`). A Nostr public key IS public: it is in every event
 * on the relays and in the URL of half these screens, so naming yourself is not
 * authentication. A route that shows a merchant money it is owed must not work
 * that way, so the online-payments overview asks the caller to SIGN the request
 * instead (NIP-98, kind 27235): a short-lived event that binds the HTTP method
 * and path, signed by the key whose hex it claims.
 *
 * The signature establishes the hex; everything downstream — the KIND 87058
 * exclusion gate and the owner/staff rule on each unit — still decides what that
 * hex may see.
 *
 * Ported from lana-pays-shop/server/lib/nip98.ts, WITHOUT its admin fallback
 * lever (ADMIN_REQUIRE_SIG / x-admin-hex): that exists for browser tabs loaded
 * before signing shipped, and a new route has no such old client.
 *
 * Each token is SINGLE USE within its freshness window, so a header captured in
 * flight cannot be replayed even inside the 60 seconds.
 *
 * ⚠ Two identical requests in the same second produce the SAME event id — the
 * id is sha256 over [0, pubkey, created_at, kind, tags, content] and the
 * signature is not part of it — so single use would refuse the second one. That
 * is why the client puts a random `nonce` tag in every token (see
 * src/lib/signedRequest.ts). NIP-98 allows extra tags and they are inside the
 * signature, so nobody can strip one.
 */

import type { Request, Response, NextFunction } from 'express';
import { verifyEvent } from 'nostr-tools/pure';

export const AUTH_KIND = 27235;
/** How long a token is good for. A captured header dies with it. */
export const MAX_SKEW_SEC = 60;

export type Nip98Result = { ok: true; hex: string; id: string } | { ok: false; reason: string };

export interface Nip98Options {
  nowSec?: number;
  /** Returns false when this id was already spent. Defaults to the module store. */
  consume?: (id: string, expiresAt: number, nowSec: number) => boolean;
  verify?: (ev: any) => boolean;
}

/** Spent token ids → when they expire. In memory: a token only lives 60 s anyway. */
const spent = new Map<string, number>();

export function consumeOnce(id: string, expiresAt: number, nowSec: number): boolean {
  for (const [k, exp] of spent) if (exp <= nowSec) spent.delete(k);
  if (spent.has(id)) return false;
  spent.set(id, expiresAt);
  return true;
}

/** Test seam only. */
export function forgetSpentTokens(): void {
  spent.clear();
}

/**
 * Schnorr + id check on a FRESHLY BUILT object of exactly the seven NIP-01
 * fields. nostr-tools caches a "verified" flag on the object it is handed; an
 * object assembled by spreading a verified event would carry that flag along
 * and be believed without being checked. A new literal cannot carry it.
 */
export function verifySignature(ev: any): boolean {
  try {
    return verifyEvent({
      id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind,
      tags: ev.tags, content: ev.content, sig: ev.sig,
    } as any);
  } catch {
    return false;
  }
}

const isStringTag = (t: unknown): t is string[] =>
  Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === 'string');

/**
 * Does this Authorization header prove somebody signed THIS method and path
 * just now? Returns their hex (lower-case). Pure apart from the single-use store.
 */
export function verifyNip98(
  header: string | undefined,
  method: string,
  path: string,
  opts: Nip98Options = {},
): Nip98Result {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const verify = opts.verify ?? verifySignature;
  const consume = opts.consume ?? consumeOnce;

  if (!header) return { ok: false, reason: 'MISSING' };
  const m = /^Nostr\s+(.+)$/i.exec(String(header).trim());
  if (!m) return { ok: false, reason: 'MALFORMED' };

  let ev: any;
  try { ev = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); }
  catch { return { ok: false, reason: 'BAD_BASE64' }; }
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return { ok: false, reason: 'BAD_EVENT' };

  const { id, pubkey, created_at, kind, tags, sig } = ev;
  if (kind !== AUTH_KIND) return { ok: false, reason: 'BAD_KIND' };
  if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey)) return { ok: false, reason: 'BAD_PUBKEY' };
  if (typeof sig !== 'string' || !/^[0-9a-f]{128}$/i.test(sig)) return { ok: false, reason: 'BAD_SIG' };
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/i.test(id)) return { ok: false, reason: 'BAD_ID' };
  if (typeof created_at !== 'number' || !Number.isFinite(created_at)) return { ok: false, reason: 'BAD_TIME' };
  if (Math.abs(nowSec - created_at) > MAX_SKEW_SEC) return { ok: false, reason: 'STALE' };
  if (!Array.isArray(tags) || !tags.every(isStringTag)) return { ok: false, reason: 'BAD_TAGS' };

  // Bound to this verb and this path: a captured header for one route is not a
  // licence for another.
  const methodTag = String(tags.find((t: string[]) => t[0] === 'method')?.[1] || '');
  if (methodTag.toUpperCase() !== String(method).toUpperCase()) return { ok: false, reason: 'METHOD_MISMATCH' };
  const uTag = String(tags.find((t: string[]) => t[0] === 'u')?.[1] || '');
  if (!pathMatches(uTag, path)) return { ok: false, reason: 'PATH_MISMATCH' };

  // Recomputes the id from the seven fields and checks the schnorr signature,
  // so a token with someone else's pubkey or edited tags fails here.
  if (!verify(ev)) return { ok: false, reason: 'BAD_SIG' };

  if (!consume(String(id).toLowerCase(), created_at + MAX_SKEW_SEC, nowSec)) {
    return { ok: false, reason: 'REPLAYED' };
  }
  return { ok: true, hex: pubkey.toLowerCase(), id: String(id).toLowerCase() };
}

/** The `u` tag may be the bare path this server sees, or the absolute URL of it. */
function pathMatches(uTag: string, path: string): boolean {
  if (!uTag) return false;
  if (uTag === path) return true;
  if (uTag.split('?')[0] === path) return true;
  try {
    const url = new URL(uTag);
    return url.pathname === path;
  } catch {
    return false;
  }
}

/** The path a token must be signed for: what the client asked, without the query. */
export function requestPath(req: Request): string {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

export function verifyRequestSignature(req: Request, opts: Nip98Options = {}): Nip98Result {
  return verifyNip98(req.headers['authorization'] as string | undefined, req.method, requestPath(req), opts);
}

/** At most the first 12 hex characters of the key a token CLAIMS — for the log only. */
function claimedPrefix(header: string | undefined): string {
  try {
    const m = /^Nostr\s+(.+)$/i.exec(String(header || '').trim());
    if (!m) return '';
    const ev = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    const pk = typeof ev?.pubkey === 'string' ? ev.pubkey : '';
    return /^[0-9a-f]{12}/i.test(pk) ? pk.slice(0, 12).toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * Express middleware: the request must carry a valid NIP-98 token for this
 * method and path. On success `req.signedHex` is the proved hex (lower-case);
 * otherwise the caller gets 401 with the reason, so the page can tell a wrong
 * device clock apart from a session that has no key.
 */
export function requireSignedMerchant(req: Request, res: Response, next: NextFunction) {
  const header = req.headers['authorization'] as string | undefined;
  const result = verifyNip98(header, req.method, requestPath(req));
  if (!result.ok) {
    // (Explicit: this repo's server tsconfig has strictNullChecks off, which
    // disables narrowing on the `ok` discriminant.)
    const { reason } = result as { ok: false; reason: string };
    const who = claimedPrefix(header);
    console.warn(`[nip98] REJECT ${req.method} ${requestPath(req)} reason=${reason}${who ? ` claimed=${who}…` : ''}`);
    return res.status(401).json({ success: false, error: 'SIGNATURE_REQUIRED', reason });
  }
  (req as any).signedHex = result.hex;
  next();
}
