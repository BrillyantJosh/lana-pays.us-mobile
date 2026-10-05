// @vitest-environment node
/**
 * Round 5 (5 Oct 2026): a migration that fails must be seen.
 *
 * Every ALTER in initializeSchema swallows its error ("column exists"), so a
 * migration that really failed was silent until an order was judged on a
 * column that is not there. assertOrdersSchema, run last, checks every table
 * and column the order code needs. On failure: an ERROR line, the order sync
 * is skipped, the order routes answer 503 ORDERS_UNAVAILABLE and /health
 * says orders_schema — and nothing crashes: this app is also the merchant's
 * till. On success it writes the marker 'v1.1.2-r5'; a second boot is a
 * no-op.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Before any import reads it: a code path that falls back to the built-in
// relay list must find a dead loopback relay, never the production ones.
vi.hoisted(() => { process.env.LANA_RELAYS_OVERRIDE = 'ws://127.0.0.1:9'; });

import Database from 'better-sqlite3';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AddressInfo } from 'net';
import * as schema from './schema.js';
import { registerOrderRoutes } from '../orders.js';
import * as orderSync from '../lib/orderSync.js';
import * as heartbeat from '../heartbeat.js';

const { initializeSchema } = schema;
const s = schema as any;
const here = path.dirname(fileURLToPath(import.meta.url));

/** Everything a boot could change: the schema itself, every row count, and the marker row as stored. */
function snapshot(db: Database.Database) {
  const master = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all() as any[];
  const tables = master.filter(m => m.type === 'table' && !m.name.startsWith('sqlite_')).map(m => m.name);
  const counts = Object.fromEntries(tables.map(t => [t, (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as any).n]));
  const marker = db.prepare("SELECT * FROM shop_order_sync_state WHERE key = 'schema'").get() ?? null;
  return { master, counts, marker };
}

/** A database whose migrations ran with every ALTER naming `column` failing, as a full disk or a lock would make it. */
function dbWithFailingAlter(column: string, dropFirst?: string): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  if (dropFirst) db.exec(dropFirst);
  const realExec = db.exec.bind(db);
  (db as any).exec = (sql: string) => {
    if (new RegExp(`ADD COLUMN ${column}\\b`).test(sql)) throw new Error('database or disk is full');
    return realExec(sql);
  };
  return db;
}

describe('initializeSchema', () => {
  it('twice is a no-op, and the first run leaves the marker v1.1.2-r5', () => {
    const db = new Database(':memory:');
    try {
      initializeSchema(db);
      db.prepare(`INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex) VALUES (?, 'e', ?, 1, 'x', ?)`)
        .run('1'.repeat(32), 'a'.repeat(64), 'a'.repeat(64));
      initializeSchema(db); // the boot after the first sync: backfills the pin
      expect(db.prepare('SELECT author_pin FROM business_units').get()).toEqual({ author_pin: 'a'.repeat(64) });
      expect((db.prepare("SELECT value FROM shop_order_sync_state WHERE key = 'schema'").get() as any)?.value).toBe('v1.1.2-r5');
      expect(s.ORDERS_SCHEMA_MARKER).toBe('v1.1.2-r5');

      const before = snapshot(db);
      const changes = (db.prepare('SELECT total_changes() AS n').get() as any).n;
      initializeSchema(db);
      expect((db.prepare('SELECT total_changes() AS n').get() as any).n).toBe(changes);
      expect(snapshot(db)).toEqual(before);
      expect(s.ordersSchemaOk(db)).toBe(true);
    } finally { db.close(); }
  });

  it('never rewrites a pin that exists, whatever the stored author says now', () => {
    const db = new Database(':memory:');
    try {
      initializeSchema(db);
      db.prepare(`INSERT INTO business_units (unit_id, event_id, pubkey, created_at, name, owner_hex, author_pin) VALUES (?, 'e', ?, 1, 'x', ?, ?)`)
        .run('1'.repeat(32), 'b'.repeat(64), 'b'.repeat(64), 'a'.repeat(64));
      initializeSchema(db);
      expect(db.prepare('SELECT author_pin, pubkey FROM business_units').get()).toEqual({ author_pin: 'a'.repeat(64), pubkey: 'b'.repeat(64) });
    } finally { db.close(); }
  });
});

