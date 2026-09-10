// @vitest-environment node
/**
 * This app's wiring around the shared KIND 87058 logic (./exclusionGate.ts).
 *
 * personExclusion.test.ts already pins the fleet-wide rules. What is pinned HERE
 * is only what lana-pays.us-mobile itself decides:
 *   - where the LanaSelfResponsibility signer and the relay list come from,
 *   - that a missing/garbled KIND 38888 honours NOBODY rather than everybody,
 *   - that the one kill switch really is one switch, and really is all-or-nothing,
 *   - and that there is no allow-list hiding anywhere in the gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  isGateOff,
  trustedSignersFrom,
  readExclusionDeps,
  refreshPersonExclusions,
  excludedNow,
  excludedAmong,
  excludedMerchant,
  gate,
  gateNames,
  namesOn,
  ownerForUnit,
  personsForWallet,
  MERCHANT_UNAVAILABLE_CODE,
  type TrustRootCheck,
} from './exclusionGate.js';
import { KIND_38888_PUBKEY } from './nostr.js';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { ensureExclusionTables, mergeReports, refreshExclusions, type Report, type NostrLikeEvent } from './personExclusion.js';

const SIGNER = '13efbf4ee7c3429182f6dbf412473d35b0dbba00bdbfe9b067fd2591d2ac9ad5';
const PERSON = '56e8670aa65491f8595dc3a71c94aa7445dcdca755ca5f77c07218498a362061';
// Deliberately synthetic. Do NOT reuse a real pubkey as the "not excluded"
// fixture: one of the keys in the canon test file turns out to be a person the
// live relays really do carry a decision against, which reads as a claim.
const FREE_PERSON = 'dededededededededededededededededededededededededededededededede';
// The app's own root admin, to prove admin is not a way out.
const ADMIN = 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66';
// A second clean person, so "owner" and "customer" are never the same fixture.
const CUSTOMER = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';

/**
 * The KIND 38888 this app caches — GENUINELY SIGNED, because the gate now checks.
 *
 * The trust root is one field of one event: whoever 38888 names as
 * LanaSelfResponsibility is whoever can shut a person out of this app. `pubkey`
 * is only a string in a blob a relay handed us, so the gate verifies the
 * signature as well as the author. The production author is pinned in
 * server/lib/nostr.ts and nobody has its secret key, so the fixture signs with
 * its own throwaway key and tells the gate to expect THAT author — the check
 * being exercised is the signature, not the constant.
 */
const SYSTEM_SK = new Uint8Array(32).fill(7);
const SYSTEM_PUBKEY = getPublicKey(SYSTEM_SK);
/** Test-only: expect the fixture's author. `verify` stays the real one. */
const TRUST: TrustRootCheck = { expectedPubkey: SYSTEM_PUBKEY };

const raw38888 = (over: { signers?: any; split?: string } = {}) =>
  JSON.stringify(finalizeEvent({
    kind: 38888,
    created_at: 1,
    tags: [['d', 'main']],
    content: JSON.stringify({
      split: over.split ?? '9',
      trusted_signers: over.signers === undefined
        ? { Lana8Wonder: ['a56253e6232b2ab5a96b60d233434d4f759ba4c858a3cc0f4ec51906dce73ae6'], LanaSelfResponsibility: [SIGNER] }
        : over.signers,
    }),
  }, SYSTEM_SK));

/** The same event with one byte of the signature flipped — a hostile relay's copy. */
const forged38888 = (over: { signers?: any } = {}) => {
  const ev = JSON.parse(raw38888(over));
  ev.sig = (ev.sig.slice(0, -1) + (ev.sig.endsWith('a') ? 'b' : 'a'));
  return JSON.stringify(ev);
};

