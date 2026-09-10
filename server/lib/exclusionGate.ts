/**
 * This app's wiring for the shared gross-violation gate (./personExclusion.ts).
 *
 * personExclusion.ts is fleet-wide and identical in ten repositories; everything
 * that is specific to lana-pays.us-mobile lives here:
 *
 *  - where the relay list and the LanaSelfResponsibility signer come from
 *    (this app's own cached KIND 38888 row, never a second hardcoded pubkey),
 *  - which relay client does the asking (server/lib/nostr.ts),
 *  - and the ONE kill switch, EXCLUSION_GATE=off.
 *
 * NOBODY IS EXEMPT. There is deliberately no allow-list, no admin bypass and no
 * "root is always fine" branch anywhere in this file. The kill switch is all or
 * nothing, it is an operational lever, and it shouts in the log when it is used.
 */

import type Database from 'better-sqlite3';
import { verifyEvent } from 'nostr-tools/pure';
import { fetchEventsFromRelays, getLanaRelays, KIND_38888_PUBKEY } from './nostr.js';
import {
  ensureExclusionTables,
  refreshExclusions,
  findExclusion,
  findExclusionAmong,
  notExcluded,
  exclusionRefusal,
  asPersonHex,
  hexCandidates,
  MAX_CANDIDATES,
  type ActiveExclusion,
  type NostrLikeEvent,
} from './personExclusion.js';

/**
 * Make sure the standing-set tables exist on THIS database before anything asks
 * them a question.
 *
 * server/index.ts already does this at boot, but the route registrars are also
 * used against databases it never touched (the order-route tests build their
 * own). Without this, the very first gated request throws inside SQLite and
 * express answers its own HTML error page — a 500 that looks nothing like a
 * refusal and breaks every JSON client. Idempotent, and an empty table means
 * "nothing known yet", which is the same state a freshly-built container is in.
 */
const ensured = new WeakSet<object>();
function ensureOnce(db: Database.Database): void {
  if (ensured.has(db as unknown as object)) return;
  try {
    ensureExclusionTables(db);
    ensured.add(db as unknown as object);
  } catch (e: any) {
    console.warn('[exclusion] could not create the exclusion tables:', e?.message || e);
  }
}

/**
 * The only lever, read fresh on every call so a test can flip it and so the
 * value in the environment is always the value that decides.
 */
export function isGateOff(): boolean {
  return process.env.EXCLUSION_GATE === 'off';
}

/** Say plainly, at boot, which of the two states this container is in. */
export function logGateState(): void {
  if (isGateOff()) {
    console.warn('[exclusion] ⚠⚠ EXCLUSION_GATE=off — the KIND 87058 gate is DISABLED for EVERYONE on this instance');
  } else {
    console.log('[exclusion] KIND 87058 gate is ON (set EXCLUSION_GATE=off to disable, all or nothing)');
  }
}

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * How the cached KIND 38888 is checked before the gate believes a word of it.
 *
 * Both are injectable ONLY so a test can build a genuinely signed event of its
 * own — the production defaults are the pinned author and the real signature
 * check, and nothing in the running server passes either of these.
 */
export interface TrustRootCheck {
  /** The one key whose KIND 38888 is the system parameters. */
  expectedPubkey?: string;
  /** Signature check — nostr-tools verifyEvent. */
  verify?: (e: any) => boolean;
}

/**
 * The pubkeys KIND 38888 names under `trusted_signers.<role>`.
 *
 * Read out of the cached raw event rather than a column, so no schema migration
 * is needed and every row already in production carries it.
 *
 * THE TRUST ROOT IS CHECKED HERE. This whole gate hangs off one field of one
 * event: whoever KIND 38888 names as LanaSelfResponsibility is whoever can
 * exclude a person from this app. `pubkey` is just a string in a JSON blob a
 * relay handed us, so comparing it to the pinned key and stopping there proves
 * nothing — a hostile relay writes whatever pubkey it likes and names its own
 * signer. So the event must ALSO carry a signature that verifies, and be a
 * KIND 38888. An event that fails any of the three names NOBODY, which leaves
 * yesterday's standing set exactly as it was: it can neither release a person
 * nor invent a sanction, and it says so in the log.
 *
 * Note: the same cached row feeds /api/system-params and the heartbeat's own
 * KIND 38888 consumers, which still accept it on the bare author compare in
 * server/lib/nostr.ts. That is deliberately out of scope here — this verifies
 * the event where the GATE reads it.
 */
