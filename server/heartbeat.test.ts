// @vitest-environment node
/**
 * A MACHINE MUST NOT AUTHENTICATE AS A PERSON.
 *
 * This POS's heartbeat mirrors brain's merchant quota counters into
 * business_units, and the CASH pre-flight in index.ts judges every merchant
 * against them. The call that fetched them used to carry a real person's 64-hex
 * Nostr pubkey, hardcoded, as `x-admin-hex-id` to brain's admin API — and that
 * person carries one of the standing KIND 87058 decisions, so brain's gate
 * refuses it. It now holds a service key of its own and asks brain's peer door.
 *
 * Both halves are pinned here because both fail quietly:
 *
 *  - with no key the sync must make NO request at all. The tempting shape is a
 *    fallback to "the key that used to work", which is exactly the
 *    impersonation this removed.
 *  - with a key the request must carry ONLY that key. A stray x-admin-hex-id
 *    left behind in a merge, or a hex smuggled into the query string, would be
 *    refused by brain and the counters would freeze again — after a deploy that
 *    looked green, because a frozen counter still renders.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from './db/schema.js';
import { mirrorMerchantUsageFromBrain } from './heartbeat.js';

const KEY = 'peer-key-for-the-pos';
const UNIT = 'd652671a2c374bac9cc2cdf162115f22';

let db: Database.Database;
let calls: Array<{ url: string; init: any }>;
let realFetch: typeof globalThis.fetch;

function seedUnit() {
  db.prepare(`
    INSERT INTO business_units (unit_id, pubkey, event_id, created_at, name, owner_hex, currency)
    VALUES (?, 'pk', 'ev', 1, 'A merchant', 'owner', 'EUR')
  `).run(UNIT);
}

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ period: '2026-09', count: 0, usage: [] }) } as any;
  }) as any;
  delete process.env.BRAIN_PEER_KEY;
  process.env.BRAIN_API_URL = 'http://brain.test';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BRAIN_PEER_KEY;
  delete process.env.BRAIN_API_URL;
  db.close();
});

describe('mirrorMerchantUsageFromBrain — the credential', () => {
  it('makes NO request at all when BRAIN_PEER_KEY is unset', async () => {
    expect(await mirrorMerchantUsageFromBrain(db, '2026-09')).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("asks brain's PEER door with a Bearer key, and names nobody", async () => {
    process.env.BRAIN_PEER_KEY = KEY;
    await mirrorMerchantUsageFromBrain(db, '2026-09');

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toContain('/api/peer/merchant-usage');
    expect(url).not.toContain('/api/admin/');

    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);

    // No admin-hex header under ANY casing — a machine is not a person.
    for (const name of Object.keys(headers)) {
      expect(name.toLowerCase()).not.toBe('x-admin-hex-id');
    }

    // And no 64-hex anywhere in what goes on the wire, header or URL. This is
    // the assertion that catches somebody re-adding the key by another name.
    const wire = url + ' ' + JSON.stringify(headers);
    expect(wire).not.toMatch(/[0-9a-f]{64}/i);
  });

  it('mirrors the CASH counters into quota_*_used, which is what the POS gates on', async () => {
    seedUnit();
    process.env.BRAIN_PEER_KEY = KEY;
    globalThis.fetch = (async () => ({
      ok: true, status: 200,
      json: async () => ({
        usage: [{
          unit_id: UNIT, tx_count: 9, volume_native: 900,
          tx_count_cash: 3, volume_native_cash: 300,
        }],
      }),
    })) as any;

    expect(await mirrorMerchantUsageFromBrain(db, '2026-09')).toBe(1);
    const row = db.prepare('SELECT * FROM business_units WHERE unit_id = ?').get(UNIT) as any;
    expect(row.quota_volume_used).toBe(300);
    expect(row.quota_tx_used).toBe(3);
    expect(row.quota_period).toBe('2026-09');
  });

  it('does not fall over when brain refuses the key', async () => {
    process.env.BRAIN_PEER_KEY = 'wrong';
    globalThis.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as any;
    expect(await mirrorMerchantUsageFromBrain(db, '2026-09')).toBe(0);
  });
});
