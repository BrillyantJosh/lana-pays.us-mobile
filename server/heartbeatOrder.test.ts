// @vitest-environment node
/**
 * The order inside a real runHeartbeat: the KIND 30903 snapshot, then at once the
 * brain's live cash counters over it, then the rest of the beat.
 *
 * The cash clamp and pre-flight judge a sale on these columns. The snapshot can be
 * ten minutes old, and reading KIND 30902 takes seconds, so the mirror must not
 * wait for it. Without the mirror, or with it before the snapshot, the snapshot is
 * what stays in the row, and these tests fail.
 *
 * Every relay read is mocked and fetch is a stub: nothing leaves this process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const UNIT = 'd652671a2c374bac9cc2cdf162115f22';
const steps = vi.hoisted(() => ({
  log: [] as string[],
  whenPoliciesAreRead: null as null | (() => void),
  statusEvents: [] as unknown[],
}));

vi.mock('./lib/nostr.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  fetchKind38888: async () => ({
    event_id: 'ev38888', pubkey: 'pk', created_at: 1, relays: ['ws://127.0.0.1:9'], electrum_servers: [],
    exchange_rates: { EUR: 0.25, USD: 0.25, GBP: 0.25 }, split: '8', version: '3', valid_from: 1,
    split_approaching: false, freeze_lana_retail_account_above: 0, max_cap_lanas_on_split: 0, raw_event: '{}',
  }),
  fetchKind30901: async () => [],
  fetchKind30903: async () => { steps.log.push('snapshot'); return steps.statusEvents; },
  fetchKind30902: async () => { steps.log.push('policies'); steps.whenPoliciesAreRead?.(); return []; },
  fetchKind0Profile: async () => null,
}));
vi.mock('./lib/orderSync.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  syncShopOrders: async () => {},
}));
vi.mock('./lib/exclusionGate.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  refreshPersonExclusions: async () => ({ ok: true, count: 0 }),
}));

import { initializeSchema } from './db/schema.js';
import { runHeartbeat } from './heartbeat.js';

let db: Database.Database;
let realFetch: typeof globalThis.fetch;
const quiet = { log: console.log, warn: console.warn, error: console.error };

const unitRow = () => db.prepare('SELECT quota_volume_used, quota_tx_used, quota_volume_limit, quota_period FROM business_units WHERE unit_id = ?').get(UNIT) as any;
const thisMonth = new Date().toISOString().slice(0, 7);

/** What the snapshot says and what the brain says differ, so the row shows which one won. */
const SNAPSHOT = 1252.92;
const LIVE = 1259.62;

function answerBrain(usage: { status?: number; body?: unknown }) {
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('/api/peer/merchant-usage')) {
      steps.log.push('mirror');
      return { ok: (usage.status ?? 200) < 300, status: usage.status ?? 200, json: async () => usage.body } as any;
    }
    return { ok: false, status: 503, json: async () => ({}) } as any;
  }) as any;
}

beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  steps.log.length = 0;
  steps.whenPoliciesAreRead = null;
  db = new Database(':memory:');
  initializeSchema(db);
  db.prepare(`INSERT INTO business_units (unit_id, pubkey, event_id, created_at, name, owner_hex, currency)
    VALUES (?, 'pk', 'ev', 1, 'A merchant', 'owner', 'EUR')`).run(UNIT);
  steps.statusEvents = [{
    unit_id: UNIT, event_id: 'e', pubkey: 'p', created_at: 1, status: 'active', reason: '', content: '',
    quota_period: thisMonth, quota_volume_used: SNAPSHOT, quota_volume_limit: 3000, quota_tx_used: 35, quota_tx_limit: 50, quota_currency: 'EUR',
  }];
  realFetch = globalThis.fetch;
  process.env.BRAIN_PEER_KEY = 'peer-key';
  process.env.BRAIN_API_URL = 'http://brain.test';
  answerBrain({ body: { period: thisMonth, usage: [{ unit_id: UNIT, tx_count: 40, volume_native: 2000, tx_count_cash: 36, volume_native_cash: LIVE }] } });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BRAIN_PEER_KEY;
  delete process.env.BRAIN_API_URL;
  db.close();
  Object.assign(console, quiet);
});

describe('runHeartbeat', () => {
  it('ends with the live cash counters in the row, not the snapshot', async () => {
    await runHeartbeat(db);

    expect(unitRow()).toMatchObject({ quota_volume_used: LIVE, quota_tx_used: 36, quota_volume_limit: 3000 });
    expect(steps.log).toContain('mirror');
  });

  it('runs the mirror straight after the snapshot, before anything slow is read', async () => {
    let seenWhilePoliciesRead: any = null;
    steps.whenPoliciesAreRead = () => { seenWhilePoliciesRead = unitRow(); };
    await runHeartbeat(db);

    expect(steps.log).toEqual(['snapshot', 'mirror', 'policies']);
    expect(seenWhilePoliciesRead).toMatchObject({ quota_volume_used: LIVE, quota_tx_used: 36 });
  });

  it('when the brain refuses the mirror, the snapshot stands and the beat goes on', async () => {
    answerBrain({ status: 401, body: { error: 'Unauthorized' } });
    await runHeartbeat(db);

    expect(steps.log).toEqual(['snapshot', 'mirror', 'policies']);
    expect(unitRow()).toMatchObject({ quota_volume_used: SNAPSHOT, quota_tx_used: 35 });
  });
});
