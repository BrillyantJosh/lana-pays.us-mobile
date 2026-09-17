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
import { mirrorMerchantUsageFromBrain, quotaSnapshotForThisMonth } from './heartbeat.js';

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

// ─── A snapshot is not this month's usage ───────────────────────────────────
//
// 16 Sept 2026: the till showed a shop "Approaching limit" with August's
// 4 080.66 of 5 000 while its September cash stood at 1 609.44, and clamped and
// refused cash on those numbers. KIND 30903's quota_*_used is a snapshot,
// rewritten only when a status event is published.

const OTHER = 'ffe2b18bf541aefbb7db6858114ea68b';

function seedSnapshot(unitId: string, over: Record<string, any> = {}) {
  const row = {
    unit_id: unitId, suspension_status: 'quota_warning_80', quota_volume_used: 4080.66, quota_volume_limit: 5000,
    quota_tx_used: 89, quota_tx_limit: 200, quota_currency: 'EUR', quota_period: '2026-08', ...over,
  };
  db.prepare(`
    INSERT INTO business_units (unit_id, pubkey, event_id, created_at, name, owner_hex, currency,
      suspension_status, quota_volume_used, quota_volume_limit, quota_tx_used, quota_tx_limit, quota_currency, quota_period)
    VALUES (@unit_id, 'pk', 'ev', 1, 'A merchant', 'owner', 'EUR',
      @suspension_status, @quota_volume_used, @quota_volume_limit, @quota_tx_used, @quota_tx_limit, @quota_currency, @quota_period)
  `).run(row);
}
const unitRow = (unitId: string) => db.prepare('SELECT * FROM business_units WHERE unit_id = ?').get(unitId) as any;

describe('mirrorMerchantUsageFromBrain — the answer covers the whole month', () => {
  it("a unit brain reports nothing for has sold nothing for cash: the old snapshot does not survive", async () => {
    seedSnapshot(UNIT, { suspension_status: 'active', quota_period: '2026-09', quota_volume_used: 769, quota_tx_used: 3 });
    seedSnapshot(OTHER);
    process.env.BRAIN_PEER_KEY = KEY;
    globalThis.fetch = (async () => ({
      ok: true, status: 200,
      json: async () => ({ period: '2026-09', usage: [{ unit_id: OTHER, tx_count: 57, volume_native: 1682, tx_count_cash: 53, volume_native_cash: 1609.44 }] }),
    })) as any;

    expect(await mirrorMerchantUsageFromBrain(db, '2026-09')).toBe(1);
    expect(unitRow(UNIT)).toMatchObject({ quota_volume_used: 0, quota_tx_used: 0, quota_period: '2026-09', quota_volume_limit: 5000 });
    expect(unitRow(OTHER)).toMatchObject({ quota_volume_used: 1609.44, quota_tx_used: 53, quota_period: '2026-09' });
  });

  it('a malformed answer changes nothing', async () => {
    seedSnapshot(UNIT, { quota_period: '2026-09', quota_volume_used: 300, quota_tx_used: 3 });
    process.env.BRAIN_PEER_KEY = KEY;
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ error: 'something' }) })) as any;

    expect(await mirrorMerchantUsageFromBrain(db, '2026-09')).toBe(0);
    expect(unitRow(UNIT)).toMatchObject({ quota_volume_used: 300, quota_tx_used: 3, quota_period: '2026-09' });
  });

  it('a unit carrying no quota snapshot at all is left as it is', async () => {
    seedSnapshot(UNIT, { suspension_status: 'active', quota_period: '', quota_volume_used: 0, quota_tx_used: 0, quota_volume_limit: 0, quota_tx_limit: 0 });
    process.env.BRAIN_PEER_KEY = KEY;
    await mirrorMerchantUsageFromBrain(db, '2026-09');
    expect(unitRow(UNIT).quota_period).toBe('');
  });
});

describe('quotaSnapshotForThisMonth', () => {
  const SEPT = '2026-09';
  const august = { quota_period: '2026-08', quota_volume_used: 4080.66, quota_tx_used: 89 };

  it("last month's warning → nothing used this month, this month's period, no badge", () => {
    expect(quotaSnapshotForThisMonth(august, 'quota_warning_80', SEPT))
      .toEqual({ status: 'active', volumeUsed: 0, txUsed: 0, period: SEPT });
    expect(quotaSnapshotForThisMonth(august, 'active', SEPT))
      .toEqual({ status: 'active', volumeUsed: 0, txUsed: 0, period: SEPT });
  });

  it("this month's snapshot is kept exactly as published", () => {
    const sept = { quota_period: SEPT, quota_volume_used: 414, quota_tx_used: 8 };
    expect(quotaSnapshotForThisMonth(sept, 'quota_warning_80', SEPT))
      .toEqual({ status: 'quota_warning_80', volumeUsed: 414, txUsed: 8, period: SEPT });
  });

  it("last month's quota_blocked is kept — brain refuses cash on it until the unit is republished", () => {
    expect(quotaSnapshotForThisMonth(august, 'quota_blocked', SEPT))
      .toEqual({ status: 'quota_blocked', volumeUsed: 4080.66, txUsed: 89, period: '2026-08' });
  });

  it('suspended, rejected and pending are kept, whatever their month', () => {
    for (const status of ['suspended', 'rejected', 'pending']) {
      expect(quotaSnapshotForThisMonth(august, status, SEPT).status).toBe(status);
      expect(quotaSnapshotForThisMonth(august, status, SEPT).period).toBe('2026-08');
    }
  });

  it('an event without quota tags stays without them', () => {
    expect(quotaSnapshotForThisMonth({}, 'active', SEPT))
      .toEqual({ status: 'active', volumeUsed: 0, txUsed: 0, period: '' });
  });

  it("defaults to the current UTC month, as brain counts purchases", () => {
    const now = new Date().toISOString().slice(0, 7);
    expect(quotaSnapshotForThisMonth({ ...august, quota_period: '2000-01' }, 'active').period).toBe(now);
  });
});
