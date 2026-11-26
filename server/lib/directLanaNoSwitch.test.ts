// @vitest-environment node
/**
 * LANA neposredno has no switch (Brilly, 26 Nov 2026: "ne rabim stikala,
 * naredi da povsod dela"). Until then it was behind app_settings
 * direct_lana_units, off by default and written only with the admin's
 * signature. Now every shop without a company takes it (directLana.test.ts
 * shows a whole sale with nothing set anywhere); here: the old setting is gone
 * from every database, cannot be written back, and nothing reads it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initializeSchema } from '../db/schema.js';
import * as unit from './directLanaUnit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const row = (db: Database.Database) => db.prepare("SELECT value FROM app_settings WHERE key = 'direct_lana_units'").get();

describe('the old setting is gone', () => {
  it('a fresh database never has it', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    expect(row(db)).toBeUndefined();
  });

  it('a database that had it, off or on, loses it at the next start', () => {
    for (const value of ['', '*', 'unit-1,unit-2']) {
      const db = new Database(':memory:');
      initializeSchema(db);
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('direct_lana_units', ?)").run(value);
      initializeSchema(db);
      expect(row(db), value).toBeUndefined();
    }
  });

  it('nothing in the code reads it or switches by it', () => {
    expect(Object.keys(unit)).not.toEqual(expect.arrayContaining(['directLanaSwitchedOn']));
    for (const name of ['directLanaSwitchedOn', 'normalizeDirectLanaUnits', 'directSwitchWriteRefusal', 'DIRECT_LANA_SETTING']) {
      expect((unit as Record<string, unknown>)[name], name).toBeUndefined();
    }
    for (const file of ['directLanaUnit.ts', '../directLana.ts', '../index.ts']) {
      const src = fs.readFileSync(path.resolve(here, file), 'utf8');
      expect(src, file).not.toMatch(/DIRECT_LANA_OFF|directLanaSwitchedOn|ignoreSwitch/);
    }
  });
});

describe('the admin route cannot write it back', () => {
  const index = fs.readFileSync(path.resolve(here, '../index.ts'), 'utf8');
  const start = index.indexOf("app.put('/api/admin/settings'");
  const handler = index.slice(start, index.indexOf('\n});', start));

  it('a request that carries it is refused before a single setting is written', () => {
    expect(start).toBeGreaterThan(0);
    const admin = handler.indexOf('requireAdmin(req, res)');
    const refuse = handler.indexOf("hasOwnProperty.call(settings, 'direct_lana_units')");
    const write = handler.indexOf('upsert.run(');
    expect(admin).toBeGreaterThan(0);
    expect(refuse).toBeGreaterThan(admin);
    expect(write).toBeGreaterThan(refuse);
    expect(handler.slice(refuse, write)).toContain("return res.status(400).json({ success: false, code: 'NO_SUCH_SETTING'");
  });
});
