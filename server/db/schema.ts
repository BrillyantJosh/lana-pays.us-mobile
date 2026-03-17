import Database from 'better-sqlite3';

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    -- KIND 38888 system parameters (latest record)
    CREATE TABLE IF NOT EXISTS kind_38888 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      split TEXT,
      exchange_rates TEXT,
      electrum_servers TEXT,
      relays TEXT,
      version TEXT,
      valid_from INTEGER,
      split_target_lana INTEGER,
      split_started_at INTEGER,
      split_ends_at INTEGER,
      raw_event TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Registered users
    CREATE TABLE IF NOT EXISTS users (
      hex_id TEXT PRIMARY KEY,
      npub TEXT NOT NULL,
      lana_address TEXT NOT NULL,
      display_name TEXT,
      picture TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT DEFAULT (datetime('now'))
    );

    -- KIND 30901 Business Units (from Nostr relays)
    CREATE TABLE IF NOT EXISTS business_units (
      unit_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      pubkey TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      name TEXT NOT NULL,
      owner_hex TEXT NOT NULL,
      authorized_hex TEXT NOT NULL DEFAULT '[]',
      receiver_name TEXT,
      receiver_address TEXT,
      receiver_zip TEXT,
      receiver_city TEXT,
      receiver_country TEXT,
      bank_name TEXT,
      bank_swift TEXT,
      bank_account TEXT,
      longitude TEXT,
      latitude TEXT,
      country TEXT,
      currency TEXT,
      category TEXT,
      category_detail TEXT,
      image TEXT,
      logo TEXT,
      status TEXT DEFAULT 'active',
      lanapays_payout_method TEXT DEFAULT 'fiat',
      lanapays_payout_wallet TEXT,
      opening_hours_json TEXT,
      content TEXT,
      raw_event TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Heartbeat logs
    CREATE TABLE IF NOT EXISTS heartbeat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      success INTEGER DEFAULT 0,
      error TEXT
    );
  `);

  console.log('Database schema initialized');
}
