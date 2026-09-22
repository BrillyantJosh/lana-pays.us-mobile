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
 *  - with no MACHINE key at all the sync must make NO request. The forbidden
 *    fallback is to a person — "the key that used to work" was somebody's hex,
 *    and borrowing it is the impersonation this removed. Brain's peer door
 *    accepts either service key, PEER_API_KEY or PURCHASE_API_KEY, so this
 *    container reads BRAIN_PEER_KEY and falls back to BRAIN_PURCHASE_KEY, as
 *    lib/brainPayouts.ts already did for the same door. Both name nobody.
 *  - with a key the request must carry ONLY that key. A stray x-admin-hex-id
 *    left behind in a merge, or a hex smuggled into the query string, would be
 *    refused by brain and the counters would freeze again — after a deploy that
 *    looked green, because a frozen counter still renders.
 *
 * 18–22 Sept 2026: BRAIN_PEER_KEY was empty in the production container while
 * BRAIN_PURCHASE_KEY was set and valid. This file read only the first, so the
 * sync skipped for four days, merchants saw a frozen quota bar on the phone
 * (one read 84% against a real 98%) and the till kept stopping them correctly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from './db/schema.js';
import { mirrorMerchantUsageFromBrain, quotaSnapshotForThisMonth } from './heartbeat.js';

const KEY = 'peer-key-for-the-pos';
const PURCHASE_KEY = 'purchase-key-for-the-pos';
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
  // BOTH machine keys, or a developer's own environment decides the outcome.
  delete process.env.BRAIN_PEER_KEY;
  delete process.env.BRAIN_PURCHASE_KEY;
  process.env.BRAIN_API_URL = 'http://brain.test';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BRAIN_PEER_KEY;
  delete process.env.BRAIN_PURCHASE_KEY;
  delete process.env.BRAIN_API_URL;
  db.close();
});

describe('mirrorMerchantUsageFromBrain — the credential', () => {
  it('makes NO request at all when NEITHER machine key is set, and says so', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await mirrorMerchantUsageFromBrain(db, '2026-09')).toBe(0);
      expect(calls).toHaveLength(0);
      // The line has to name both, or it sends whoever reads it to check the
      // one variable that was empty while the other sat there, set and valid.
      const said = err.mock.calls.map(c => String(c[0])).join(' ');
      expect(said).toContain('BRAIN_PEER_KEY');
      expect(said).toContain('BRAIN_PURCHASE_KEY');
    } finally {
      err.mockRestore();
    }
  });

  /**
   * The four-day silence, pinned. BRAIN_PEER_KEY empty and BRAIN_PURCHASE_KEY
   * set is the exact production shape of 18–22 Sept 2026: brain's peer door
   * accepts that key, lib/brainPayouts.ts was already using it for the same
   * door, and only this sync refused to try — so the counters froze while
   * everything around them looked healthy.
   */
  it('falls back to BRAIN_PURCHASE_KEY when BRAIN_PEER_KEY is empty — it must NOT skip', async () => {
    process.env.BRAIN_PEER_KEY = '';
    process.env.BRAIN_PURCHASE_KEY = PURCHASE_KEY;

    await mirrorMerchantUsageFromBrain(db, '2026-09');

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toContain('/api/peer/merchant-usage');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${PURCHASE_KEY}`);
    // Still a service key, still naming nobody: the fallback that is forbidden
    // is the one to a person's hex, not the one to the other machine key.
    expect(url + ' ' + JSON.stringify(headers)).not.toMatch(/[0-9a-f]{64}/i);
  });

  it('prefers BRAIN_PEER_KEY when both are set', async () => {
    process.env.BRAIN_PEER_KEY = KEY;
    process.env.BRAIN_PURCHASE_KEY = PURCHASE_KEY;

    await mirrorMerchantUsageFromBrain(db, '2026-09');

    expect(calls).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it('a whitespace-only key is no key — it does not go on the wire as one', async () => {
    process.env.BRAIN_PEER_KEY = '   ';
    process.env.BRAIN_PURCHASE_KEY = PURCHASE_KEY;

    await mirrorMerchantUsageFromBrain(db, '2026-09');

    expect(calls).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${PURCHASE_KEY}`);
  });

  /**
   * A standing failure must not read like a blip. The outage printed the same
   * single line every minute for four days, so the log looked identical on day
   * one and on day four. Counting is all this asks for — same line, same place.
   */
  it('a repeated failure says it is repeating', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await mirrorMerchantUsageFromBrain(db, '2026-09');
      await mirrorMerchantUsageFromBrain(db, '2026-09');
      expect(String(err.mock.calls.at(-1)?.[0])).toContain('in a row');
    } finally {
      err.mockRestore();
    }
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

  /**
   * 22 Sept 2026, minutes after a deploy: the peer key was empty, the fallback
   * went out and brain answered 401. The line named BRAIN_PEER_KEY as the thing
   * to correct, which was the wrong repair — that variable was not wrong, it
   * was absent. A refusal has to say which of the two it actually sent.
   */
  it('a refusal names the variable the key came from, and flags a refused fallback', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env.BRAIN_PEER_KEY = '';
      process.env.BRAIN_PURCHASE_KEY = PURCHASE_KEY;
      globalThis.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as any;

      await mirrorMerchantUsageFromBrain(db, '2026-09');

      const said = String(err.mock.calls.at(-1)?.[0]);
      expect(said).toContain('from BRAIN_PURCHASE_KEY');
      expect(said).toContain('BRAIN_PEER_KEY is empty here');
      // The name, never the key itself.
      expect(said).not.toContain(PURCHASE_KEY);
    } finally {
      err.mockRestore();
    }
  });

  it('a refusal on the primary key does not blame the fallback', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env.BRAIN_PEER_KEY = KEY;
      process.env.BRAIN_PURCHASE_KEY = PURCHASE_KEY;
      globalThis.fetch = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as any;

      await mirrorMerchantUsageFromBrain(db, '2026-09');

      const said = String(err.mock.calls.at(-1)?.[0]);
      expect(said).toContain('from BRAIN_PEER_KEY');
      expect(said).not.toContain('is empty here');
      expect(said).not.toContain(KEY);
    } finally {
      err.mockRestore();
    }
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
