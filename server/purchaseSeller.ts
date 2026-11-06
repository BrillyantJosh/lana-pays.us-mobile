/**
 * Who is recording this sale.
 *
 * The till signs each purchase request with the key of whoever is signed in
 * (src/lib/purchaseRequest.ts): a NIP-98 token bound to this method, this path and
 * the exact bytes of this body. This file reads that signature and asks whether
 * the signer may sell at the unit the body names.
 *
 * May sell = the same people the till offers the unit to (GET /api/business-units/
 * :hexId): its owner, or a staff hex from its KIND 30901. Nothing else is decided
 * here. Suspension, the limits and the split stay with the handler and the brain.
 *
 * WHAT HAPPENS WITH THE VERDICT DEPENDS ON ONE SETTING, PURCHASE_SIGNATURE_REQUIRED:
 *
 *  - not "on" (the default): it is written down and nothing else. A tab opened before
 *    signing shipped sends no signature, and a refusal at a live till costs a real
 *    sale, so no sale is stopped for any verdict.
 *  - "on": anything but ok is refused here and the brain is never asked, and the
 *    KIND 87058 check also asks about the person the signature proved. This is turned
 *    on only when the checks in README.md, "Signed purchase requests", say so.
 *
 * A till signs a sale afresh once when it is told its token was stale or already used
 * (src/lib/purchaseRequest.ts), so a phone with a wrong clock keeps selling either way.
 *
 * Each sale leaves one line in the container log and one row in `purchase_auth_log`:
 * the verdict, the HTTP status the till got (200 means the brain recorded the sale,
 * 0 means the till left before the answer), the rail, and short prefixes of the unit
 * and of the seller's key. The table is there because a deploy replaces the container
 * and its log with it. Nothing about the customer, the amount or the invoice goes in
 * either place. Writing it down must never get in the way of the sale.
 *
 * Two headers exist only for reading that record. `x-till-signs` says the request
 * came from code that knows how to sign, which tells a tab still on older code from
 * this code whose signing failed. `x-till-seller` names the person signed in on that
 * tab, also after the session's 8 hours, when `x-lana-hex` is no longer sent. Anybody
 * could send either one, so neither decides anything: no verdict and no gate reads them.
 */
import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { verifyRequestSignature, claimedPrefix } from './lib/nip98.js';
import { isOwnerOrStaff } from './lib/merchantAuth.js';
import { excludedNow } from './lib/exclusionGate.js';
import { exclusionRefusal, type ActiveExclusion } from './lib/personExclusion.js';

export type SellerVerdict = 'ok' | 'unsigned' | 'bad_signature' | 'not_entitled' | 'check_failed';

export interface SellerJudgement {
  verdict: SellerVerdict;
  /** '' when ok. A NIP-98 reason for bad_signature. NO_UNIT, UNKNOWN_UNIT, NOT_OWNER_OR_STAFF or PERSON_EXCLUDED for not_entitled. */
  reason: string;
  /** The hex the signature PROVED, lower-case. null when nothing was proved. */
  signer: string | null;
  /** For a stale token: how far the device's clock is from this server's, in seconds. */
  skewSec: number | null;
}

const judged = (verdict: SellerVerdict, reason: string, signer: string | null = null, skewSec: number | null = null): SellerJudgement =>
  ({ verdict, reason, signer, skewSec });

/** Pure apart from the token's single use and one read of the unit. */
export function judgeSeller(db: Database.Database, req: Request): SellerJudgement {
  if (!req.headers['authorization']) return judged('unsigned', 'MISSING');

  const signed = verifyRequestSignature(req, { body: (req as any).rawBody ?? null });
  if (!signed.ok) {
    // (Explicit: this repo's server tsconfig has strictNullChecks off, which
    // disables narrowing on the `ok` discriminant.)
    const { reason, skewSec } = signed as { ok: false; reason: string; skewSec?: number };
    return judged('bad_signature', reason, null, skewSec ?? null);
  }

  const unitId = req.body?.unit_id;
  if (typeof unitId !== 'string' || !unitId) return judged('not_entitled', 'NO_UNIT', signed.hex);
  const unit = db.prepare('SELECT owner_hex, authorized_hex FROM business_units WHERE unit_id = ?').get(unitId) as any;
  if (!unit) return judged('not_entitled', 'UNKNOWN_UNIT', signed.hex);
  return isOwnerOrStaff(unit, signed.hex) ? judged('ok', '', signed.hex) : judged('not_entitled', 'NOT_OWNER_OR_STAFF', signed.hex);
}

