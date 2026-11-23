// @vitest-environment node
/**
 * LANA neposredno's switch (app_settings.direct_lana_units): OFF until set, and
 * written only with the admin's own signature.
 *
 * The admin settings route takes the other settings on the admin header alone
 * (a public hex). The switch opens a path that moves money past the brain, so
 * a request that carries it must also carry a NIP-98 token by that same admin,
 * bound to the exact body; otherwise nothing at all is written.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { finalizeEvent } from 'nostr-tools/pure';
import { initializeSchema } from '../db/schema.js';
import { forgetSpentTokens } from './nip98.js';
import { directSwitchWriteRefusal, directLanaSwitchedOn, normalizeDirectLanaUnits } from './directLanaUnit.js';
import { keyOf, hexOfKey } from '../fixtures/directLana.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = keyOf(21);
const ADMIN_HEX = hexOfKey(ADMIN);
const OTHER = keyOf(22);
const PATH = '/api/admin/settings';

function token(key: Uint8Array, body: string | null, over: { method?: string; path?: string } = {}) {
  const tags = [['u', over.path ?? PATH], ['method', over.method ?? 'PUT'], ['nonce', crypto.randomBytes(8).toString('hex')]];
  if (body !== null) tags.push(['payload', crypto.createHash('sha256').update(body).digest('hex')]);
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, key);
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}
const request = (body: string, authorization?: string) =>
  ({ method: 'PUT', originalUrl: PATH, url: PATH, headers: authorization ? { authorization } : {}, rawBody: Buffer.from(body) }) as any;

beforeEach(() => forgetSpentTokens());

describe('who may write the switch', () => {
  const body = JSON.stringify({ settings: { direct_lana_units: 'unit-1' } });

  it('the admin, signing this exact body: allowed', () => {
    expect(directSwitchWriteRefusal(request(body, token(ADMIN, body)), ADMIN_HEX)).toBe(null);
  });

  it('the admin header alone (a public hex): refused, 401 SIGNATURE_REQUIRED', () => {
    const r = directSwitchWriteRefusal(request(body), ADMIN_HEX);
    expect(r?.status).toBe(401);
    expect(r?.body).toMatchObject({ success: false, code: 'SIGNATURE_REQUIRED', reason: 'MISSING' });
  });

  it('a signature by somebody else than the admin the header names: refused, 403', () => {
    const r = directSwitchWriteRefusal(request(body, token(OTHER, body)), ADMIN_HEX);
    expect(r?.status).toBe(403);
    expect(r?.body).toMatchObject({ code: 'NOT_ADMIN' });
  });

  it('a signature for another body, another method or another path: refused', () => {
    const other = JSON.stringify({ settings: { direct_lana_units: '*' } });
    expect(directSwitchWriteRefusal(request(body, token(ADMIN, other)), ADMIN_HEX)?.body).toMatchObject({ reason: 'PAYLOAD_MISMATCH' });
    expect(directSwitchWriteRefusal(request(body, token(ADMIN, body, { method: 'POST' })), ADMIN_HEX)?.body).toMatchObject({ reason: 'METHOD_MISMATCH' });
    expect(directSwitchWriteRefusal(request(body, token(ADMIN, body, { path: '/api/admin/check' })), ADMIN_HEX)?.body).toMatchObject({ reason: 'PATH_MISMATCH' });
    expect(directSwitchWriteRefusal(request(body, token(ADMIN, null)), ADMIN_HEX)?.body).toMatchObject({ reason: 'PAYLOAD_MISSING' });
  });

  it('the same token twice: the second is refused (spent once)', () => {
    const t = token(ADMIN, body);
    expect(directSwitchWriteRefusal(request(body, t), ADMIN_HEX)).toBe(null);
    expect(directSwitchWriteRefusal(request(body, t), ADMIN_HEX)?.body).toMatchObject({ reason: 'REPLAYED' });
  });
});

describe('the admin route asks for it before it writes anything', () => {
  const index = fs.readFileSync(path.resolve(here, '../index.ts'), 'utf8');
  const start = index.indexOf("app.put('/api/admin/settings'");
  const handler = index.slice(start, index.indexOf('\n});', start));

  it('requireAdmin, then the signature for the switch, then the writes', () => {
    expect(start).toBeGreaterThan(0);
    const admin = handler.indexOf('requireAdmin(req, res)');
    const has = handler.indexOf('Object.prototype.hasOwnProperty.call(settings, DIRECT_LANA_SETTING)');
    const check = handler.indexOf('directSwitchWriteRefusal(req, adminHex)');
    const write = handler.indexOf('upsert.run(');
    expect(admin).toBeGreaterThan(0);
    expect(has).toBeGreaterThan(admin);
    expect(check).toBeGreaterThan(has);
    expect(write).toBeGreaterThan(check);
    // A refusal ends the request before a single setting is written.
    expect(handler.slice(check, write)).toContain('if (refused) return res.status(refused.status).json(refused.body);');
  });

  it('what is stored is normalised: off, every shop, or unit ids', () => {
    expect(handler).toContain('stored = normalizeDirectLanaUnits(stored);');
    expect(normalizeDirectLanaUnits('')).toBe('');
    expect(normalizeDirectLanaUnits(' * ')).toBe('*');
    expect(normalizeDirectLanaUnits('a, b,,a ')).toBe('a,b');
    expect(normalizeDirectLanaUnits('a, <script>')).toBe('a');
  });
});

describe('the switch is OFF until it is set', () => {
  it('a fresh database has it off for every shop', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    expect((db.prepare("SELECT value FROM app_settings WHERE key = 'direct_lana_units'").get() as any).value).toBe('');
    expect(directLanaSwitchedOn(db, 'any-unit')).toBe(false);
  });

  it('a database that already has a value keeps it (the default is written only once)', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    db.prepare("UPDATE app_settings SET value = 'unit-1' WHERE key = 'direct_lana_units'").run();
    initializeSchema(db);
    expect(directLanaSwitchedOn(db, 'unit-1')).toBe(true);
    expect(directLanaSwitchedOn(db, 'unit-2')).toBe(false);
  });

  it('no table, or no row: off', () => {
    const bare = new Database(':memory:');
    expect(directLanaSwitchedOn(bare, 'unit-1')).toBe(false);
    bare.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
    expect(directLanaSwitchedOn(bare, 'unit-1')).toBe(false);
  });
});
