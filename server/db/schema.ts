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
      split_approaching INTEGER DEFAULT 0,
      freeze_lana_retail_account_above INTEGER DEFAULT 0,
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
      suspension_status TEXT DEFAULT 'active',
      suspension_reason TEXT,
      suspension_until INTEGER,
      suspension_content TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- KIND 30902 Fee Policies (from Nostr relays)
    CREATE TABLE IF NOT EXISTS fee_policies (
      unit_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      pubkey TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      lana_discount_per TEXT DEFAULT '5.00',
      lanapays_us_per TEXT DEFAULT '5.00',
      max_tx_amount TEXT DEFAULT '',
      max_tx_currency TEXT DEFAULT '',
      caretaker_hex TEXT,
      caretaker_wallet TEXT,
      status TEXT DEFAULT 'active',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Direct Fund capacity cache
    CREATE TABLE IF NOT EXISTS fund_capacity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      currency TEXT NOT NULL,
      total_available REAL DEFAULT 0,
      investor_count INTEGER DEFAULT 0,
      blocked_count INTEGER DEFAULT 0,
      fetched_at TEXT DEFAULT (datetime('now'))
    );

    -- Heartbeat logs
    CREATE TABLE IF NOT EXISTS heartbeat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      success INTEGER DEFAULT 0,
      error TEXT
    );

    -- Admin users
    CREATE TABLE IF NOT EXISTS admin_users (
      hex_id TEXT PRIMARY KEY,
      name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Regular customers — shared per OWNER (merchant) across all their shops.
    -- (Legacy UNIQUE(unit_id, customer_hex_id) kept; owner scope enforced by the
    --  idx_regcust_owner_customer unique index added in the migration below.)
    CREATE TABLE IF NOT EXISTS regular_customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id TEXT NOT NULL,
      customer_hex_id TEXT NOT NULL,
      customer_wallet TEXT NOT NULL,
      customer_npub TEXT,
      display_name TEXT,
      picture TEXT,
      added_by_hex TEXT NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(unit_id, customer_hex_id)
    );

    -- App settings (key-value store)
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      updated_by TEXT
    );
  `);

  // ── Migration: regular customers are shared per OWNER (merchant), not per unit ──
  // Add owner_hex, backfill from business_units, dedupe to one row per
  // (owner_hex, customer_hex_id), and enforce it with a unique index. Fully
  // idempotent — safe to run on every boot (late-synced units fill in then).
  try { db.exec(`ALTER TABLE regular_customers ADD COLUMN owner_hex TEXT`); } catch { /* column exists */ }
  db.exec(`
    UPDATE regular_customers
       SET owner_hex = (SELECT bu.owner_hex FROM business_units bu WHERE bu.unit_id = regular_customers.unit_id)
     WHERE owner_hex IS NULL;

    DELETE FROM regular_customers
     WHERE owner_hex IS NOT NULL
       AND id NOT IN (
         SELECT MAX(id) FROM regular_customers
          WHERE owner_hex IS NOT NULL
          GROUP BY owner_hex, customer_hex_id
       );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_regcust_owner_customer
      ON regular_customers(owner_hex, customer_hex_id);
  `);

  // Seed admin user if table is empty
  const adminCount = (db.prepare('SELECT COUNT(*) as c FROM admin_users').get() as any).c;
  if (adminCount === 0) {
    db.prepare('INSERT INTO admin_users (hex_id, name) VALUES (?, ?)').run(
      '56e8670aa65491f8595dc3a71c94aa7445dcdca755ca5f77c07218498a362061', 'Brilly(ant) Josh'
    );
    console.log('Seeded admin user');
  }

  // Seed default settings if table is empty
  const settingsCount = (db.prepare('SELECT COUNT(*) as c FROM app_settings').get() as any).c;
  if (settingsCount === 0) {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('default_max_tx_amount', '0')").run();
    console.log('Seeded default app settings');
  }
  // Split-in-progress lock flag (admin-toggled). Idempotent so it also lands on
  // already-seeded DBs; INSERT OR IGNORE never clobbers an existing value.
  db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('split_happening', 'false')").run();
  // Per-customer rolling cash-window length in days (admin-adjustable): the
  // same customer's CASH purchases at one shop within this many days must not
  // exceed the shop's transaction limit. Cash only — LANA is never limited.
  db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('customer_window_days', '1')").run();

  // Migrations: add suspension columns if missing
  const cols = db.pragma('table_info(business_units)') as any[];
  const colNames = cols.map((c: any) => c.name);
  if (!colNames.includes('suspension_status')) {
    db.exec(`ALTER TABLE business_units ADD COLUMN suspension_status TEXT DEFAULT 'active'`);
    db.exec(`ALTER TABLE business_units ADD COLUMN suspension_reason TEXT`);
    db.exec(`ALTER TABLE business_units ADD COLUMN suspension_until INTEGER`);
    db.exec(`ALTER TABLE business_units ADD COLUMN suspension_content TEXT`);
    console.log('Migrated: added suspension columns to business_units');
  }

  // Migration: which app a unit was registered through. A card can own units

  // from here and from simple.lanapays.us at once, and each app must list only

  // its own — see server/lib/unitOrigin.ts.

  const originCols = db.pragma('table_info(business_units)') as any[];

  if (originCols.length > 0 && !originCols.some((c: any) => c.name === 'unit_type')) {

    db.exec(`ALTER TABLE business_units ADD COLUMN unit_type TEXT`);

    db.exec(`ALTER TABLE business_units ADD COLUMN lana_only INTEGER DEFAULT 0`);

    db.exec(`

      UPDATE business_units

      SET unit_type = 'simple.lanapays.us', lana_only = 1

      WHERE raw_event LIKE '%"unit_type","simple.lanapays.us"%'

         OR raw_event LIKE '%"lana_only","true"%'

    `);

    const marked = db.prepare(`SELECT COUNT(*) AS n FROM business_units WHERE lana_only = 1`).get() as { n: number };

    console.log(`Migrated: added unit_type/lana_only to business_units (${marked.n} belong to simple.lanapays.us)`);

  }


  // Migration: add max_single_budget to fund_capacity
  const fcCols = db.pragma('table_info(fund_capacity)') as any[];
  if (fcCols.length > 0 && !fcCols.some((c: any) => c.name === 'max_single_budget')) {
    db.exec(`ALTER TABLE fund_capacity ADD COLUMN max_single_budget REAL DEFAULT 0`);
    console.log('Migrated: added max_single_budget to fund_capacity');
  }

  // Migration: add max_tx_currency column to fee_policies if missing
  const fpCols = db.pragma('table_info(fee_policies)') as any[];
  if (fpCols.length > 0 && !fpCols.some((c: any) => c.name === 'max_tx_currency')) {
    db.exec(`ALTER TABLE fee_policies ADD COLUMN max_tx_currency TEXT DEFAULT ''`);
    console.log('Migrated: added max_tx_currency to fee_policies');
  }

  // Migration: Merchant Registration Gateway quota columns on business_units.
  // The existing suspension_status / suspension_reason columns hold the gateway
  // status string (now extended to include pending|quota_warning_80|quota_blocked|rejected).
  const buCols = db.pragma('table_info(business_units)') as any[];
  const buColNames = buCols.map((c: any) => c.name);
  if (!buColNames.includes('quota_volume_used')) {
    db.exec(`ALTER TABLE business_units ADD COLUMN quota_volume_used REAL DEFAULT 0`);
    db.exec(`ALTER TABLE business_units ADD COLUMN quota_volume_limit REAL DEFAULT 0`);
    db.exec(`ALTER TABLE business_units ADD COLUMN quota_tx_used INTEGER DEFAULT 0`);
    db.exec(`ALTER TABLE business_units ADD COLUMN quota_tx_limit INTEGER DEFAULT 0`);
    db.exec(`ALTER TABLE business_units ADD COLUMN quota_currency TEXT DEFAULT ''`);
    db.exec(`ALTER TABLE business_units ADD COLUMN quota_period TEXT DEFAULT ''`);
    console.log('Migrated: added gateway quota columns to business_units');
  }

  // Migration: KIND 38888 v3 fields (split_approaching + retail wallet freeze threshold)
  try { db.exec(`ALTER TABLE kind_38888 ADD COLUMN split_approaching INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE kind_38888 ADD COLUMN freeze_lana_retail_account_above INTEGER DEFAULT 0`); } catch {}

  // ── Lana-online payment requests ──────────────────────────────────────────
  // A merchant-created remote payment request. Stored in FIAT ONLY — the LANA
  // amount is computed by the brain AT PAYMENT TIME from the then-current
  // KIND 38888 rate (a split may republish new fx rates between creation and
  // payment). The paid_* columns are a post-payment snapshot for history
  // display, never an input to the money flow.
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_requests (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      unit_id TEXT NOT NULL,
      merchant_hex TEXT NOT NULL,
      unit_name TEXT NOT NULL,
      amount_fiat REAL NOT NULL,
      currency TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      receipt_url TEXT,
      receipt_hash TEXT,
      receipt_type TEXT,
      receipt_description TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','paying','paid','cancelled','expired')),
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT,
      paying_started_at TEXT,
      paid_at TEXT,
      brain_transaction_id TEXT,
      tx_hash TEXT,
      paid_lana_lanoshis INTEGER,
      paid_exchange_rate REAL,
      paid_split TEXT,
      customer_hex TEXT,
      customer_wallet TEXT,
      customer_name TEXT,
      preview_json TEXT,
      preview_at TEXT,
      last_error TEXT,
      last_error_at TEXT,
      seen_by_merchant INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_payreq_unit_created ON payment_requests(unit_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payreq_status ON payment_requests(status);
  `);
  // Default validity of a payment request link: 168h = 7 days (0 = never expires).
  db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('payment_request_expiry_hours', '168')").run();

  // ── Lana Online Shop orders (KIND 36520/36521/36522 + 30933 mirror) ───────
  // Relay mirror for the merchant's "Orders" button. NO PII anywhere in here:
  // the buyer's name/address exist only as NIP-44 ciphertext inside the raw
  // 36522 event (shop_order_delivery.raw_event) and are decrypted in the
  // merchant's browser. Money truth is the brain-signed 30933 mirrored in
  // shop_order_payments; the payment_state/pending columns on shop_orders are
  // the resolver's output (server/lib/orderResolver.ts), recomputed on sync.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_orders (
      order_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      buyer_pubkey TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      unit_id TEXT NOT NULL,
      unit_owner_hex TEXT NOT NULL,
      items_json TEXT NOT NULL,
      shipping TEXT NOT NULL,
      total TEXT NOT NULL,
      currency TEXT NOT NULL,
      fulfillment TEXT NOT NULL,
      order_status TEXT NOT NULL,
      pay_by INTEGER NOT NULL,
      client TEXT,
      supersedes TEXT,
      raw_event TEXT NOT NULL,
      payment_state TEXT NOT NULL DEFAULT 'unpaid',
      expected_total TEXT,
      price_changed INTEGER NOT NULL DEFAULT 0,
      effective_status TEXT NOT NULL DEFAULT 'unpaid',
      pending INTEGER NOT NULL DEFAULT 0,
      paid_signer_hex TEXT,
      paid_tx_id TEXT,
      paid_event_id TEXT,
      paid_customer_hex TEXT,
      paid_amount TEXT,
      paid_lana_amount TEXT,
      paid_at INTEGER,
      fulfillment_status TEXT,
      fulfillment_event_id TEXT,
      fulfillment_pubkey TEXT,
      fulfillment_created_at INTEGER,
      fulfillment_carrier TEXT,
      fulfillment_tracking TEXT,
      fulfillment_published INTEGER NOT NULL DEFAULT 1,
      resolved_at INTEGER,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_shop_orders_unit_created ON shop_orders(unit_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shop_orders_pending ON shop_orders(pending);

    -- Latest KIND 36521 per order (NIP-33 newest created_at wins). published=0
    -- marks a fulfillment signed in THIS app that no relay has accepted yet;
    -- the heartbeat republishes it.
    CREATE TABLE IF NOT EXISTS shop_order_fulfillments (
      order_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      pubkey TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      payment_ref TEXT,
      carrier TEXT,
      tracking TEXT,
      shipped_at TEXT,
      delivered_at TEXT,
      eta TEXT,
      content TEXT,
      raw_event TEXT NOT NULL,
      published INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- KIND 30933 mirror, trusted signers only, shop orders only (invoice_number
    -- has the order-id shape). Newest per (signer, tx id) wins.
    CREATE TABLE IF NOT EXISTS shop_order_payments (
      pubkey TEXT NOT NULL,
      tx_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      unit_id TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      receipt_description TEXT,
      amount TEXT,
      currency TEXT,
      lana_amount TEXT,
      payment_type TEXT,
      status TEXT,
      customer_hex TEXT,
      raw_event TEXT NOT NULL,
      PRIMARY KEY (pubkey, tx_id)
    );
    CREATE INDEX IF NOT EXISTS idx_shop_payments_invoice ON shop_order_payments(unit_id, invoice_number);

    -- KIND 36522 delivery details: CIPHERTEXT ONLY (the raw event, NIP-44 in
    -- content). Never decrypted, never parsed beyond its tags, on this server.
    CREATE TABLE IF NOT EXISTS shop_order_delivery (
      d TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      recipient_hex TEXT NOT NULL,
      buyer_pubkey TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      raw_event TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shop_delivery_order ON shop_order_delivery(order_id, recipient_hex);

    -- Relay since-cursors + tick counter for the order sync.
    CREATE TABLE IF NOT EXISTS shop_order_sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  console.log('Database schema initialized');
}
