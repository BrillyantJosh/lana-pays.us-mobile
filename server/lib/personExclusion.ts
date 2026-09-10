/**
 * Who is shut out of this application by a commission decision (KIND 87058).
 *
 * A gross violation is not a wallet matter and not a freeze. KIND 87057 is one
 * facilitator pausing one person inside one process; KIND 87058 is a commission
 * of three deciding that someone is outside the community. Only the second one
 * closes this door, and it closes it for every LanaPays.us application except
 * lana.discount — a person must always keep the way to sell what they hold.
 *
 * WHAT DECIDES. The report itself, read from the relays, signature verified,
 * author pinned to the LanaSelfResponsibility signer named in KIND 38888. The
 * registrar's `frozen_own_person` is deliberately NOT used here: both 87057 and
 * 87058 write that same reason, so a wallet carrying it cannot tell a facilitator's
 * pause apart from a commission's exclusion.
 *
 * HOW IT FAILS. A decision is only ever lifted by a LATER EVENT that says so —
 * never by an absence. This matters more than it looks: every relay helper in
 * this fleet RESOLVES with an empty array when the network is unreachable, so a
 * reader that treats "nothing came back" as "nothing stands" opens every door on
 * the first outage. So the set is MERGED, never replaced: reports the relays
 * actually served are written, and anything they did not mention is left exactly
 * as it was. A quiet relay changes nothing.
 *
 * The one thing it cannot do is catch someone on a machine that has never once
 * read the relays. That is the deliberate trade, because the alternative locks
 * out an entire community every time a relay wobbles.
 */

export const VIOLATION_KIND = 87058;

export interface NostrLikeEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface ActiveExclusion {
  /** The violation record this decision belongs to — one person may have several. */
  dTag: string;
  /** The excluded person, lowercase hex. */
  personHex: string;
  /** The commission's own words. Empty when the report could not be read. */
  ground: string;
  /** Unix seconds the decision took effect. */
  since: number;
  /** The SPLIT round it runs to, or null when it has no end. */
  untilSplit: number | null;
  eventId: string;
}

const lower = (s: unknown): string => String(s ?? '').toLowerCase();

/**
 * A Nostr hex, or nothing.
 *
 * Whitespace and case are normalised before the shape is judged. Both have been
 * used to walk straight past a gate: ` <hex>` fails a bare /^[0-9a-f]{64}$/ test,
 * the gate reads "not a person", and the handler that trims it acts anyway.
 */
export function asPersonHex(value: unknown): string | null {
  if (typeof value === 'number') return null;
  const raw = typeof value === 'string' ? value : null;
  if (raw == null) return null;
  const t = raw.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(t) ? t : null;
}

/**
 * Every person named by a value, however it was wrapped.
 *
 * A gate that reads only `typeof v === 'string'` is defeated by `["<hex>"]`,
 * because the handler downstream does its own coercion and acts on the same hex.
 * Anything a handler might unwrap, this unwraps too.
 */
export const MAX_CANDIDATES = 16;

export function hexCandidates(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const v of value) {
      for (const hex of hexCandidates(v, depth + 1)) {
        if (!out.includes(hex)) out.push(hex);
        // A request naming more people than any handler could act on is not a
        // request, it is a way to make the gate expensive. One body carrying
        // 30,000 valid hexes froze a server for 400 ms before this cap.
        if (out.length >= MAX_CANDIDATES) return out;
      }
    }
    return out;
  }
  const one = asPersonHex(value);
  return one ? [one] : [];
}

const tagValue = (e: NostrLikeEvent, name: string): string | undefined =>
  e.tags.find((t) => t[0] === name)?.[1];

/**
 * Absent, empty or non-positive means the decision has no end.
 *
 * Never an expiry already in the past: `until_split=0` would publish a sanction
 * that is dead the moment it is signed, so the publisher omits the tag instead.
 */
export function parseUntilSplit(raw?: string): number | null {
  const t = String(raw ?? '').trim();
  return /^\d+$/.test(t) && Number(t) > 0 ? Number(t) : null;
}

