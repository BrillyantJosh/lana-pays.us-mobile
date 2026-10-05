// @vitest-environment node
/**
 * KIND 30902 / 30903 are the processor's word, and only its word (5 Oct 2026).
 *
 * Until now fetchKind30902 (max_tx_amount, caretaker) and fetchKind30903
 * (gateway status, suspension, quota) took the newest event per unit from ANY
 * author, signature unchecked. Anyone able to write to a relay could lift a
 * unit's transaction cap, name a caretaker, or sign a suspended unit back to
 * 'active'. lana-brain pinned both to the processor key on 23 Jul 2026
 * (a3c133c); this pins the port:
 *
 *   - a stranger's correctly signed 30902/30903 is not taken;
 *   - neither is a copy that claims the processor key without its signature;
 *   - the processor's real event survives a forged newer one (per candidate,
 *     before newest-wins), and a created_at more than 300 s ahead is dropped;
 *   - KIND_POLICY_AUTHOR_PIN=0 is log-only for the author, never the signature;
 *   - a read that leaves no 30903 keeps the stored statuses — it does not turn
 *     every suspended unit 'active'.
 *
 * Everything runs against a loopback relay stub; nothing leaves 127.0.0.1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Before any import reads it: a code path that falls back to the built-in
// relay list must find a dead loopback relay, never the production ones.
vi.hoisted(() => { process.env.LANA_RELAYS_OVERRIDE = 'ws://127.0.0.1:9'; });

import Database from 'better-sqlite3';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { initializeSchema } from './db/schema.js';
import { applySuspensions } from './heartbeat.js';
import { PROCESSOR_PUBKEY, fetchKind30902, fetchKind30903, selectProcessorEvents } from './lib/nostr.js';

const mk = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const stranger = mk();
const UNIT = '7'.repeat(32);
const now = () => Math.floor(Date.now() / 1000);

const sign = (sk: Uint8Array, kind: number, tags: string[][], createdAt: number) =>
  finalizeEvent({ kind, tags, content: '', created_at: createdAt }, sk) as any;

const policy = (sk: Uint8Array, maxTx: string, createdAt: number, caretaker = '') => sign(sk, 30902, [
  ['d', `policy_${UNIT.slice(0, 8)}_x`], ['unit_id', UNIT], ['lana_discount_per', '5.00'], ['lanapays_us_per', '5.00'],
  ['max_tx_amount', maxTx, 'EUR'], ['caretaker_hex', caretaker], ['status', 'active'],
], createdAt);

const status = (sk: Uint8Array, value: string, createdAt: number) => sign(sk, 30903, [
  ['d', UNIT], ['unit_id', UNIT], ['status', value], ['reason', 'r'],
], createdAt);

/**
 * `ev` claiming another key, with an id of the forger's choosing and the
 * original sig — what a relay can hand over. Built field by field, never
 * spread (a spread would carry nostr-tools' verified flag along).
 */
const claimingKey = (ev: any, pubkey: string) => ({
  id: crypto.randomBytes(32).toString('hex'), pubkey, created_at: ev.created_at, kind: ev.kind,
  tags: ev.tags, content: ev.content, sig: ev.sig,
});

// ── loopback relay stub: answers kinds, ignores authors (as a hostile relay may) ──
let relayEvents: any[] = [];
let relay: WebSocketServer;
let relayUrl = '';

beforeAll(async () => {
  relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(r => relay.once('listening', r));
  relay.on('connection', (socket) => {
    socket.on('message', (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m[0] !== 'REQ') return;
        const [, sub, ...filters] = m;
        for (const ev of relayEvents) {
          if (filters.some((f: any) => !Array.isArray(f.kinds) || f.kinds.includes(ev.kind))) socket.send(JSON.stringify(['EVENT', sub, ev]));
        }
        socket.send(JSON.stringify(['EOSE', sub]));
      } catch { /* ignore */ }
    });
  });
  relayUrl = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(r => relay.close(() => r()));
});

beforeEach(() => {
  relayEvents = [];
  delete process.env.KIND_POLICY_AUTHOR_PIN;
});

afterEach(() => {
  delete process.env.KIND_POLICY_AUTHOR_PIN;
});