describe('a migration that fails is seen', () => {
  let db: Database.Database;
  let httpServer: any;
  let base = '';
  let threw: unknown = null;
  const errors: string[] = [];

  beforeAll(async () => {
    // shop_orders as an older version left it — without settled_order_event_id —
    // and the ALTER that should add it failing.
    db = dbWithFailingAlter('settled_order_event_id', 'ALTER TABLE shop_orders DROP COLUMN settled_order_event_id');
    const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    try { initializeSchema(db); } catch (e) { threw = e; } finally { err.mockRestore(); }
    const app = express();
    app.use(express.json());
    registerOrderRoutes(app, db);
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => httpServer.once('listening', r));
    base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(r => httpServer.close(() => r()));
    db.close();
  });

  it('the boot does not crash (the till must keep working) and logs an ERROR naming the missing column', () => {
    expect(threw).toBeNull();
    expect(errors.some(e => e.includes('ERROR orders schema') && e.includes('shop_orders.settled_order_event_id'))).toBe(true);
  });

  it('orders_schema reports the failure, naming the missing column', () => {
    expect(s.ordersSchemaOk(db)).toBe(false);
    const st = s.ordersSchemaStatus(db);
    expect(st.ok).toBe(false);
    expect(st.missing).toContain('shop_orders.settled_order_event_id');
  });

  it('every order route answers 503 ORDERS_UNAVAILABLE', async () => {
    const hex = 'a'.repeat(64);
    for (const [method, p] of [
      ['GET', `/api/orders/pending-count?hex=${hex}`], ['GET', `/api/orders?hex=${hex}`],
      ['GET', `/api/orders/${'a'.repeat(24)}.${'b'.repeat(32)}?hex=${hex}`], ['POST', `/api/orders/${'a'.repeat(24)}.${'b'.repeat(32)}/fulfillment`],
    ]) {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ hex, event: {} }) : undefined });
      expect(r.status, `${method} ${p}`).toBe(503);
      expect((await r.json() as any).error).toBe('ORDERS_UNAVAILABLE');
    }
  });

  it('the order sync is skipped, and asks no relay anything', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const stats = await orderSync.syncShopOrders(db, ['ws://127.0.0.1:9']);
      expect(stats.skipped).toBe('orders_schema');
      expect(stats.relays).toBe(0);
    } finally { err.mockRestore(); }
  });

  it('/health carries orders_schema', () => {
    const indexTs = fs.readFileSync(path.join(here, '..', 'index.ts'), 'utf8');
    const start = indexTs.indexOf("app.get('/health'");
    const handler = indexTs.slice(start, indexTs.indexOf('\n});', start));
    expect(start).toBeGreaterThan(0);
    expect(handler).toContain('ordersSchemaStatus(db)');
    expect(handler).toMatch(/orders_schema: \{ ok: orders\.ok, marker: orders\.marker, missing: orders\.missing \}/);
  });
});

describe('a missing author_pin column', () => {
  it('fails the orders check, and the unit sync writes nothing rather than run unpinned', async () => {
    const db = dbWithFailingAlter('author_pin', 'ALTER TABLE business_units DROP COLUMN author_pin');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      initializeSchema(db);
      expect(s.ordersSchemaStatus(db).missing).toContain('business_units.author_pin');
      expect(await (heartbeat as any).syncBusinessUnits(db, ['ws://127.0.0.1:9'])).toBe(0);
      expect(err.mock.calls.some(c => String(c[0]).includes('no author_pin column'))).toBe(true);
    } finally { err.mockRestore(); db.close(); }
  });
});