/** A row stays this long, and the table stays this short, whatever reaches the route. */
const KEEP_DAYS = 60;
const KEEP_ROWS = 100_000;
const PURGE_EVERY_ROWS = 500;

function ensureLogTable(db: Database.Database): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS purchase_auth_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        verdict TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        status INTEGER NOT NULL,
        payment_type TEXT NOT NULL DEFAULT '',
        till_marker INTEGER NOT NULL DEFAULT 0,
        unit_prefix TEXT NOT NULL DEFAULT '',
        signer_prefix TEXT NOT NULL DEFAULT '',
        claimed_prefix TEXT NOT NULL DEFAULT '',
        skew_sec INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_purchase_auth_log_ts ON purchase_auth_log(ts);
    `);
  } catch (e: any) {
    console.warn('[purchase-auth] could not create purchase_auth_log, verdicts go to the log only:', e?.message || e);
  }
}

const hexPrefix = (v: unknown): string =>
  typeof v === 'string' && /^[0-9a-f]{12}/i.test(v) ? v.slice(0, 12).toLowerCase() : '';

/** A client-supplied string on its way into a log line: only what a unit id can hold. */
const unitPrefix = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 12) : '';

const railOf = (v: unknown): string => (v === 'cash' || v === 'lana' ? v : 'other');

/** Everything written down about one request. Read before the handler runs; it changes the body. */
function summarise(req: Request, j: SellerJudgement) {
  return {
    verdict: j.verdict,
    reason: j.reason,
    type: railOf(req.body?.payment_type),
    marker: req.headers['x-till-signs'] === '1' ? 1 : 0,
    unit: unitPrefix(req.body?.unit_id),
    signer: hexPrefix(j.signer),
    // What the request SAYS about who it is. Proves nothing; it helps read the row.
    claimed: hexPrefix(req.headers['x-lana-hex'])
      || claimedPrefix(req.headers['authorization'] as string | undefined)
      || hexPrefix(req.headers['x-till-seller']),
    skew: j.skewSec,
  };
}

function writeDown(db: Database.Database, d: ReturnType<typeof summarise>, status: number): void {
  console.log(`[purchase-auth] verdict=${d.verdict} reason=${d.reason || '-'} status=${status} type=${d.type} marker=${d.marker} unit=${d.unit || '-'} signer=${d.signer || '-'} claimed=${d.claimed || '-'}${d.skew === null ? '' : ` skew=${d.skew}`}`);
  try {
    const row = db.prepare(`
      INSERT INTO purchase_auth_log (verdict, reason, status, payment_type, till_marker, unit_prefix, signer_prefix, claimed_prefix, skew_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(d.verdict, d.reason, status, d.type, d.marker, d.unit, d.signer, d.claimed, d.skew);
    if (Number(row.lastInsertRowid) % PURGE_EVERY_ROWS === 0) {
      db.prepare(`
        DELETE FROM purchase_auth_log
        WHERE ts < datetime('now', ?) OR id <= (SELECT MAX(id) FROM purchase_auth_log) - ?
      `).run(`-${KEEP_DAYS} days`, KEEP_ROWS);
    }
  } catch (e: any) {
    console.warn('[purchase-auth] could not store the verdict:', e?.message || e);
  }
}

/**
 * Refuse instead of only writing it down? Read on every call, so the value in the
 * environment is always the value that decides. Only the exact word "on" turns it on:
 * a mistyped value leaves the till selling.
 */
export function purchaseSignatureRequired(): boolean {
  return process.env.PURCHASE_SIGNATURE_REQUIRED === 'on';
}