/** Reached its round, so it no longer stands. An open decision never lapses. */
export function hasLapsed(untilSplit: number | null, currentSplit: number | null): boolean {
  if (untilSplit == null) return false;
  if (currentSplit == null || !Number.isFinite(currentSplit) || currentSplit <= 0) return false;
  return currentSplit >= untilSplit;
}

/**
 * The subject of the report.
 *
 * The published shape marks them `["p", <hex>, "subject"]`. A report carrying a
 * single unmarked `p` tag is still read, because the one thing a report cannot
 * be ambiguous about is who it names; anything with several unmarked names is
 * dropped rather than guessed at.
 */
function subjectOf(e: NostrLikeEvent): string | null {
  const marked = e.tags.find((t) => t[0] === 'p' && t[2] === 'subject')?.[1];
  if (marked) return lower(marked);
  const ps = e.tags.filter((t) => t[0] === 'p');
  return ps.length === 1 && ps[0][1] ? lower(ps[0][1]) : null;
}

export interface SelectOptions {
  /** Pubkeys KIND 38888 names as LanaSelfResponsibility. Empty means nothing is honoured. */
  trustedSigners: string[];
  /** The running SPLIT, for lapsing bounded decisions. Unknown never releases anyone. */
  currentSplit: number | null;
  /** Signature check. A pinned author on an unverified event is not a check. */
  verify: (e: NostrLikeEvent) => boolean;
}

/**
 * Every exclusion that still stands, newest decision per violation.
 *
 * A withdrawal is a later event on the same `d`, so it lifts the report it names
 * and nothing else. With no trusted signer there is nothing to honour, and the
 * answer is an empty list — never "everyone".
 */
export interface Report extends ActiveExclusion {
  /** False when the newest event on this violation withdraws it, or it has lapsed. */
  active: boolean;
  /** created_at of the event this reading came from, so an older one cannot resurrect it. */
  eventCreatedAt: number;
}

/**
 * The newest honoured event per violation, whether it excludes or lifts.
 *
 * Withdrawals matter as much as decisions here: an absence must never lift a
 * sanction, so the only thing that can is a report the relays actually served.
 */
export function readReports(
  events: NostrLikeEvent[],
  { trustedSigners, currentSplit, verify }: SelectOptions,
): Report[] {
  const trusted = new Set(trustedSigners.map(lower).filter(Boolean));
  if (trusted.size === 0) return [];

  const newestPerViolation = new Map<string, NostrLikeEvent>();
  for (const e of events) {
    if (!e || e.kind !== VIOLATION_KIND) continue;
    if (!trusted.has(lower(e.pubkey))) continue;
    const d = tagValue(e, 'd');
    if (!d) continue;
    let ok = false;
    try { ok = verify(e); } catch { ok = false; }
    if (!ok) continue;
    const prev = newestPerViolation.get(d);
    if (!prev || e.created_at > prev.created_at) newestPerViolation.set(d, e);
  }

  const out: Report[] = [];
  for (const [dTag, e] of newestPerViolation) {
    const personHex = subjectOf(e);
    if (!personHex) continue;

    const untilSplit = parseUntilSplit(tagValue(e, 'until_split'));
    const active = tagValue(e, 'status') === 'active' && !hasLapsed(untilSplit, currentSplit);

    let ground = '';
    try {
      const c = JSON.parse(e.content || '{}');
      if (typeof c.subject === 'string') ground = c.subject.trim();
    } catch { /* an unreadable report still excludes */ }

    out.push({
      dTag,
      personHex,
      ground,
      since: Number(tagValue(e, 'effective_at')) || e.created_at,
      untilSplit,
      eventId: e.id,
      active,
      eventCreatedAt: e.created_at,
    });
  }
  return out.sort((a, b) => b.since - a.since);
}

export function selectActiveExclusions(
  events: NostrLikeEvent[],
  opts: SelectOptions,
): ActiveExclusion[] {
  return readReports(events, opts).filter((r) => r.active).map(({ active, eventCreatedAt, ...rest }) => rest);
}


/**
 * The decision that answers for a person, when several name them.
 *
 * One without an end outranks every bounded one: a person must not have the
 * heavier sanction quietly softened by a lighter report standing beside it.
 */
