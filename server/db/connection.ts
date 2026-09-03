import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeSchema } from './schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Dev/test-only escape hatch: point this process at an isolated SQLite file
// (used by lana-shop-devstack so an E2E run never touches your dev data).
// Unset in production -- falls back to the repo's data/ file exactly as before.
const DB_PATH = process.env.LANA_DB_PATH
  ? path.resolve(process.env.LANA_DB_PATH)
  : path.resolve(__dirname, '../../data/lana-pays.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    initializeSchema(db);

    console.log(`SQLite database initialized at ${DB_PATH}`);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined!;
    console.log('SQLite database closed');
  }
}