/** Say at boot what this route does with a verdict. */
export function logPurchaseCheckState(): void {
  const setting = `PURCHASE_SIGNATURE_REQUIRED=${process.env.PURCHASE_SIGNATURE_REQUIRED ?? 'unset'}`;
  if (purchaseSignatureRequired()) {
    console.log(`[purchase-auth] mode=refusing: a purchase not signed by the unit's owner or staff is refused (${setting})`);
  } else {
    console.log(`[purchase-auth] mode=logging: purchase signatures are checked and logged; no sale is refused for them (${setting})`);
  }
}

const SELLER_NOT_CONFIRMED = 'This till could not confirm who is selling. Reload the page and try again. If that does not help, sign in again.';
const SELLER_NOT_ENTITLED = 'This sign-in is not listed as the owner or staff of this shop.';

/**
 * The answer to a request that is not ok. `code` is what a till reads; `error` is
 * words, because a tab with older code prints that field as it is, and "reload the
 * page" is exactly what that tab needs to hear. `server_time` lets a till sign again
 * as of this server's clock.
 */
function refuse(res: Response, j: SellerJudgement): void {
  if (j.verdict === 'not_entitled') {
    res.status(403).json({ success: false, code: 'NOT_ENTITLED', error: SELLER_NOT_ENTITLED, message: SELLER_NOT_ENTITLED });
    return;
  }
  if (j.verdict === 'check_failed') {
    res.status(503).json({ success: false, code: 'SELLER_CHECK_FAILED', error: SELLER_NOT_CONFIRMED, message: SELLER_NOT_CONFIRMED });
    return;
  }
  res.status(401).json({
    success: false,
    code: 'SIGNATURE_REQUIRED',
    error: SELLER_NOT_CONFIRMED,
    message: SELLER_NOT_CONFIRMED,
    reason: j.reason,
    server_time: Math.floor(Date.now() / 1000),
  });
}

/**
 * The decision standing against the person the signature proved, or null.
 *
 * The gate in front of this route reads the names a request gives (purchaseNames in
 * index.ts). Once a signature can be required, the person it proved is asked about
 * too. This is the same question the gate asks, by way of the same excludedNow(): the
 * one kill switch applies, and when the standing set cannot be read the answer is
 * "no decision known here", as on every gated route (see findExclusion). With the
 * setting off this is never called, so the gate works exactly as it did.
 */
function decisionAgainstSigner(db: Database.Database, signer: string | null): ActiveExclusion | null {
  try {
    return excludedNow(db, signer);
  } catch (e: any) {
    console.warn('[purchase-auth] could not ask about the signer:', e?.message || e);
    return null;
  }
}

/**
 * Route middleware for POST /api/brain/purchase. Runs after the rate limit and the
 * exclusion gate, right before the handler. The body must have been parsed with
 * express.json({ verify: keepRawBody }), or no token can match it.
 */
export function purchaseSellerCheck(db: Database.Database) {
  ensureLogTable(db);
  return (req: Request, res: Response, next: NextFunction) => {
    const refusing = purchaseSignatureRequired();
    let judgement: SellerJudgement;
    try {
      judgement = judgeSeller(db, req);
    } catch (e: any) {
      console.warn('[purchase-auth] the check itself failed:', e?.message || e);
      judgement = judged('check_failed', 'ERROR');
    }
    const decision = refusing && judgement.verdict === 'ok' ? decisionAgainstSigner(db, judgement.signer) : null;
    if (decision) judgement = judged('not_entitled', 'PERSON_EXCLUDED', judgement.signer);
    try {
      const summary = summarise(req, judgement);
      // On close, so the status the till got is known. A connection dropped before
      // the answer closes too, without having finished: that is the 0.
      res.once('close', () => writeDown(db, summary, res.writableFinished ? res.statusCode : 0));
    } catch (e: any) {
      console.warn('[purchase-auth] could not note the verdict:', e?.message || e);
    }
    if (judgement.verdict === 'ok' || !refusing) {
      next();
      return;
    }
    if (decision) {
      res.status(403).json(exclusionRefusal(decision));
      return;
    }
    refuse(res, judgement);
  };
}