export function trustedSignersFrom(
  rawEvent: string | null | undefined,
  role = 'LanaSelfResponsibility',
  check: TrustRootCheck = {},
): string[] {
  if (!rawEvent) return [];
  const expected = String(check.expectedPubkey ?? KIND_38888_PUBKEY).toLowerCase();
  const verify = check.verify ?? ((e: any) => verifyEvent(e));
  try {
    const ev = JSON.parse(rawEvent);
    if (String(ev?.pubkey ?? '').toLowerCase() !== expected) {
      console.error('[exclusion] cached KIND 38888 is NOT from the pinned author — its trusted signers are ignored, the last known set still stands');
      return [];
    }
    if (Number(ev?.kind) !== 38888) {
      console.error('[exclusion] cached KIND 38888 row is not a 38888 event — its trusted signers are ignored');
      return [];
    }
    let signed = false;
    try { signed = verify(ev) === true; } catch { signed = false; }
    if (!signed) {
      console.error('[exclusion] cached KIND 38888 SIGNATURE does not verify — its trusted signers are ignored, the last known set still stands');
      return [];
    }
    const content = typeof ev?.content === 'string' ? JSON.parse(ev.content || '{}') : (ev?.content ?? {});
    const named = content?.trusted_signers?.[role];
    if (Array.isArray(named)) return named.filter((x: unknown) => typeof x === 'string' && HEX64.test(x));
    if (typeof named === 'string' && HEX64.test(named)) return [named];
  } catch { /* an unreadable 38888 names nobody */ }
  return [];
}

export interface ExclusionDeps {
  relays: string[];
  trustedSigners: string[];
  currentSplit: number | null;
}

/**
 * Everything the refresh needs, from the newest cached KIND 38888 row.
 *
 * A fresh container has no row at all, so the relay list falls back to this
 * app's own bootstrap relays — otherwise the very first refresh, before the
 * first heartbeat, could never run.
 */
export function readExclusionDeps(db: Database.Database, check: TrustRootCheck = {}): ExclusionDeps {
  let row: any;
  try {
    row = db.prepare('SELECT relays, split, raw_event FROM kind_38888 ORDER BY id DESC LIMIT 1').get();
  } catch { row = undefined; }

  let relays: string[] = [];
  try { relays = row?.relays ? JSON.parse(row.relays) : []; } catch { relays = []; }
  if (!Array.isArray(relays) || relays.length === 0) relays = getLanaRelays();

  const split = Number(row?.split);

  return {
    relays: relays.filter((r) => typeof r === 'string' && r.startsWith('ws')),
    trustedSigners: trustedSignersFrom(row?.raw_event, 'LanaSelfResponsibility', check),
    currentSplit: Number.isFinite(split) && split > 0 ? split : null,
  };
}

export interface RefreshOutcome { ok: boolean; count: number; reason?: string }

/**
 * Pull the standing set from the relays and MERGE what they served into it.
 *
 * Nothing here can empty the set. The shared logic writes the reports the relays
 * actually answered with and leaves everything they did not mention exactly as
 * it was, so a stale KIND 38888 signer pin, an unreachable relay, or a relay
 * serving one page of an old index all end with yesterday's decisions intact.
 * That is why there is no local "did anybody answer?" adapter here: a PARTIAL
 * answer is indistinguishable from a complete one, so guessing was never safe —
 * and with merge semantics it is no longer needed.
 *
 * Logged like the other heartbeat steps. A refusal is a WARNING that says out
 * loud that the last known set still stands, because "refresh failed" and
 * "nobody is excluded any more" must never look the same in a log. A DROP in the
 * count is a warning too: it can only come from a real withdrawal or a lapsed
 * round, and either is worth seeing in the log rather than inferring later.
 */