describe('fetchKind30902 — max_tx_amount and caretaker', () => {
  it('a stranger\'s correctly signed 30902 is not taken', async () => {
    relayEvents = [policy(stranger.sk, '999999.00', now() - 10, stranger.pk)];
    const got = await fetchKind30902([relayUrl]);
    expect(got.filter(p => p.unit_id === UNIT), 'a stranger set the unit\'s max_tx_amount').toEqual([]);
  });

  it('nor a copy that claims the processor key without its signature', async () => {
    relayEvents = [claimingKey(policy(stranger.sk, '999999.00', now() - 10, stranger.pk), PROCESSOR_PUBKEY)];
    expect((await fetchKind30902([relayUrl])).filter(p => p.unit_id === UNIT)).toEqual([]);
  });

  it('KIND_POLICY_AUTHOR_PIN=0 is log-only for the author, never for the signature', async () => {
    process.env.KIND_POLICY_AUTHOR_PIN = '0';
    relayEvents = [policy(stranger.sk, '999999.00', now() - 10)];
    expect((await fetchKind30902([relayUrl])).map(p => p.max_tx_amount)).toEqual(['999999.00']);
    relayEvents = [claimingKey(policy(stranger.sk, '999999.00', now() - 10), PROCESSOR_PUBKEY)];
    expect(await fetchKind30902([relayUrl])).toEqual([]);
  });
});

describe('fetchKind30903 — gateway status, suspension, quota', () => {
  it('a stranger\'s correctly signed 30903 is not taken', async () => {
    relayEvents = [status(stranger.sk, 'active', now() - 10)];
    expect(await fetchKind30903([relayUrl]), 'a stranger set the unit\'s gateway status').toEqual([]);
  });

  it('nor a copy that claims the processor key without its signature', async () => {
    relayEvents = [claimingKey(status(stranger.sk, 'active', now() - 10), PROCESSOR_PUBKEY)];
    expect(await fetchKind30903([relayUrl])).toEqual([]);
  });
});

describe('selectProcessorEvents (pure)', () => {
  const processor = mk();
  const unitOf = (ev: any) => ev.tags.find((t: string[]) => t[0] === 'unit_id')?.[1];

  it('the processor\'s event survives a stranger\'s newer one: the author is checked per candidate, before newest-wins', () => {
    const real = policy(processor.sk, '300.00', now() - 3600);
    const picked = selectProcessorEvents([policy(stranger.sk, '999999.00', now() + 1), real], 30902, unitOf, { processorPubkey: processor.pk, enforced: true });
    expect(picked.map(e => e.id)).toEqual([real.id]);
  });

  it('the newest of the processor\'s own wins; one more than 300 s ahead is dropped', () => {
    const older = policy(processor.sk, '300.00', now() - 3600);
    const newer = policy(processor.sk, '500.00', now() - 60);
    const future = policy(processor.sk, '999999.00', now() + 3600);
    const picked = selectProcessorEvents([older, future, newer], 30902, unitOf, { processorPubkey: processor.pk, enforced: true });
    expect(picked.map(e => e.id)).toEqual([newer.id]);
  });

  it('an object spread from a verified event is checked again, not believed on nostr-tools\' cached flag', () => {
    const real = policy(processor.sk, '300.00', now() - 60);
    const picked = selectProcessorEvents([real], 30902, unitOf, { processorPubkey: processor.pk, enforced: true });
    expect(picked).toHaveLength(1);
    const tampered = { ...real, tags: real.tags.map((t: string[]) => t[0] === 'max_tx_amount' ? [t[0], '999999.00', 'EUR'] : t) };
    expect(selectProcessorEvents([tampered], 30902, unitOf, { processorPubkey: processor.pk, enforced: true })).toEqual([]);
  });
});

describe('applySuspensions', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    db.prepare(`INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex) VALUES (?, 'e', ?, 1, 'x', ?)`)
      .run(UNIT, stranger.pk, stranger.pk);
    db.prepare(`UPDATE business_units SET suspension_status = 'suspended', suspension_reason = 'by the commission' WHERE unit_id = ?`).run(UNIT);
  });
  afterEach(() => db.close());
  const statusNow = () => (db.prepare('SELECT suspension_status FROM business_units WHERE unit_id = ?').get(UNIT) as any).suspension_status;

  it('a read that leaves no 30903 keeps the stored statuses instead of making everyone active', () => {
    expect(applySuspensions(db, [])).toBe(0);
    expect(statusNow(), 'an empty read released a suspended unit').toBe('suspended');
  });

  it('the processor\'s events still set the status', () => {
    applySuspensions(db, [{ unit_id: UNIT, event_id: 'p', pubkey: PROCESSOR_PUBKEY, created_at: now(), status: 'active', reason: '', content: '' }]);
    expect(statusNow()).toBe('active');
  });
});
