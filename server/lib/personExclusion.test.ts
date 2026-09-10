// RUNNER: change ONLY the import below.
//   vitest repos      → import { describe, it } from 'vitest';
//   node:test repos   → import { describe, it } from 'node:test';
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  selectActiveExclusions,
  strongestFor,
  parseUntilSplit,
  hasLapsed,
  ensureExclusionTables,
  refreshExclusions,
  findExclusion,
  findExclusionAmong,
  exclusionKnown,
  exclusionSyncState,
  MAX_CANDIDATES,
  asPersonHex,
  hexCandidates,
  notExcluded,
  type NostrLikeEvent,
} from './personExclusion.js';

const SIGNER = '13efbf4ee7c3429182f6dbf412473d35b0dbba00bdbfe9b067fd2591d2ac9ad5';
const OTHER = '391ba1de270c3f27f2e6d0bd0f9e6de1b2f5e5c4a3b2c1d0e9f8a7b6c5d4e3f2';
const PERSON = '56e8670aa65491f8595dc3a71c94aa7445dcdca755ca5f77c07218498a362061';
const OTHER_PERSON = 'b1f4a8a9ffacc3d9a5a41eb97b75684e39bfee4e5c8f0b7a482b90de7948bc25';

const yes = () => true;
const no = () => false;

const report = (over: Partial<NostrLikeEvent> & { d?: string; status?: string; until?: string; subject?: string } = {}): NostrLikeEvent => {
  const { d = 'v1', status = 'active', until, subject = PERSON, ...rest } = over;
  const tags: string[][] = [['d', d], ['status', status], ['p', subject, 'subject'], ['effective_at', '1700000000']];
  if (until !== undefined) tags.push(['until_split', until]);
  return {
    id: `id-${d}-${status}`,
    pubkey: SIGNER,
    created_at: 1000,
    kind: 87058,
    tags,
    content: JSON.stringify({ subject: 'the stated ground' }),
    sig: 'x',
    ...rest,
  } as NostrLikeEvent;
};

const opts = (over: any = {}) => ({ trustedSigners: [SIGNER], currentSplit: 9, verify: yes, ...over });

describe('who the report names', () => {
  it('honours a report from the named signer', () => {
    const out = selectActiveExclusions([report()], opts());
    assert.equal(out.length, 1);
    assert.equal(out[0].personHex, PERSON);
    assert.equal(out[0].ground, 'the stated ground');
  });

  it('ignores a report published by anyone else', () => {
    assert.deepEqual(selectActiveExclusions([report({ pubkey: OTHER })], opts()), []);
  });

  it('honours nothing when KIND 38888 names no signer', () => {
    assert.deepEqual(selectActiveExclusions([report()], opts({ trustedSigners: [] })), []);
  });

  it('drops a report whose signature does not verify — a pinned author is not a check', () => {
    assert.deepEqual(selectActiveExclusions([report()], opts({ verify: no })), []);
  });

  it('drops a report that names several people without saying which is the subject', () => {
    const e = report();
    e.tags = [['d', 'v1'], ['status', 'active'], ['p', PERSON], ['p', OTHER_PERSON]];
    assert.deepEqual(selectActiveExclusions([e], opts()), []);
  });

  it('reads a lone unmarked p tag — a report is never ambiguous about who it names', () => {
    const e = report();
    e.tags = [['d', 'v1'], ['status', 'active'], ['p', PERSON]];
    assert.equal(selectActiveExclusions([e], opts())[0].personHex, PERSON);
  });

  it('still excludes when the ground cannot be read', () => {
    const e = report();
    e.content = 'not json';
    const out = selectActiveExclusions([e], opts());
    assert.equal(out.length, 1);
    assert.equal(out[0].ground, '');
  });
});

describe('withdrawal', () => {
  it('a later event on the same violation lifts it', () => {
    const active = report({ d: 'v1' });
    const withdrawn = { ...report({ d: 'v1', status: 'withdrawn' }), created_at: 2000 };
    assert.deepEqual(selectActiveExclusions([active, withdrawn], opts()), []);
  });

  it('lifts only the violation it names', () => {
    const a = report({ d: 'v1' });
    const b = report({ d: 'v2', subject: OTHER_PERSON });
    const withdrawn = { ...report({ d: 'v1', status: 'withdrawn' }), created_at: 2000 };
    const out = selectActiveExclusions([a, b, withdrawn], opts());
    assert.equal(out.length, 1);
    assert.equal(out[0].personHex, OTHER_PERSON);
  });

  it('an older withdrawal does not lift a newer decision', () => {
    const withdrawn = { ...report({ d: 'v1', status: 'withdrawn' }), created_at: 500 };
    const active = { ...report({ d: 'v1' }), created_at: 2000 };
    assert.equal(selectActiveExclusions([withdrawn, active], opts()).length, 1);
  });
});