export async function refreshPersonExclusions(db: Database.Database, where = 'boot', check: TrustRootCheck = {}): Promise<RefreshOutcome> {
  if (isGateOff()) {
    console.warn(`[exclusion] (${where}) refresh SKIPPED — EXCLUSION_GATE=off`);
    return { ok: false, count: 0, reason: 'EXCLUSION_GATE=off' };
  }

  const deps = readExclusionDeps(db, check);
  const before = standingCount(db);
  const result = await refreshExclusions(db, {
    relays: deps.relays,
    trustedSigners: deps.trustedSigners,
    currentSplit: deps.currentSplit,
    verify: (e: NostrLikeEvent) => verifyEvent(e as any),
    fetchEvents: (filter, relays) => fetchEventsFromRelays(filter, relays) as Promise<NostrLikeEvent[]>,
  });

  if (result.ok) {
    console.log(`[exclusion] (${where}) ${result.count} standing exclusion(s), read from ${deps.relays.length} relay(s), split=${deps.currentSplit ?? '?'}`);
    if (result.count < before) {
      console.warn(`[exclusion] (${where}) ⚠ the standing set DROPPED ${before} → ${result.count} — a decision was withdrawn or reached its round; nothing else can lower it`);
    }
  } else {
    console.warn(`[exclusion] (${where}) refresh did NOT complete — ${result.reason}; the last known set (${before}) still stands`);
  }
  return result;
}

function standingCount(db: Database.Database): number {
  try {
    ensureOnce(db);
    return Number((db.prepare('SELECT COUNT(*) c FROM person_exclusions WHERE active = 1').get() as any)?.c) || 0;
  } catch {
    return 0;
  }
}

/** The decision standing against this person right now, or null. */
export function excludedNow(db: Database.Database, hex: unknown): ActiveExclusion | null {
  if (isGateOff()) return null;
  ensureOnce(db);
  return findExclusion(db, hex);
}

/**
 * notExcluded() with the kill switch folded in.
 *
 * Every route in this app must use THIS, never notExcluded() directly, so the
 * switch cannot be honoured in one place and forgotten in another.
 *
 * `getHex` may return a single value or an ARRAY of every field the handler
 * might act on — and it should return the array. A gate that reads `a || b`
 * stops at the first truthy field, so filling the OTHER one walks straight past
 * it while the handler acts on exactly that one.
 */
export function gate(db: Database.Database, getHex: (req: any) => unknown, onRefuse?: (req: any) => void) {
  ensureOnce(db);
  const mw = notExcluded(db, getHex);
  if (!onRefuse) {
    return (req: any, res: any, next: any) => (isGateOff() ? next() : mw(req, res, next));
  }
  // `onRefuse` runs when — and only when — this gate is the thing that refused.
  // It exists for the multipart routes: multer has ALREADY written the upload to
  // disk by the time req.body carries the hex the gate reads, so a refusal that
  // just answers 403 leaves the file behind and an excluded person still spends
  // this server's storage. Nothing in the chain cleans those up.
  return (req: any, res: any, next: any) => {
    if (isGateOff()) return next();
    // notExcluded() is synchronous: it either calls next() or answers, so
    // "was next() reached" is an exact signal, and it does not depend on what a
    // later middleware does with the same response.
    let passed = false;
    mw(req, res, () => { passed = true; next(); });
    if (!passed) { try { onRefuse(req); } catch { /* cleanup must not mask the refusal */ } }
  };
}

/* ───────────── identities this server can resolve on its own ───────────── */

/**
 * Every string a value could be, however the request wrapped it.
 *
 * The hex path already unwraps arrays (hexCandidates), because a handler that
 * does String(v) on ["<hex>"] acts on the hex either way. The wallet and unit
 * paths did NOT, and that was a way straight through: `unit_id: ["EXOWNERUNIT"]`
 * resolved to NOBODY for the gate while unitForMerchant() downstream read the
 * very same id back out of String(unit_id). Same unwrapping, same cap.
 */