const freshDb = (row?: { relays?: string; split?: string; raw_event?: string }) => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE kind_38888 (id INTEGER PRIMARY KEY AUTOINCREMENT, relays TEXT, split TEXT, raw_event TEXT)`);
  // The two tables this server already uses to put a name to a wallet and to a shop.
  db.exec(`
    CREATE TABLE users (hex_id TEXT PRIMARY KEY, npub TEXT, lana_address TEXT NOT NULL, display_name TEXT);
    CREATE TABLE business_units (unit_id TEXT PRIMARY KEY, owner_hex TEXT NOT NULL, authorized_hex TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE regular_customers (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_id TEXT, customer_hex_id TEXT, customer_wallet TEXT);
  `);
  if (row) {
    db.prepare('INSERT INTO kind_38888 (relays, split, raw_event) VALUES (?, ?, ?)')
      .run(row.relays ?? null, row.split ?? null, row.raw_event ?? null);
  }
  ensureExclusionTables(db);
  return db;
};

const standing = (hex: string, dTag = 'v1'): Report => ({
  dTag, personHex: hex, ground: 'the stated ground', since: 1700000000, untilSplit: null, eventId: 'ev1',
  active: true, eventCreatedAt: 1700000000,
});

/** Put a standing decision in the table the way a relay read would have. */
const seed = (db: any, ...people: string[]) =>
  mergeReports(db, people.map((hex, i) => standing(hex, `v${i + 1}`)));

/** Drive an express middleware and report what the person got. */
const run = (mw: any, req: any) => new Promise<{ status: number; body: any }>((resolve) => {
  const res = {
    statusCode: 0,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { resolve({ status: this.statusCode, body: b }); return this; },
  };
  mw(req, res, () => resolve({ status: 200, body: null }));
});

const ORIGINAL_SWITCH = process.env.EXCLUSION_GATE;
beforeEach(() => { delete process.env.EXCLUSION_GATE; });
afterEach(() => {
  if (ORIGINAL_SWITCH === undefined) delete process.env.EXCLUSION_GATE;
  else process.env.EXCLUSION_GATE = ORIGINAL_SWITCH;
});

describe('who this app trusts to publish a decision', () => {
  it('reads LanaSelfResponsibility out of the cached KIND 38888, not a second hardcoded key', () => {
    expect(trustedSignersFrom(raw38888(), 'LanaSelfResponsibility', TRUST)).toEqual([SIGNER]);
  });

  it('accepts a bare string as well as a list', () => {
    expect(trustedSignersFrom(raw38888({ signers: { LanaSelfResponsibility: SIGNER } }), 'LanaSelfResponsibility', TRUST)).toEqual([SIGNER]);
  });

  it('names nobody when the role is absent, the event is garbage, or there is no event at all', () => {
    expect(trustedSignersFrom(raw38888({ signers: { LanaRegistrar: [SIGNER] } }), 'LanaSelfResponsibility', TRUST)).toEqual([]);
    expect(trustedSignersFrom('not json', 'LanaSelfResponsibility', TRUST)).toEqual([]);
    expect(trustedSignersFrom(null, 'LanaSelfResponsibility', TRUST)).toEqual([]);
    expect(trustedSignersFrom('', 'LanaSelfResponsibility', TRUST)).toEqual([]);
  });

  it('drops anything that is not a 64-hex pubkey', () => {
    expect(trustedSignersFrom(raw38888({ signers: { LanaSelfResponsibility: ['nope', 42, SIGNER] } }), 'LanaSelfResponsibility', TRUST)).toEqual([SIGNER]);
  });

  it('can be asked about another role without leaking between them', () => {
    expect(trustedSignersFrom(raw38888(), 'Lana8Wonder', TRUST)).toEqual(['a56253e6232b2ab5a96b60d233434d4f759ba4c858a3cc0f4ec51906dce73ae6']);
  });
});

describe('the trust root is an event, not a string', () => {
  it('a KIND 38888 whose SIGNATURE does not verify names nobody', () => {
    // `pubkey` is a field in a JSON blob a relay handed us. Comparing it to the
    // pinned key and stopping there proves nothing: a hostile relay writes that
    // pubkey and names its own LanaSelfResponsibility signer, and the whole gate
    // hangs off exactly that field.
    expect(trustedSignersFrom(forged38888(), 'LanaSelfResponsibility', TRUST)).toEqual([]);
  });

  it('a KIND 38888 from another author names nobody, however well it is signed', () => {
    const OTHER_SK = new Uint8Array(32).fill(9);
    const ev = finalizeEvent({
      kind: 38888, created_at: 1, tags: [['d', 'main']],
      content: JSON.stringify({ trusted_signers: { LanaSelfResponsibility: [SIGNER] } }),
    }, OTHER_SK);
    expect(trustedSignersFrom(JSON.stringify(ev), 'LanaSelfResponsibility', TRUST)).toEqual([]);
  });

  it('an event of the wrong KIND names nobody', () => {
    const ev = finalizeEvent({
      kind: 30001, created_at: 1, tags: [['d', 'main']],
      content: JSON.stringify({ trusted_signers: { LanaSelfResponsibility: [SIGNER] } }),
    }, SYSTEM_SK);
    expect(trustedSignersFrom(JSON.stringify(ev), 'LanaSelfResponsibility', TRUST)).toEqual([]);
  });

  it('a forged 38888 cannot open the door — it leaves the standing set exactly as it was', async () => {
    const db = freshDb({ relays: JSON.stringify(['wss://a']), split: '9', raw_event: forged38888() });
    seed(db, PERSON);
    const r = await refreshPersonExclusions(db, 'test', TRUST);
    expect(r.ok).toBe(false);
    expect(excludedNow(db, PERSON)?.personHex, 'a forged trust root released a standing decision').toBe(PERSON);
  });

  it('with nothing injected, the author it expects is the one nostr.ts pins', () => {
    // The production path takes no arguments at all, so this is what the running
    // server checks against. Nobody may hardcode a second copy of it.
    const ev = finalizeEvent({
      kind: 38888, created_at: 1, tags: [['d', 'main']],
      content: JSON.stringify({ trusted_signers: { LanaSelfResponsibility: [SIGNER] } }),
    }, SYSTEM_SK);
    expect(SYSTEM_PUBKEY).not.toBe(KIND_38888_PUBKEY);
    expect(trustedSignersFrom(JSON.stringify(ev)), 'the default pin is not the app\'s 38888 author').toEqual([]);
  });
});

describe('what the refresh is told to ask', () => {
  it('takes the relays and the SPLIT from the cached row', () => {
    const db = freshDb({ relays: JSON.stringify(['wss://a', 'wss://b']), split: '9', raw_event: raw38888() });
    const deps = readExclusionDeps(db, TRUST);
    expect(deps.relays).toEqual(['wss://a', 'wss://b']);
    expect(deps.currentSplit).toBe(9);
    expect(deps.trustedSigners).toEqual([SIGNER]);
  });

  it('falls back to the bootstrap relays on a container that has never synced', () => {
    const deps = readExclusionDeps(freshDb(), TRUST);
    expect(deps.relays.length).toBeGreaterThan(0);
    expect(deps.relays.every((r) => r.startsWith('ws'))).toBe(true);
    // …but still names no signer, so nothing is honoured until 38888 is read.
    expect(deps.trustedSigners).toEqual([]);
  });

  it('an unreadable relay column falls back rather than crashing the boot', () => {
    const deps = readExclusionDeps(freshDb({ relays: '{not json', raw_event: raw38888() }), TRUST);
    expect(deps.relays.length).toBeGreaterThan(0);
  });

  it('an unknown SPLIT is null, never 0 — a bounded decision must not lapse by accident', () => {
    expect(readExclusionDeps(freshDb({ raw_event: raw38888() }), TRUST).currentSplit).toBeNull();
    expect(readExclusionDeps(freshDb({ split: 'x', raw_event: raw38888() }), TRUST).currentSplit).toBeNull();
    expect(readExclusionDeps(freshDb({ split: '0', raw_event: raw38888() }), TRUST).currentSplit).toBeNull();
  });
});

describe('the gate on a route', () => {
  it('refuses an excluded person with the code, the ground and the round', async () => {
    const db = freshDb();
    seed(db, PERSON);
    const out = await run(gate(db, (r: any) => r.params.hexId), { params: { hexId: PERSON } });
    expect(out.status).toBe(403);
    expect(out.body.code).toBe('PERSON_EXCLUDED');
    expect(out.body.excluded).toBe(true);
    expect(out.body.ground).toBe('the stated ground');
    expect(out.body.untilSplit).toBeNull();
  });

  it('lets everyone else past', async () => {
    const db = freshDb();
    seed(db, PERSON);
    expect((await run(gate(db, (r: any) => r.params.hexId), { params: { hexId: FREE_PERSON } })).status).toBe(200);
  });

  it('does not care about the case the hex arrives in', async () => {
    const db = freshDb();
    seed(db, PERSON);
    expect((await run(gate(db, (r: any) => r.query.staff_hex), { query: { staff_hex: PERSON.toUpperCase() } })).status).toBe(403);
  });

  it('reads the identity wherever the route happens to carry it', async () => {
    const db = freshDb();
    seed(db, PERSON);
    expect((await run(gate(db, (r: any) => r.body?.customer_hex), { body: { customer_hex: PERSON } })).status).toBe(403);
    expect((await run(gate(db, (r: any) => r.body?.event?.pubkey), { body: { event: { pubkey: PERSON } } })).status).toBe(403);
    expect((await run(gate(db, (r: any) => r.headers['x-admin-hex-id']), { headers: { 'x-admin-hex-id': PERSON } })).status).toBe(403);
  });

  it('answers "is THIS person excluded", never "is this request signed"', async () => {
    const db = freshDb();
    seed(db, PERSON);
    expect((await run(gate(db, () => undefined), { params: {} })).status).toBe(200);
    expect((await run(gate(db, () => { throw new Error('no hex on this route'); }), {})).status).toBe(200);
  });

  it('an ADMIN carrying a decision is refused exactly like anyone else — nobody is exempt', async () => {
    const db = freshDb();
    seed(db, ADMIN);
    const out = await run(gate(db, (r: any) => r.headers['x-admin-hex-id']), { headers: { 'x-admin-hex-id': ADMIN } });
    expect(out.status).toBe(403);
  });
});

describe('a database the gate has never seen', () => {
  it('answers instead of throwing — a gate that 500s is not a refusal', async () => {
    // A route registrar can be handed a database server/index.ts never touched.
    // Before ensureOnce() this threw inside SQLite and express replied with its
    // own HTML error page, so every JSON client read "Unexpected token '<'".
    const db = new Database(':memory:');
    const out = await run(gate(db, (r: any) => r.query.hex), { query: { hex: PERSON } });
    expect(out.status).toBe(200);
  });

  it('and excludedNow() answers null rather than throwing', () => {
    const db = new Database(':memory:');
    expect(excludedNow(db, PERSON)).toBeNull();
  });
});

describe('the kill switch, and only it', () => {
  it('is off by default', () => {
    expect(isGateOff()).toBe(false);
  });

  it('is all or nothing: with it off, an excluded person walks through the gate', async () => {
    const db = freshDb();
    seed(db, PERSON);
    process.env.EXCLUSION_GATE = 'off';
    expect(isGateOff()).toBe(true);
    expect((await run(gate(db, (r: any) => r.params.hexId), { params: { hexId: PERSON } })).status).toBe(200);
    expect(excludedNow(db, PERSON)).toBeNull();
  });

  it('only the exact word "off" disables it — a typo must not silently open the door', async () => {
    const db = freshDb();
    seed(db, PERSON);
    for (const v of ['OFF', 'false', '0', 'no', 'on', '']) {
      process.env.EXCLUSION_GATE = v;
      expect(isGateOff(), `EXCLUSION_GATE=${v}`).toBe(false);
      expect((await run(gate(db, (r: any) => r.params.hexId), { params: { hexId: PERSON } })).status).toBe(403);
    }
  });

  it('skips the refresh rather than emptying the set — the standing set survives the switch', async () => {
    const db = freshDb({ relays: JSON.stringify(['wss://a']), split: '9', raw_event: raw38888() });
    seed(db, PERSON);
    process.env.EXCLUSION_GATE = 'off';
    const r = await refreshPersonExclusions(db, 'test', TRUST);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('EXCLUSION_GATE=off');
    // Switch it back on and the decision is still there, untouched.
    delete process.env.EXCLUSION_GATE;
    expect(excludedNow(db, PERSON)?.personHex).toBe(PERSON);
  });
});

describe('the refresh, wired to this app', () => {
  it('refuses to replace the set when KIND 38888 names no signer', async () => {
    const db = freshDb({ relays: JSON.stringify(['wss://a']), split: '9', raw_event: raw38888({ signers: {} }) });
    seed(db, PERSON);
    const r = await refreshPersonExclusions(db, 'test', TRUST);
    expect(r.ok).toBe(false);
    expect(excludedNow(db, PERSON)?.personHex, 'a signer-less 38888 released a standing decision').toBe(PERSON);
  });
});


/* ══════════════ what the adversary walked through, and no longer can ══════════════ */

describe('a gate must read EVERY field the handler acts on', () => {
  it('a decoy field does not save anyone — filling the one the handler ignores was proven live', async () => {
    const db = freshDb();
    seed(db, PERSON);
    const mw = gate(db, (r: any) => [r.headers?.['x-admin-hex'], r.headers?.['x-admin-hex-id'], r.query?.admin_hex]);
    // Clean in the first carrier, excluded in the third. A gate written as
    // `a || b || c` stops at the first truthy one and lets this through.
    const out = await run(mw, { headers: { 'x-admin-hex': FREE_PERSON }, query: { admin_hex: PERSON } });
    expect(out.status, 'a decoy in the first field walked past the gate').toBe(403);
  });

  it('an array wrapper does not save anyone — the handler coerces it back with String()', async () => {
    const db = freshDb();
    seed(db, PERSON);
    expect((await run(gate(db, (r: any) => r.body?.customer_hex), { body: { customer_hex: [PERSON] } })).status).toBe(403);
  });

  it('a padded hex does not save anyone', async () => {
    const db = freshDb();
    seed(db, PERSON);
    expect((await run(gate(db, (r: any) => r.body?.hex), { body: { hex: ' ' + PERSON + '\n' } })).status).toBe(403);
  });
});

describe('the wallet is a second name for the same person', () => {
  it('resolves a LANA address to its owner through this app\'s own users table', () => {
    const db = freshDb();
    db.prepare('INSERT INTO users (hex_id, npub, lana_address) VALUES (?, ?, ?)').run(PERSON, 'npub1', 'LCustomerWallet111');
    expect(personsForWallet(db, 'LCustomerWallet111')).toEqual([PERSON]);
    expect(personsForWallet(db, 'LSomeoneElse')).toEqual([]);
  });

  it('also resolves a wallet a till has served before, when the registrar never carried a hex', () => {
    const db = freshDb();
    db.prepare('INSERT INTO regular_customers (unit_id, customer_hex_id, customer_wallet) VALUES (?, ?, ?)')
      .run('unit-1', PERSON, 'LSecondWallet222');
    expect(personsForWallet(db, 'LSecondWallet222')).toEqual([PERSON]);
  });

  it('resolves EVERY person registered on that wallet, not the first row', async () => {
    // users.lana_address has no unique constraint and POST /api/users is
    // deliberately ungated on it, so one wallet really does carry two rows.
    // Reading it with .get() returned whichever had the lower rowid, and a
    // decision on the OTHER one was invisible — proven live on the probe.
    const db = freshDb();
    seed(db, PERSON);
    db.prepare('INSERT INTO users (hex_id, npub, lana_address) VALUES (?, ?, ?)').run(CUSTOMER, 'n1', 'LShared');
    db.prepare('INSERT INTO users (hex_id, npub, lana_address) VALUES (?, ?, ?)').run(PERSON, 'n2', 'LShared');
    expect(personsForWallet(db, 'LShared')).toEqual([CUSTOMER, PERSON]);
    const mw = gateNames(db, (r: any) => ({ hex: [r.body?.customer_hex], wallet: [r.body?.customer_wallet] }));
    const out = await run(mw, { body: { customer_hex: '', customer_wallet: 'LShared' } });
    expect(out.status, 'an excluded co-owner of the wallet was invisible').toBe(403);
  });

  it('an ARRAY-wrapped wallet does not save anyone — the handler coerces it back', async () => {
    // Proven live: customer_wallet: ['L…'] walked past the gate while the
    // handler read the identical address out of String(customer_wallet).
    const db = freshDb();
    seed(db, PERSON);
    db.prepare('INSERT INTO users (hex_id, npub, lana_address) VALUES (?, ?, ?)').run(PERSON, 'n', 'LExcluded');
    expect(personsForWallet(db, ['LExcluded'])).toEqual([PERSON]);
    const mw = gateNames(db, (r: any) => ({ hex: [r.body?.customer_hex], wallet: [r.body?.customer_wallet] }));
    expect((await run(mw, { body: { customer_hex: '', customer_wallet: ['LExcluded'] } })).status).toBe(403);
  });

  it('a purchase with a BLANK customer_hex and the excluded person\'s wallet is refused', async () => {
    const db = freshDb();
    seed(db, PERSON);
    db.prepare('INSERT INTO users (hex_id, npub, lana_address) VALUES (?, ?, ?)').run(PERSON, 'npub1', 'LCustomerWallet111');
    const mw = gateNames(db, (r: any) => ({ hex: [r.body?.customer_hex], wallet: [r.body?.customer_wallet] }));
    const out = await run(mw, { body: { customer_hex: '', customer_wallet: 'LCustomerWallet111' } });
    expect(out.status, 'an empty name plus a wallet was the way in').toBe(403);
    expect(out.body.code).toBe('PERSON_EXCLUDED');
  });
});

describe('the merchant side of a sale is a person too', () => {
  it('resolves a unit to its OWNER — the person the money reaches — and to nobody else', () => {
    const db = freshDb();
    db.prepare('INSERT INTO business_units (unit_id, owner_hex, authorized_hex) VALUES (?, ?, ?)')
      .run('unit-1', PERSON, JSON.stringify([FREE_PERSON]));
    expect(ownerForUnit(db, 'unit-1')).toEqual([PERSON]);
    expect(ownerForUnit(db, 'no-such-unit')).toEqual([]);
  });

  it('an EXCLUDED MERCHANT selling to a clean customer is refused — unit_id was the whole identity', async () => {
    const db = freshDb();
    seed(db, PERSON);
    db.prepare('INSERT INTO business_units (unit_id, owner_hex, authorized_hex) VALUES (?, ?, ?)')
      .run('unit-1', PERSON, '[]');
    const mw = gateNames(db, (r: any) => ({ hex: [r.body?.customer_hex], unit: [r.body?.unit_id] }));
    const out = await run(mw, { body: { unit_id: 'unit-1', customer_hex: FREE_PERSON } });
    expect(out.status, 'an excluded merchant kept selling and taking real money').toBe(403);
    expect(out.body.code, 'the customer is not the one the commission decided about').toBe(MERCHANT_UNAVAILABLE_CODE);
    expect(out.body.ground, 'a stranger was handed the detail of somebody else\'s sanction').toBeUndefined();
    expect(out.body.eventId).toBeUndefined();
  });

  it('an excluded STAFF member cannot sell — by their OWN name, which is what the till sends', async () => {
    const db = freshDb();
    seed(db, PERSON);
    db.prepare('INSERT INTO business_units (unit_id, owner_hex, authorized_hex) VALUES (?, ?, ?)')
      .run('unit-1', FREE_PERSON, JSON.stringify([PERSON]));
    const mw = gateNames(db, (r: any) => ({
      hex: [r.body?.staff_hex, r.headers?.['x-lana-hex']],
      unit: [r.body?.unit_id],
    }));
    const out = await run(mw, { body: { unit_id: 'unit-1', staff_hex: PERSON }, headers: {} });
    expect(out.status).toBe(403);
    expect(out.body.code, 'the person acting IS the subject — they are told so').toBe('PERSON_EXCLUDED');
  });

  it('an ARRAY-wrapped unit_id does not save an excluded owner', async () => {
    // Proven live: unit_id: ['EXOWNER…'] created a payment request (201) while
    // the plain string was refused, because the handler reads String(unit_id).
    const db = freshDb();
    seed(db, PERSON);
    db.prepare('INSERT INTO business_units (unit_id, owner_hex, authorized_hex) VALUES (?, ?, ?)')
      .run('unit-1', PERSON, '[]');
    expect(ownerForUnit(db, ['unit-1'])).toEqual([PERSON]);
    const mw = gateNames(db, (r: any) => ({ hex: [r.body?.merchant_hex], unit: [r.body?.unit_id] }));
    expect((await run(mw, { body: { unit_id: ['unit-1'], merchant_hex: FREE_PERSON } })).status).toBe(403);
  });

  it('a clean shop with a clean customer still sells', async () => {
    const db = freshDb();
    seed(db, PERSON);
    db.prepare('INSERT INTO business_units (unit_id, owner_hex, authorized_hex) VALUES (?, ?, ?)')
      .run('unit-1', FREE_PERSON, '[]');
    const mw = gateNames(db, (r: any) => ({ hex: [r.body?.customer_hex], unit: [r.body?.unit_id] }));
    expect((await run(mw, { body: { unit_id: 'unit-1', customer_hex: FREE_PERSON } })).status).toBe(200);
  });

  it('a unit whose owner_hex is unreadable names nobody rather than throwing', () => {
    const db = freshDb();
    db.prepare('INSERT INTO business_units (unit_id, owner_hex, authorized_hex) VALUES (?, ?, ?)')
      .run('unit-1', 'not-a-hex', '{not json');
    expect(ownerForUnit(db, 'unit-1')).toEqual([]);
  });
});

/* ══════════════ proportionality: the gate shuts out a PERSON, not a crowd ══════════════ */

describe('a clean person standing near an excluded one keeps working', () => {
  /** A shop whose owner is clean and whose staff list carries one excluded person. */
  const shopWithExcludedStaff = () => {
    const db = freshDb();
    seed(db, PERSON);
    db.prepare('INSERT INTO business_units (unit_id, owner_hex, authorized_hex) VALUES (?, ?, ?)')
      .run('unit-1', FREE_PERSON, JSON.stringify([PERSON]));
    return db;
  };

  const till = (db: any) => gateNames(db, (r: any) => ({
    hex: [r.body?.customer_hex, r.headers?.['x-lana-hex'], r.body?.staff_hex, r.body?.merchant_hex],
    wallet: [r.body?.customer_wallet],
    unit: [r.body?.unit_id],
  }));

  it('the CLEAN OWNER still sells on their own unit when a staff member is excluded', async () => {
    // Live, before this: staff_hex=<owner>, x-lana-hex=<owner>, clean customer,
    // clean wallet -> 403. The whole shop stopped taking money because of
    // somebody else, and the only way out was republishing KIND 30901.
    const db = shopWithExcludedStaff();
    const out = await run(till(db), {
      body: { unit_id: 'unit-1', staff_hex: FREE_PERSON, customer_hex: CUSTOMER },
      headers: { 'x-lana-hex': FREE_PERSON },
    });
    expect(out.status, 'a clean owner was shut out of their own shop').toBe(200);
  });

  it('a CLEAN STAFF member of an EXCLUDED owner is never told THEY are excluded', async () => {
    const db = freshDb();
    seed(db, PERSON);
    db.prepare('INSERT INTO business_units (unit_id, owner_hex, authorized_hex) VALUES (?, ?, ?)')
      .run('unit-1', PERSON, JSON.stringify([FREE_PERSON]));
    const out = await run(till(db), {
      body: { unit_id: 'unit-1', staff_hex: FREE_PERSON, customer_hex: CUSTOMER },
      headers: { 'x-lana-hex': FREE_PERSON },
    });
    // The sale still stops — the money would reach the excluded owner — but the
    // person reading the refusal is the subject of nothing.
    expect(out.status).toBe(403);
    expect(out.body.code).toBe(MERCHANT_UNAVAILABLE_CODE);
    expect(out.body.excluded, 'a clean staff member was shown the closed-door screen').toBeUndefined();
  });

  it('a CLEAN BUYER paying an excluded shop is refused neutrally, not personally', () => {
    const db = freshDb();
    seed(db, PERSON);
    db.prepare('INSERT INTO business_units (unit_id, owner_hex, authorized_hex) VALUES (?, ?, ?)')
      .run('unit-1', PERSON, '[]');
    // What /api/pay/:token does once it has the row in hand.
    expect(excludedMerchant(db, ['unit-1'])?.personHex).toBe(PERSON);
    expect(excludedMerchant(db, ['no-such-unit'])).toBeNull();
  });

  it('a CLEAN ADMIN of an app whose other admin is excluded still reads the dashboard', async () => {
    const db = freshDb();
    seed(db, PERSON);
    const mw = gate(db, (r: any) => [r.headers?.['x-admin-hex-id'], r.query?.admin_hex]);
    expect((await run(mw, { headers: { 'x-admin-hex-id': ADMIN }, query: {} })).status).toBe(200);
  });

  it('a CLEAN customer with a clean wallet still buys at a clean shop', async () => {
    const db = freshDb();
    seed(db, PERSON);
    db.prepare('INSERT INTO users (hex_id, npub, lana_address) VALUES (?, ?, ?)').run(CUSTOMER, 'n', 'LCleanWallet');
    db.prepare('INSERT INTO business_units (unit_id, owner_hex, authorized_hex) VALUES (?, ?, ?)')
      .run('unit-1', FREE_PERSON, JSON.stringify([FREE_PERSON]));
    const out = await run(till(db), {
      body: { unit_id: 'unit-1', staff_hex: FREE_PERSON, customer_hex: CUSTOMER, customer_wallet: 'LCleanWallet' },
      headers: { 'x-lana-hex': FREE_PERSON },
    });
    expect(out.status).toBe(200);
  });
});

describe('excludedAmong, for a handler that learns the merchant from a row', () => {
  it('answers with the decision, so /api/pay/:token can refuse after loading its row', () => {
    const db = freshDb();
    seed(db, PERSON);
    db.prepare('INSERT INTO business_units (unit_id, owner_hex, authorized_hex) VALUES (?, ?, ?)').run('unit-1', PERSON, '[]');
    expect(excludedAmong(db, { unit: ['unit-1'] })?.personHex).toBe(PERSON);
    expect(excludedAmong(db, { unit: ['no-such-unit'] })).toBeNull();
  });

  it('honours the one kill switch like every other route', () => {
    const db = freshDb();
    seed(db, PERSON);
    db.prepare('INSERT INTO business_units (unit_id, owner_hex, authorized_hex) VALUES (?, ?, ?)').run('unit-1', PERSON, '[]');
    process.env.EXCLUSION_GATE = 'off';
    expect(excludedAmong(db, { unit: ['unit-1'] })).toBeNull();
  });

  it('names every carrier once, in the order it was asked', () => {
    const db = freshDb();
    db.prepare('INSERT INTO users (hex_id, npub, lana_address) VALUES (?, ?, ?)').run(PERSON, 'n', 'LWallet');
    db.prepare('INSERT INTO business_units (unit_id, owner_hex, authorized_hex) VALUES (?, ?, ?)').run('u', PERSON, '[]');
    // The same person named three different ways collapses to one name.
    expect(namesOn(db, { hex: [PERSON], wallet: ['LWallet'], unit: ['u'] })).toEqual([PERSON]);
  });
});

describe('a database the gate was handed without this app\'s tables', () => {
  it('resolves nothing and refuses nobody, rather than throwing a 500 at a JSON client', async () => {
    const db = new Database(':memory:');
    expect(personsForWallet(db, 'LWallet')).toEqual([]);
    expect(ownerForUnit(db, 'u')).toEqual([]);
    const mw = gateNames(db, (r: any) => ({ hex: [r.body?.hex], wallet: [r.body?.wallet], unit: [r.body?.unit] }));
    expect((await run(mw, { body: { hex: PERSON, wallet: 'LWallet', unit: 'u' } })).status).toBe(200);
  });
});

describe('the refresh can no longer empty the standing set', () => {
  it('a KIND 38888 cache that has fallen behind a key rotation leaves every decision standing', async () => {
    // The live hole, reproduced through THIS app's own deps reader: the cached
    // 38888 names a RETIRED LanaSelfResponsibility key, the relays answer with
    // real events signed by the CURRENT one, none match the pin — and the old
    // replace-the-whole-set flow reported { ok: true, count: 0 } while DELETING
    // every standing decision. At boot. On every restart. Logging all-clear.
    const RETIRED = '391ba1de270c3f27f2e6d0bd0f9e6de1b2f5e5c4a3b2c1d0e9f8a7b6c5d4e3f2';
    const db = freshDb({
      relays: JSON.stringify(['wss://a']),
      split: '9',
      raw_event: raw38888({ signers: { LanaSelfResponsibility: [RETIRED] } }),
    });
    seed(db, PERSON);

    const deps = readExclusionDeps(db, TRUST);
    expect(deps.trustedSigners, 'the cache is what pins the author').toEqual([RETIRED]);

    // Ten real reports, all signed by the signer the cache has NOT caught up to.
    const realEvent = (d: string): NostrLikeEvent => ({
      id: `id-${d}`, pubkey: SIGNER, created_at: 1800000000, kind: 87058,
      tags: [['d', d], ['status', 'active'], ['p', FREE_PERSON, 'subject']],
      content: '{}', sig: 'x',
    });
    const r = await refreshExclusions(db, {
      relays: deps.relays,
      trustedSigners: deps.trustedSigners,
      currentSplit: deps.currentSplit,
      verify: () => true,
      fetchEvents: async () => Array.from({ length: 10 }, (_, i) => realEvent(`v${i}`)),
    });

    expect(excludedNow(db, PERSON)?.personHex, 'a stale signer pin wiped the standing set').toBe(PERSON);
    expect(r.count).toBe(1);
  });

  it('a relay set that answers nothing at all leaves every decision standing', async () => {
    // And it is NOT reported as an error. The local "did any relay answer?"
    // adapter that used to throw here is gone: a PARTIAL answer looks exactly
    // like a complete one, so the guess was never sound. Merging is what keeps
    // the set safe now, so an empty answer is simply an answer that mentions
    // nobody — and mentioning nobody changes nobody.
    const db = freshDb({ relays: JSON.stringify(['wss://127.0.0.1:1']), split: '9', raw_event: raw38888() });
    seed(db, PERSON);
    const r = await refreshPersonExclusions(db, 'test', TRUST);
    // A read that honoured NOTHING is not a read. It is what a total outage,
    // a desynced relay and a 38888 cache stranded behind a key rotation all
    // look like, and none of them is news — so it does not stamp last_ok_at
    // and it does not claim the set was refreshed.
    expect(r.ok, 'silence was reported as a successful read').toBe(false);
    expect(r.reason).toContain('no report from a trusted signer');
    expect(excludedNow(db, PERSON)?.personHex, 'an outage released a standing decision').toBe(PERSON);
  });
});
