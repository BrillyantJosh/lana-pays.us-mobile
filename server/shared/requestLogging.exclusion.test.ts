// @vitest-environment node
/**
 * GET /api/request-logs — the second admin gate nobody knew about.
 *
 * This endpoint hands out the 24h breadcrumb trail of every person who used the
 * till: method, path, status, duration and client IP for every request. It was
 * authorised by a HARDCODED hex compared inline, with no exclusion check of any
 * kind, so while /api/admin/settings and /api/admin/check both answered
 * 403 PERSON_EXCLUDED to that same key, this one answered 200 with the lot —
 * and did it for three different carriers (`x-admin-hex`, `x-admin-hex-id` and
 * `?admin_hex=`), none of them checked.
 *
 * exclusionWiring.test.ts's "no hardcoded 64-hex literal" assertion reads only
 * the gate's own source, so it stayed green the whole time this stood.
 *
 * NOBODY IS EXEMPT. These tests fail the moment the gate is taken off again, or
 * the moment a fourth carrier is added and left unasked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { installRequestLogging } from './requestLogging.js';
import { ensureExclusionTables, mergeReports, type Report } from '../lib/personExclusion.js';

/** The root admin the endpoint hardcodes — and one of the standing 87058 subjects. */
const ROOT = '56e8670aa65491f8595dc3a71c94aa7445dcdca755ca5f77c07218498a362061';
const SOMEBODY_ELSE = 'dededededededededededededededededededededededededededededededede';

const standing = (personHex: string): Report => ({
  dTag: 'v-root', personHex, ground: 'the stated ground', since: 1700000000,
  untilSplit: null, eventId: 'ev1', active: true, eventCreatedAt: 1700000000,
});

let db: Database.Database;
let server: Server;
let base: string;

beforeAll(async () => {
  db = new Database(':memory:');
  ensureExclusionTables(db);
  const app = express();
  installRequestLogging(app, db);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
});

const clearDecisions = () => db.prepare('DELETE FROM person_exclusions').run();

describe('the root admin is not above a commission decision', () => {
  it('answers the root admin while no decision stands — the endpoint still works', async () => {
    clearDecisions();
    const res = await fetch(`${base}/api/request-logs?limit=3`, { headers: { 'x-admin-hex': ROOT } });
    expect(res.status).toBe(200);
    expect((await res.json()).logs).toBeInstanceOf(Array);
  });

  it('refuses the root admin the moment a decision stands against them', async () => {
    clearDecisions();
    mergeReports(db, [standing(ROOT)]);
    const res = await fetch(`${base}/api/request-logs?limit=3`, { headers: { 'x-admin-hex': ROOT } });
    expect(res.status, 'the hardcoded hex authorised an excluded person').toBe(403);
    expect((await res.json()).code).toBe('PERSON_EXCLUDED');
  });

  it('refuses through EVERY carrier, not just the one the comparison reads first', async () => {
    clearDecisions();
    mergeReports(db, [standing(ROOT)]);
    for (const attempt of [
      { label: 'x-admin-hex', init: { headers: { 'x-admin-hex': ROOT } }, path: '/api/request-logs' },
      { label: 'x-admin-hex-id', init: { headers: { 'x-admin-hex-id': ROOT } }, path: '/api/request-logs' },
      { label: '?admin_hex=', init: {}, path: `/api/request-logs?admin_hex=${ROOT}` },
    ]) {
      const res = await fetch(`${base}${attempt.path}`, attempt.init as any);
      expect(res.status, `${attempt.label} still walked past the gate`).toBe(403);
      expect((await res.json()).code, attempt.label).toBe('PERSON_EXCLUDED');
    }
  });

  it('a decoy in one carrier does not carry an excluded name in another', async () => {
    clearDecisions();
    mergeReports(db, [standing(ROOT)]);
    const res = await fetch(`${base}/api/request-logs?admin_hex=${ROOT}`, {
      headers: { 'x-admin-hex': SOMEBODY_ELSE },
    });
    expect(res.status, 'filling a clean field hid the excluded one').toBe(403);
  });

  it('a padded hex does not walk past it either', async () => {
    clearDecisions();
    mergeReports(db, [standing(ROOT)]);
    const res = await fetch(`${base}/api/request-logs`, { headers: { 'x-admin-hex': ` ${ROOT.toUpperCase()} ` } });
    expect(res.status).toBe(403);
  });

  it('still refuses everyone who is not the root admin, exclusion or not', async () => {
    clearDecisions();
    const res = await fetch(`${base}/api/request-logs`, { headers: { 'x-admin-hex': SOMEBODY_ELSE } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });
});