function textCandidates(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const v of value) {
      for (const t of textCandidates(v, depth + 1)) {
        if (!out.includes(t)) out.push(t);
        if (out.length >= MAX_CANDIDATES) return out;
      }
    }
    return out;
  }
  if (typeof value !== 'string') return [];
  const t = value.trim();
  return t ? [t] : [];
}

/**
 * The person a LANA wallet address belongs to, as far as THIS server knows.
 *
 * A wallet is a second name for the same human being, and it was being used as
 * exactly that: a purchase carrying an empty `customer_hex` and the excluded
 * person's `customer_wallet` was served, because the gate asked only the field
 * that happened to be blank. The mapping is already in this app's own `users`
 * table — the server had the identity and never asked for it.
 *
 * EVERY row, not the first. `users.lana_address` has no unique constraint and
 * POST /api/users is deliberately ungated on it, so one wallet can carry two
 * registrations. Reading it with .get() returned whichever row had the lower
 * rowid, and a decision sitting on the OTHER one was invisible — proven live.
 */
export function personsForWallet(db: Database.Database, address: unknown): string[] {
  const out: string[] = [];
  const add = (v: unknown) => { const h = asPersonHex(v); if (h && !out.includes(h)) out.push(h); };
  for (const addr of textCandidates(address)) {
    if (addr.length > 64) continue;
    try {
      for (const r of db.prepare('SELECT hex_id FROM users WHERE lana_address = ?').all(addr) as any[]) {
        add(r?.hex_id);
      }
    } catch { /* the table may not exist on a database the gate was handed */ }
    try {
      // A till that has served this wallet before wrote the person down too. It is
      // the same mapping from a second place, and it covers a wallet whose
      // registrar record never carried a nostr_hex_id — the exact case where a
      // second wallet was presenting a pubkey that carried no decision.
      for (const r of db.prepare('SELECT DISTINCT customer_hex_id FROM regular_customers WHERE customer_wallet = ?').all(addr) as any[]) {
        add(r?.customer_hex_id);
      }
    } catch { /* same */ }
  }
  return out;
}

/**
 * The person a business unit's money reaches: its OWNER, and nobody else.
 *
 * The till carries no merchant identity of its own — the routes that take money
 * name only `unit_id` — so without this an EXCLUDED MERCHANT who knows their own
 * unit id keeps selling. KIND 30901 already says who they are.
 *
 * IT DOES NOT RETURN THE STAFF. It used to return the owner PLUS every hex in
 * `authorized_hex`, and gateNames() refused if ANY of them carried a decision —
 * so one excluded staff member closed a CLEAN owner's whole shop, on that
 * owner's own sales, with the only way out being to republish KIND 30901.
 * A commission decides about a person; it does not decide about everybody who
 * stands near them. The staff member operating the till is refused by their own
 * name (staff_hex / x-lana-hex / merchant_hex), which is the person acting —
 * see the person-side list in gateNames().
 */
export function ownerForUnit(db: Database.Database, unitId: unknown): string[] {
  const out: string[] = [];
  for (const id of textCandidates(unitId)) {
    if (id.length > 128) continue;
    let row: any;
    try {
      row = db.prepare('SELECT owner_hex FROM business_units WHERE unit_id = ?').get(id);
    } catch {
      continue;
    }
    const owner = asPersonHex(row?.owner_hex);
    if (owner && !out.includes(owner)) out.push(owner);
  }
  return out;
}

/** Where a route carries the people it acts for. Every list is optional. */
export interface RequestNames {
  /** Fields that carry the ACTING person's pubkey directly. */
  hex?: unknown[];
  /** LANA wallet addresses of the person paying, resolved through `users`. */
  wallet?: unknown[];
  /** Business unit ids, resolved to the unit's OWNER — who the money reaches. */
  unit?: unknown[];
}