describe('how long it runs', () => {
  it('absent, zero and rubbish all mean no end', () => {
    for (const v of [undefined, '', ' ', '0', '-3', '7.5', 'indefinite']) assert.equal(parseUntilSplit(v), null);
    assert.equal(parseUntilSplit('12'), 12);
  });

  it('an open decision never lapses', () => {
    assert.equal(hasLapsed(null, 99), false);
  });

  it('entering the round releases', () => {
    assert.equal(hasLapsed(12, 11), false);
    assert.equal(hasLapsed(12, 12), true);
    assert.equal(hasLapsed(12, 13), true);
  });

  it('an unknown SPLIT releases nobody', () => {
    assert.equal(hasLapsed(12, null), false);
    assert.equal(hasLapsed(12, 0), false);
  });

  it('a lapsed report is not in the standing set', () => {
    assert.deepEqual(selectActiveExclusions([report({ until: '9' })], opts({ currentSplit: 9 })), []);
    assert.equal(selectActiveExclusions([report({ until: '10' })], opts({ currentSplit: 9 })).length, 1);
  });
});

describe('when several name the same person', () => {
  it('one without an end outranks every bounded one', () => {
    const list = selectActiveExclusions(
      [report({ d: 'v1', until: '12' }), report({ d: 'v2' })],
      opts(),
    );
    assert.equal(strongestFor(list, PERSON)!.untilSplit, null);
  });

  it('otherwise the one that runs longest answers', () => {
    const list = selectActiveExclusions(
      [report({ d: 'v1', until: '11' }), report({ d: 'v2', until: '14' })],
      opts(),
    );
    assert.equal(strongestFor(list, PERSON)!.untilSplit, 14);
  });

  it('names nobody it was not asked about', () => {
    const list = selectActiveExclusions([report()], opts());
    assert.equal(strongestFor(list, OTHER_PERSON), null);
  });
});