export function strongestFor(list: ActiveExclusion[], hex: string): ActiveExclusion | null {
  const mine = list.filter((x) => x.personHex === lower(hex));
  if (mine.length === 0) return null;
  const open = mine.find((x) => x.untilSplit == null);
  if (open) return open;
  return mine.reduce((a, b) => ((b.untilSplit ?? 0) > (a.untilSplit ?? 0) ? b : a));
}

/* ───────────────────────── storage ───────────────────────── */

/**
 * The set survives a restart on purpose.
 *
 * A container that comes up with no relay answer would otherwise start empty and
 * let everyone in until the first successful read. Rows are kept for withdrawn
 * violations too, carrying the `created_at` that withdrew them, so an old copy
 * of the original decision still floating on some relay cannot resurrect it.
 */
export function ensureExclusionTables(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_exclusions (
      d_tag            TEXT PRIMARY KEY,
      person_hex       TEXT NOT NULL,
      active           INTEGER NOT NULL DEFAULT 1,
      ground           TEXT NOT NULL DEFAULT '',
      since            INTEGER NOT NULL DEFAULT 0,
      until_split      INTEGER,
      event_id         TEXT NOT NULL DEFAULT '',
      event_created_at INTEGER NOT NULL DEFAULT 0,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_person_exclusions_hex ON person_exclusions(person_hex);
    CREATE TABLE IF NOT EXISTS exclusion_sync (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      last_ok_at    TEXT,
      last_try_at   TEXT,
      last_error    TEXT,
      count         INTEGER NOT NULL DEFAULT 0,
      current_split INTEGER
    );
    INSERT OR IGNORE INTO exclusion_sync (id) VALUES (1);
  `);
}

/**
 * Write what the relays served, and touch nothing else.
 *
 * An older event never overwrites a newer one, so a stale copy served by one
 * relay cannot undo a withdrawal that another relay already told us about.
 */
export function mergeReports(db: any, reports: Report[]): { written: number; lifted: number } {
  const existing = db.prepare('SELECT event_created_at FROM person_exclusions WHERE d_tag = ?');
  const put = db.prepare(`
    INSERT INTO person_exclusions (d_tag, person_hex, active, ground, since, until_split, event_id, event_created_at, updated_at)
    VALUES (@dTag, @personHex, @active, @ground, @since, @untilSplit, @eventId, @eventCreatedAt, datetime('now'))
    ON CONFLICT(d_tag) DO UPDATE SET
      person_hex = excluded.person_hex,
      active = excluded.active,
      ground = excluded.ground,
      since = excluded.since,
      until_split = excluded.until_split,
      event_id = excluded.event_id,
      event_created_at = excluded.event_created_at,
      updated_at = datetime('now')
  `);
  let written = 0;
  let lifted = 0;
  db.transaction((rows: Report[]) => {
    for (const r of rows) {
      const prev = existing.get(r.dTag) as { event_created_at: number } | undefined;
      if (prev && Number(prev.event_created_at) > r.eventCreatedAt) continue;
      put.run({
        dTag: r.dTag,
        personHex: r.personHex.toLowerCase(),
        active: r.active ? 1 : 0,
        ground: r.ground,
        since: r.since,
        untilSplit: r.untilSplit,
        eventId: r.eventId,
        eventCreatedAt: r.eventCreatedAt,
      });
      written += 1;
      if (!r.active) lifted += 1;
    }
  })(reports);
  return { written, lifted };
}

export function listExclusions(db: any): ActiveExclusion[] {
  const split = currentSplitOf(db);
  const rows = db.prepare(
    'SELECT d_tag, person_hex, ground, since, until_split, event_id FROM person_exclusions WHERE active = 1'
  ).all() as any[];
  return rows.map(rowToExclusion).filter((x) => !hasLapsed(x.untilSplit, split));
}

function rowToExclusion(r: any): ActiveExclusion {
  return {
    dTag: r.d_tag,
    personHex: r.person_hex,
    ground: r.ground || '',
    since: Number(r.since) || 0,
    untilSplit: r.until_split == null ? null : Number(r.until_split),
    eventId: r.event_id || '',
  };
}

function currentSplitOf(db: any): number | null {
  try {
    const r = db.prepare('SELECT current_split FROM exclusion_sync WHERE id = 1').get() as any;
    const n = Number(r?.current_split);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * The decision standing against this person right now, or null.
 *
 * The SPLIT is applied here rather than at write time, so a bounded decision
 * runs out on the round it names even if no relay has been read since.
 */
export function findExclusion(db: any, hex: unknown): ActiveExclusion | null {
  const person = asPersonHex(hex);
  if (!person) return null;
  // A missing or unreadable table must not turn every gated route into a 500 for
  // everybody. It fails to "no decision known here", which is the same answer a
  // machine that has never read the relays gives — and callers that care can ask
  // `exclusionKnown` whether this box knows anything at all.
  try {
    const split = currentSplitOf(db);
    const rows = db.prepare(
      'SELECT d_tag, person_hex, ground, since, until_split, event_id FROM person_exclusions WHERE person_hex = ? AND active = 1'
    ).all(person) as any[];
    const standing = rows.map(rowToExclusion).filter((x) => !hasLapsed(x.untilSplit, split));
    return strongestFor(standing, person);
  } catch {
    return null;
  }
}

/**
 * Has this machine ever actually read a report?
 *
 * The difference between "nobody is excluded" and "I have never heard" matters
 * to everything downstream: a browser must not forget a decision it is showing
 * because a freshly deployed container answered from an empty table.
 */
export function exclusionKnown(db: any): boolean {
  try {
    return !!exclusionSyncState(db).lastOkAt;
  } catch {
    return false;
  }
}

/**
 * The decision standing against ANY of these names.
 *
 * Routes carry an identity in more than one field, and a gate that stops at the
 * first truthy one is defeated by filling a field the handler ignores. So every
 * candidate is asked, and one excluded name is enough to refuse.
 */
export function findExclusionAmong(db: any, values: unknown[]): ActiveExclusion | null {
  for (const v of values) {
    for (const hex of hexCandidates(v)) {
      const x = findExclusion(db, hex);
      if (x) return x;
    }
  }
  return null;
}

export function exclusionSyncState(db: any): { lastOkAt: string | null; lastTryAt: string | null; lastError: string | null; count: number; currentSplit: number | null } {
  const r = db.prepare('SELECT last_ok_at, last_try_at, last_error, count, current_split FROM exclusion_sync WHERE id = 1').get() as any;
  return {
    lastOkAt: r?.last_ok_at ?? null,
    lastTryAt: r?.last_try_at ?? null,
    lastError: r?.last_error ?? null,
    count: Number(r?.count) || 0,
    currentSplit: r?.current_split == null ? null : Number(r.current_split),
  };
}

/* ─────────────────────── orchestration ─────────────────────── */

export interface RefreshDeps {
  /** This app's own relay query. It may resolve `[]` on an outage — that is handled. */
  fetchEvents: (filter: Record<string, unknown>, relays: string[]) => Promise<NostrLikeEvent[]>;
  /** Relays to ask, from this app's cached KIND 38888. */
  relays: string[];
  /** trusted_signers.LanaSelfResponsibility from this app's cached KIND 38888. */
  trustedSigners: string[];
  /** The running SPLIT, for lapsing bounded decisions. */
  currentSplit: number | null;
  /** Signature check — nostr-tools verifyEvent. */
  verify: (e: NostrLikeEvent) => boolean;
  /** How many reports to ask for. Comfortably above any real number of them. */
  limit?: number;
}

/**
 * Pull what the relays will serve and merge it in.
 *
 * The query is pinned to the trusted authors, so a stranger cannot publish a
 * thousand KIND 87058s and push the real ones out of the relay's answer — the
 * limit is spent on reports that could actually count.
 *
 * Nothing here can lift a decision by omission. A refresh that reaches no relay,
 * a KIND 38888 cache that has fallen behind a key rotation, a relay serving an
 * old page — all of them leave the standing set exactly as it was.
 */
export async function refreshExclusions(db: any, deps: RefreshDeps): Promise<{ ok: boolean; count: number; written?: number; lifted?: number; reason?: string }> {
  ensureExclusionTables(db);
  const stamp = db.prepare("UPDATE exclusion_sync SET last_try_at = datetime('now'), last_error = ? WHERE id = 1");

  // The SPLIT is worth recording even when the read fails: it is what lapses a
  // bounded decision, and it does not depend on reaching a relay.
  if (deps.currentSplit != null && Number.isFinite(deps.currentSplit) && deps.currentSplit > 0) {
    db.prepare('UPDATE exclusion_sync SET current_split = ? WHERE id = 1').run(deps.currentSplit);
  }

  const trusted = (deps.trustedSigners ?? []).map((k) => String(k).toLowerCase()).filter((k) => /^[0-9a-f]{64}$/.test(k));

  if (!deps.relays?.length) {
    stamp.run('no relays known yet');
    return { ok: false, count: countActive(db), reason: 'no relays known yet' };
  }
  if (trusted.length === 0) {
    stamp.run('KIND 38888 names no LanaSelfResponsibility signer');
    return { ok: false, count: countActive(db), reason: 'KIND 38888 names no LanaSelfResponsibility signer' };
  }

  let events: NostrLikeEvent[];
  try {
    events = await deps.fetchEvents(
      { kinds: [VIOLATION_KIND], authors: trusted, limit: deps.limit ?? 500 },
      deps.relays,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'relay query failed';
    stamp.run(reason);
    return { ok: false, count: countActive(db), reason };
  }

  if (!Array.isArray(events)) {
    stamp.run('relay query returned nothing usable');
    return { ok: false, count: countActive(db), reason: 'relay query returned nothing usable' };
  }

  const reports = readReports(events, {
    trustedSigners: trusted,
    currentSplit: deps.currentSplit,
    verify: deps.verify,
  });

  // Nothing honoured came back. That is what a total outage looks like, what a
  // desynced relay looks like, and what a KIND 38888 cache stranded behind a key
  // rotation looks like — and NONE of them is news. Saying "read successfully"
  // here would let a container that has never reached a relay answer "nobody is
  // excluded" with the same confidence as one that just checked.
  if (reports.length === 0) {
    stamp.run('relays served no report from a trusted signer');
    return { ok: false, count: countActive(db), reason: 'relays served no report from a trusted signer' };
  }

  const { written, lifted } = mergeReports(db, reports);
  const count = countActive(db);
  db.prepare("UPDATE exclusion_sync SET last_ok_at = datetime('now'), last_error = NULL, count = ? WHERE id = 1").run(count);
  return { ok: true, count, written, lifted };
}

function countActive(db: any): number {
  try {
    return Number((db.prepare('SELECT COUNT(*) c FROM person_exclusions WHERE active = 1').get() as any)?.c) || 0;
  } catch {
    return 0;
  }
}

/* ───────────────────────── express ───────────────────────── */

export const EXCLUDED_CODE = 'PERSON_EXCLUDED';

/** The refusal body, so every app tells the person the same thing. */
export function exclusionRefusal(x: ActiveExclusion) {
  return {
    error: 'Access is paused by a commission gross-violation decision',
    code: EXCLUDED_CODE,
    excluded: true,
    ground: x.ground,
    since: x.since,
    untilSplit: x.untilSplit,
    eventId: x.eventId,
  };
}

/**
 * Refuse a request made in an excluded person's name.
 *
 * `getHex` says where this route carries the identity — params, body, headers —
 * because that differs per app and guessing it wrong makes a gate that never
 * fires. Return EVERY field the handler might act on, not the one you think it
 * will use: a gate reading a field the handler ignores is a decoy, and the
 * handler acts on the other one.
 *
 * A request with no name at all passes: this answers "is THIS person excluded",
 * never "is this request authenticated".
 */
export function notExcluded(db: any, getHex: (req: any) => unknown) {
  return (req: any, res: any, next: any) => {
    let raw: unknown;
    try { raw = getHex(req); } catch { raw = null; }
    if (raw == null) return next();
    const x = findExclusionAmong(db, Array.isArray(raw) ? raw : [raw]);
    if (!x) return next();
    return res.status(403).json(exclusionRefusal(x));
  };
}