/** The people a request names in its own right: the actor and the payer. */
export function personSideNames(db: Database.Database, parts: RequestNames): string[] {
  const out: string[] = [];
  const add = (h: string | null) => { if (h && !out.includes(h)) out.push(h); };
  for (const v of parts.hex ?? []) for (const h of hexCandidates(v)) add(h);
  for (const v of parts.wallet ?? []) for (const h of personsForWallet(db, v)) add(h);
  return out;
}

/** The owners of the units this request would move money to. */
export function merchantSideNames(db: Database.Database, parts: RequestNames): string[] {
  const out: string[] = [];
  for (const v of parts.unit ?? []) for (const h of ownerForUnit(db, v)) if (!out.includes(h)) out.push(h);
  return out;
}

/** Every person named by a request, direct names and resolved ones together. */
export function namesOn(db: Database.Database, parts: RequestNames): string[] {
  const out = personSideNames(db, parts);
  for (const h of merchantSideNames(db, parts)) if (!out.includes(h)) out.push(h);
  return out;
}

/**
 * The decision standing against ANYONE a request names, or null.
 *
 * For handlers that only learn who the merchant is after they have read a row —
 * the public /api/pay/:token pages carry a token, and the unit behind it is a
 * database lookup, not a field.
 */
export function excludedAmong(db: Database.Database, parts: RequestNames): ActiveExclusion | null {
  if (isGateOff()) return null;
  ensureOnce(db);
  return findExclusionAmong(db, namesOn(db, parts));
}

/**
 * The decision standing against the OWNER of these units, or null.
 *
 * Separate from excludedAmong() because the refusal it produces has to read
 * differently: the person holding the phone or the person paying is not the
 * subject of it, and telling them they are excluded is both false and cruel.
 */
export function excludedMerchant(db: Database.Database, unitIds: unknown[]): ActiveExclusion | null {
  if (isGateOff()) return null;
  ensureOnce(db);
  return findExclusionAmong(db, merchantSideNames(db, { unit: unitIds }));
}

/**
 * A sale refused because of the SELLER, said without naming anyone.
 *
 * A buyer standing on a public payment page is not the subject of any decision,
 * so the body they get carries no `ground`, no `eventId`, no `since` and — above
 * all — a different `code`, because every client in this fleet reads
 * PERSON_EXCLUDED as "you are the excluded one" and shows the closed-door
 * screen. It says the shop cannot take payments, which is all that is true and
 * all they need.
 */
export const MERCHANT_UNAVAILABLE_CODE = 'MERCHANT_UNAVAILABLE';

export function merchantRefusal() {
  return {
    success: false,
    error: 'This shop cannot take payments at the moment',
    code: MERCHANT_UNAVAILABLE_CODE,
  };
}

/**
 * gate() for a route that names people in more than one way.
 *
 * Two questions, asked in this order and answered differently:
 *
 *  1. Is the person ACTING excluded — their own key, in any field the handler
 *     might read, plus the wallet they are paying from? That is a refusal in
 *     their name, and it says so: PERSON_EXCLUDED, with the commission's ground.
 *  2. Otherwise, does this request move money to the OWNER of an excluded unit?
 *     Then the commerce stops, but the person in front of the screen is not the
 *     one the commission decided about: MERCHANT_UNAVAILABLE, neutral words, no
 *     detail of somebody else's sanction.
 *
 * A clean staff member of an excluded owner still works; a clean owner whose
 * staff member is excluded still trades; a clean buyer is never told they are
 * excluded.
 */
export function gateNames(db: Database.Database, read: (req: any) => RequestNames) {
  ensureOnce(db);
  return (req: any, res: any, next: any) => {
    if (isGateOff()) return next();
    let parts: RequestNames;
    try { parts = read(req) || {}; } catch { return next(); }

    const actor = findExclusionAmong(db, personSideNames(db, parts));
    if (actor) return res.status(403).json(exclusionRefusal(actor));

    const seller = findExclusionAmong(db, merchantSideNames(db, parts));
    if (seller) return res.status(403).json(merchantRefusal());

    return next();
  };
}