describe('the standing set', () => {
  const fresh = () => { const db = new Database(':memory:'); ensureExclusionTables(db); return db; };
  const deps = (over: any = {}) => ({
    fetchEvents: async () => [report()],
    relays: ['wss://r'],
    trustedSigners: [SIGNER],
    currentSplit: 9,
    verify: yes,
    ...over,
  });

  it('a good read makes the set', async () => {
    const db = fresh();
    const r = await refreshExclusions(db, deps());
    assert.equal(r.ok, true);
    assert.equal(r.count, 1);
    assert.equal(findExclusion(db, PERSON)!.personHex, PERSON);
    assert.equal(findExclusion(db, OTHER_PERSON), null);
  });

  it('a relay that THROWS never releases anyone', async () => {
    const db = fresh();
    await refreshExclusions(db, deps());
    const r = await refreshExclusions(db, deps({ fetchEvents: async () => { throw new Error('down'); } }));
    assert.equal(r.ok, false);
    assert.ok(findExclusion(db, PERSON), 'the outage lifted a standing decision');
  });

  it('a relay that answers [] never releases anyone — every helper in this fleet does exactly that when the network is down', async () => {
    const db = fresh();
    await refreshExclusions(db, deps());
    const r = await refreshExclusions(db, deps({ fetchEvents: async () => [] }));
    assert.equal(r.ok, false, 'an answer with nothing honoured in it is not a reading');
    assert.ok(findExclusion(db, PERSON), 'an empty answer lifted a standing decision');
  });

  it('a machine that has never been served a report does not claim to know', async () => {
    const db = fresh();
    assert.equal(exclusionKnown(db), false);
    await refreshExclusions(db, deps({ fetchEvents: async () => [] }));
    assert.equal(exclusionKnown(db), false, 'an unreachable relay certified an empty table as read');
    await refreshExclusions(db, deps());
    assert.equal(exclusionKnown(db), true);
  });

  it('a read that served only OTHER signers\' events is not a reading either', async () => {
    const db = fresh();
    await refreshExclusions(db, deps({ fetchEvents: async () => [report({ pubkey: OTHER } as any)] }));
    assert.equal(exclusionKnown(db), false);
  });

  it('a PARTIAL answer leaves the reports it did not mention alone', async () => {
    const db = fresh();
    await refreshExclusions(db, deps({
      fetchEvents: async () => [report({ d: 'v1' }), report({ d: 'v2', subject: OTHER_PERSON })],
    }));
    await refreshExclusions(db, deps({ fetchEvents: async () => [report({ d: 'v1' })] }));
    assert.ok(findExclusion(db, OTHER_PERSON), 'a report missing from one answer was treated as withdrawn');
  });

  it('only a WITHDRAWAL lifts — and it lifts only its own violation', async () => {
    const db = fresh();
    await refreshExclusions(db, deps({
      fetchEvents: async () => [report({ d: 'v1' }), report({ d: 'v2', subject: OTHER_PERSON })],
    }));
    await refreshExclusions(db, deps({
      fetchEvents: async () => [{ ...report({ d: 'v1', status: 'withdrawn' }), created_at: 2000 }],
    }));
    assert.equal(findExclusion(db, PERSON), null, 'the withdrawal did not lift');
    assert.ok(findExclusion(db, OTHER_PERSON), 'the withdrawal lifted somebody else');
  });

  it('an old copy still on some relay cannot resurrect a withdrawn decision', async () => {
    const db = fresh();
    await refreshExclusions(db, deps({ fetchEvents: async () => [{ ...report({ d: 'v1' }), created_at: 1000 }] }));
    await refreshExclusions(db, deps({ fetchEvents: async () => [{ ...report({ d: 'v1', status: 'withdrawn' }), created_at: 2000 }] }));
    await refreshExclusions(db, deps({ fetchEvents: async () => [{ ...report({ d: 'v1' }), created_at: 1000 }] }));
    assert.equal(findExclusion(db, PERSON), null, 'a stale event resurrected a lifted sanction');
  });

  it('a KIND 38888 cache that has fallen behind a key rotation changes nothing', async () => {
    const db = fresh();
    await refreshExclusions(db, deps());
    const r = await refreshExclusions(db, deps({ trustedSigners: [OTHER] }));
    assert.equal(r.ok, false, 'a read that honoured nothing is not a reading');
    assert.ok(findExclusion(db, PERSON), 'a stale signer pin wiped the set');
  });

  it('asks the relays only for the authors that could count', async () => {
    const db = fresh();
    let seen: any = null;
    await refreshExclusions(db, deps({ fetchEvents: async (f: any) => { seen = f; return [report()]; } }));
    assert.deepEqual(seen.authors, [SIGNER], 'without an author pin a stranger can flood the limit');
    assert.deepEqual(seen.kinds, [87058]);
  });

  it('ignores a signer that is not a Nostr key at all', async () => {
    const db = fresh();
    assert.equal((await refreshExclusions(db, deps({ trustedSigners: ['not-a-key'] }))).ok, false);
  });

  it('refuses to work with no relays and with no named signer', async () => {
    const db = fresh();
    assert.equal((await refreshExclusions(db, deps({ relays: [] }))).ok, false);
    assert.equal((await refreshExclusions(db, deps({ trustedSigners: [] }))).ok, false);
  });

  it('a bounded decision runs out on its round without any relay being read', async () => {
    const db = fresh();
    await refreshExclusions(db, deps({ fetchEvents: async () => [report({ until: '12' })], currentSplit: 11 }));
    assert.ok(findExclusion(db, PERSON));
    await refreshExclusions(db, deps({ fetchEvents: async () => { throw new Error('down'); }, currentSplit: 12 }));
    assert.equal(findExclusion(db, PERSON), null, 'the round arrived and the decision still stood');
  });

  it('remembers the SPLIT even when the read fails', async () => {
    const db = fresh();
    await refreshExclusions(db, deps({ fetchEvents: async () => { throw new Error('down'); }, currentSplit: 9 }));
    assert.equal(exclusionSyncState(db).currentSplit, 9);
  });

  it('survives a table that is not there, rather than 500ing every route', async () => {
    const db = fresh();
    await refreshExclusions(db, deps());
    db.exec('DROP TABLE person_exclusions');
    assert.equal(findExclusion(db, PERSON), null);
    assert.equal(exclusionKnown(db), true);
  });

  it('a malformed hex is nobody', () => {
    const db = fresh();
    assert.equal(findExclusion(db, 'nope'), null);
    assert.equal(findExclusion(db, ''), null);
    assert.equal(findExclusion(db, null), null);
  });

  it('whitespace and case do not walk past the gate', async () => {
    const db = fresh();
    await refreshExclusions(db, deps());
    assert.ok(findExclusion(db, PERSON.toUpperCase()));
    assert.ok(findExclusion(db, ' ' + PERSON + ' '), 'a trailing space defeated the gate');
    assert.ok(findExclusion(db, '\n' + PERSON));
  });
});

describe('reading a name out of a request', () => {
  it('takes a hex however it was wrapped', () => {
    assert.equal(asPersonHex(' ' + PERSON.toUpperCase() + ' '), PERSON);
    assert.equal(asPersonHex(PERSON + 'x'), null);
    assert.equal(asPersonHex(undefined), null);
    assert.deepEqual(hexCandidates([PERSON]), [PERSON], 'an array wrapper defeated the gate');
    assert.deepEqual(hexCandidates([[PERSON], 'junk', OTHER_PERSON]), [PERSON, OTHER_PERSON]);
    assert.deepEqual(hexCandidates({ hex: PERSON }), []);
  });

  it('does not let one request name more people than any handler could act on', () => {
    const many = Array.from({ length: 5000 }, (_, i) => i.toString(16).padStart(64, '0'));
    const out = hexCandidates(many);
    assert.equal(out.length, MAX_CANDIDATES, 'an unbounded walk over a 2 MB body froze a server for 400 ms');
  });

  it('does not ask the same name twice', () => {
    assert.deepEqual(hexCandidates([PERSON, PERSON, ' ' + PERSON.toUpperCase()]), [PERSON]);
  });

  it('still finds a name hiding at the end of a long list', () => {
    const list = [...Array.from({ length: 8 }, (_, i) => i.toString(16).padStart(64, '0')), PERSON];
    assert.ok(hexCandidates(list).includes(PERSON));
  });
});

describe('the refusal', () => {
  const fresh = async () => {
    const db = new Database(':memory:');
    ensureExclusionTables(db);
    await refreshExclusions(db, {
      fetchEvents: async () => [report()], relays: ['wss://r'],
      trustedSigners: [SIGNER], currentSplit: 9, verify: yes,
    });
    return db;
  };
  const run = (mw: any, req: any) => new Promise<any>((resolve) => {
    const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json(b: any) { resolve({ status: this.statusCode, body: b }); return this; } };
    mw(req, res, () => resolve({ status: 200, body: null }));
  });

  it('refuses an excluded person with the ground and the round', async () => {
    const db = await fresh();
    const out = await run(notExcluded(db, (r: any) => r.params.hexId), { params: { hexId: PERSON } });
    assert.equal(out.status, 403);
    assert.equal(out.body.code, 'PERSON_EXCLUDED');
    assert.equal(out.body.ground, 'the stated ground');
    assert.equal(out.body.untilSplit, null);
  });

  it('lets everyone else through', async () => {
    const db = await fresh();
    assert.equal((await run(notExcluded(db, (r: any) => r.params.hexId), { params: { hexId: OTHER_PERSON } })).status, 200);
  });

  it('answers "is this person excluded", never "is this request signed"', async () => {
    const db = await fresh();
    assert.equal((await run(notExcluded(db, () => undefined), { params: {} })).status, 200);
    assert.equal((await run(notExcluded(db, () => { throw new Error('no hex here'); }), {})).status, 200);
  });

  it('a decoy field does not save anyone — every candidate is asked', async () => {
    const db = await fresh();
    const gate = notExcluded(db, (r: any) => [r.headers?.['x-admin-hex'], r.body?.ownerHex]);
    const out = await run(gate, { headers: { 'x-admin-hex': OTHER_PERSON }, body: { ownerHex: PERSON } });
    assert.equal(out.status, 403, 'filling a field the handler ignores walked past the gate');
  });

  it('an array wrapper does not save anyone', async () => {
    const db = await fresh();
    const out = await run(notExcluded(db, (r: any) => r.body.hex), { body: { hex: [PERSON] } });
    assert.equal(out.status, 403);
  });

  it('a padded hex does not save anyone', async () => {
    const db = await fresh();
    const out = await run(notExcluded(db, (r: any) => r.body.hex), { body: { hex: ' ' + PERSON } });
    assert.equal(out.status, 403);
  });

  it('findExclusionAmong asks every name it is handed', async () => {
    const db = await fresh();
    assert.ok(findExclusionAmong(db, [OTHER_PERSON, { nope: 1 }, PERSON]));
    assert.equal(findExclusionAmong(db, [OTHER_PERSON, null]), null);
  });
});
