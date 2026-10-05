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
      max_cap_lanas_on_split INTEGER DEFAULT 0,
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
  // The deadline shown NEXT to the lock ("cash is blocked until …"), an ISO
  // instant or '' for none. It never unblocks anything — only split_happening
  // does — so a passed deadline simply stops being shown.
  db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('split_happening_until', '')").run();
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


  // ── KIND 30901 author pin (trust on first use) — 5 Oct 2026 ────────────
  // The key that established a business unit. A later 30901 for the same
  // unit_id is taken only from this key (heartbeat.ts syncBusinessUnits,
  // nostr.ts selectKind30901 — lana-brain a0d7cdb, ported).
  //
  // Its own column, and NEVER in the heartbeat's ON CONFLICT … DO UPDATE:
  // that statement rewrites `pubkey` from the incoming event, so a pin on
  // `pubkey` would be an anchor the forger's own write replaces. And not
  // `owner_hex`: that is read from a TAG the signer chooses, so "author ==
  // owner_hex" holds for any forger who simply names himself.
  //
  // Backfilled from the stored pubkey only where no pin exists yet — a pin
  // already set is never rewritten here, on any later boot either.
  try { db.exec(`ALTER TABLE business_units ADD COLUMN author_pin TEXT`); } catch { /* column exists */ }
  try { db.exec(`ALTER TABLE business_units ADD COLUMN author_pin_set_at TEXT`); } catch { /* column exists */ }
  try {
    db.exec(`
      UPDATE business_units SET author_pin = pubkey, author_pin_set_at = datetime('now')
      WHERE (author_pin IS NULL OR author_pin = '') AND pubkey <> ''
    `);
  } catch { /* no column: assertOrdersSchema says so */ }
  // Every move of a pin by a person (server/scripts/unit-author-pin.ts): it
  // is exactly as sensitive as the takeover the pin refuses, so it is kept.
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_unit_pin_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id TEXT NOT NULL,
      previous_pin TEXT,
      new_pin TEXT NOT NULL,
      reason TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

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

  // Migration: KIND 38888 v3 fields (split_approaching + retail wallet freeze threshold + Split cap)
  try { db.exec(`ALTER TABLE kind_38888 ADD COLUMN split_approaching INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE kind_38888 ADD COLUMN freeze_lana_retail_account_above INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE kind_38888 ADD COLUMN max_cap_lanas_on_split INTEGER DEFAULT 0`); } catch {}

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
      -- the 36520 event id (shop_orders.event_id) the 'paid' verdict was
      -- reached for — SPEC §8 step 5a
      paid_order_event_id TEXT,
      -- the 36520 event id a v1.1.2 'paid' verdict was reached for (the
      -- step-5a pin; never filled from an older verdict — schema below)
      settled_order_event_id TEXT,
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

    -- WHAT was ordered, for the merchant's screen. A KIND 36520 v1 item names
    -- only the listing address, qty, sale unit and price — no title, no šifra.
    -- This keeps the merchant-signed listing's display fields as they were
    -- when the buyer ordered (the version closest to the order's created_at
    -- wins; a later edit never overwrites it). DISPLAY ONLY: the resolver
    -- never reads this table. source = 'listing' (signature-verified 36502…,
    -- author = the address pubkey) or 'receipt' (title only, from the paid
    -- 30933 receipt_description, when no listing could be fetched).
    CREATE TABLE IF NOT EXISTS shop_order_item_snapshots (
      order_id TEXT NOT NULL,
      item_a TEXT NOT NULL,
      listing_event_id TEXT,
      listing_created_at INTEGER,
      title TEXT,
      sku TEXT,
      weight TEXT,
      sale_unit TEXT,
      price TEXT,
      currency TEXT,
      source TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (order_id, item_a)
    );
  `);

  // SPEC §8 step 5a: a 'paid' verdict remembers WHICH 36520 event it was
  // reached for, so a later listing or shipping-fee change does not turn a
  // paid order into amount_mismatch (and drop it from the merchant's pending
  // list for good). No fill for old rows: ingestOrder can store a newer
  // 36520 before the next resolve, so only resolveOrders knows which event a
  // verdict belongs to — it fills the column on its next pass (pending orders
  // are resolved on every sync).
  try { db.exec(`ALTER TABLE shop_orders ADD COLUMN paid_order_event_id TEXT`); } catch { /* column exists */ }

  // SPEC v1.1.2 step 5a (third review 2 Oct 2026): the pin is honoured only
  // when THIS code wrote it. paid_order_event_id was also written by the
  // older rules, which priced an item whose listing was not found at the
  // BUYER's own unit_price — so a buyer's replacement naming an unknown
  // listing could be 'paid' and pinned there. settled_order_event_id is
  // written only by a v1.1.2 'paid' verdict (resolveOrders) and is never
  // filled from stored verdicts: every 'paid' row without it is judged again
  // by step 5 (activeOrderIds), and the ones step 5 does not pay are listed
  // in shop_order_settle_review for Brilly instead of being paid.
  try { db.exec(`ALTER TABLE shop_orders ADD COLUMN settled_order_event_id TEXT`); } catch { /* column exists */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_order_settle_review (
      order_id TEXT PRIMARY KEY,
      order_event_id TEXT,
      old_paid_tx_id TEXT,
      old_paid_amount TEXT,
      verdict TEXT NOT NULL,
      expected_total TEXT,
      listed_at INTEGER NOT NULL,
      cleared_at INTEGER
    );
  `);
  // Round 3 (2 Oct 2026): when Brilly confirmed an entry as honest
  // (orderSync.confirmSettleReview — the purchase it was paid with became
  // the step-5a pin of exactly that 36520 event). NULL = cleared by a later
  // step-5 'paid', or still open.
  try { db.exec(`ALTER TABLE shop_order_settle_review ADD COLUMN confirmed_at INTEGER`); } catch { /* column exists */ }

  // SPEC v1.1.2 step 2: the last MERCHANT-signed price this app saw for a
  // listing while judging one exact 36520 event — keyed by that event's id,
  // never by the order id: a buyer's replacement is another event and starts
  // with no prices. An honest order whose listing is deleted (or whose
  // listing REQ fails) after it was judged once is still priced by what the
  // merchant asked; a listing a buyer names in a replacement never priced
  // that replacement, so it stays unknown. MONEY input (unlike
  // shop_order_item_snapshots, which is display only).
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_order_listing_prices (
      order_event_id TEXT NOT NULL,
      item_a TEXT NOT NULL,
      price TEXT NOT NULL,
      listing_created_at INTEGER NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (order_event_id, item_a)
    );
  `);
  // Round 5 (F3/F4): shop_order_listing_prices above is no longer read or
  // written — a price remembered per item, apart from the shipping fee and
  // pickup it was judged with, paid a cart the merchant never priced as a
  // whole. Kept (not dropped): no destructive migration.

  // Round 5 (F3/F4): the merchant's terms under which ONE 36520 event was
  // exactly right — every item's listing on sale at the price the order
  // names, the shop's shipping fee, free-shipping threshold and pickup, and
  // the order's total to the cent. Written once (ON CONFLICT DO NOTHING) by
  // orderSync judgeRow, only when all of that held at the moment it was
  // judged, and keyed by the event id: a buyer's replacement is another event
  // and starts with none. An order the current terms do not pay (the merchant
  // raised a price, the fee, or turned pickup off before the 30933 arrived)
  // is judged once more by these. MONEY input.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_order_terms_seen (
      order_event_id TEXT PRIMARY KEY,
      shipping_fee TEXT NOT NULL,
      free_from TEXT,
      pickup INTEGER NOT NULL,
      unit_event_id TEXT,
      prices_json TEXT NOT NULL,
      total TEXT NOT NULL,
      seen_at INTEGER NOT NULL
    );
  `);

  // Round 5 (F1): the newest version of each listing address this app has
  // seen (NIP-01 order: later created_at, then lower id), and whether its
  // author deleted it (NIP-09, by `e` or `a`). A relay that serves an older
  // version — after the merchant deleted the newer one by event id only, or
  // because someone re-broadcast it — never prices an order again
  // (orderSync makeListingFetcher), as the broker's listing_versions holds it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_listing_versions (
      address TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);

  // Round 5: why an entry is open — 'legacy_paid' (a 'paid' of the older
  // rules that step 5 does not pay; NULL on rows listed before this column),
  // 'terms_mismatch' or 'not_computable' (a verified payment of exactly the
  // order's total that the merchant's terms do not reach).
  try { db.exec(`ALTER TABLE shop_order_settle_review ADD COLUMN reason TEXT`); } catch { /* column exists */ }

  // Last: say out loud whether the orders tables are what this code needs.
  // Every ALTER above swallows its error, so without this a failed
  // migration is silent until an order is judged on a missing column.
  assertOrdersSchema(db);

  console.log('Database schema initialized');
}

/**
 * Written into shop_order_sync_state (key 'schema') once a database has
 * passed assertOrdersSchema with this code: which rule set last checked it.
 */
export const ORDERS_SCHEMA_MARKER = 'v1.1.2-r5';

/**
 * Every table and column the Lana Online Shop order code reads or writes
 * (orderSync.ts, orders.ts, heartbeat.ts syncBusinessUnits). Kept by hand:
 * order code that starts using a new column or table adds it here, with the
 * migration that creates it.
 */
export const ORDERS_SCHEMA_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  business_units: [
    'unit_id', 'event_id', 'pubkey', 'created_at', 'name', 'owner_hex', 'authorized_hex', 'currency', 'status',
    'raw_event', 'unit_type', 'lana_only', 'author_pin', 'author_pin_set_at',
  ],
  shop_orders: [
    'order_id', 'event_id', 'buyer_pubkey', 'created_at', 'unit_id', 'unit_owner_hex', 'items_json', 'shipping', 'total',
    'currency', 'fulfillment', 'order_status', 'pay_by', 'client', 'supersedes', 'raw_event', 'payment_state',
    'expected_total', 'price_changed', 'effective_status', 'pending', 'paid_signer_hex', 'paid_tx_id', 'paid_event_id',
    'paid_customer_hex', 'paid_amount', 'paid_lana_amount', 'paid_at', 'paid_order_event_id', 'settled_order_event_id',
    'fulfillment_status', 'fulfillment_event_id', 'fulfillment_pubkey', 'fulfillment_created_at', 'fulfillment_carrier',
    'fulfillment_tracking', 'fulfillment_published', 'resolved_at', 'updated_at',
  ],
  shop_order_fulfillments: [
    'order_id', 'event_id', 'pubkey', 'created_at', 'status', 'payment_ref', 'carrier', 'tracking', 'shipped_at',
    'delivered_at', 'eta', 'content', 'raw_event', 'published', 'updated_at',
  ],
  shop_order_payments: [
    'pubkey', 'tx_id', 'event_id', 'created_at', 'unit_id', 'invoice_number', 'receipt_description', 'amount', 'currency',
    'lana_amount', 'payment_type', 'status', 'customer_hex', 'raw_event',
  ],
  shop_order_delivery: ['d', 'order_id', 'recipient_hex', 'buyer_pubkey', 'unit_id', 'event_id', 'created_at', 'raw_event'],
  shop_order_sync_state: ['key', 'value', 'updated_at'],
  shop_order_item_snapshots: [
    'order_id', 'item_a', 'listing_event_id', 'listing_created_at', 'title', 'sku', 'weight', 'sale_unit', 'price',
    'currency', 'source', 'fetched_at',
  ],
  shop_order_settle_review: [
    'order_id', 'order_event_id', 'old_paid_tx_id', 'old_paid_amount', 'verdict', 'expected_total', 'listed_at',
    'cleared_at', 'confirmed_at', 'reason',
  ],
  shop_order_terms_seen: [
    'order_event_id', 'shipping_fee', 'free_from', 'pickup', 'unit_event_id', 'prices_json', 'total', 'seen_at',
  ],
  shop_listing_versions: ['address', 'event_id', 'created_at', 'deleted', 'updated_at'],
};

export interface OrdersSchemaStatus {
  ok: boolean;
  /** `table` or `table.column` this code needs and the database lacks */
  missing: string[];
  /** shop_order_sync_state 'schema' after the check (null when unreadable) */
  marker: string | null;
  checkedAt: string;
}

const ordersSchemaByDb = new WeakMap<Database.Database, OrdersSchemaStatus>();

/**
 * Check, with PRAGMA table_info, that every table and column in
 * ORDERS_SCHEMA_REQUIRED exists. On success the marker
 * ORDERS_SCHEMA_MARKER is written (only when it changes — a second boot
 * writes nothing). On failure: an ERROR line naming what is missing, and
 * ordersSchemaOk(db) = false — the order sync is skipped and the order
 * routes answer 503 ORDERS_UNAVAILABLE. It never throws: this app is also
 * the merchant's till, which must keep working without the orders.
 */
export function assertOrdersSchema(db: Database.Database): OrdersSchemaStatus {
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(ORDERS_SCHEMA_REQUIRED)) {
    let have: Set<string>;
    try {
      have = new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name));
    } catch {
      have = new Set();
    }
    if (have.size === 0) { missing.push(table); continue; }
    for (const c of columns) if (!have.has(c)) missing.push(`${table}.${c}`);
  }
  let marker: string | null = null;
  if (missing.length === 0) {
    try {
      db.prepare(`
        INSERT INTO shop_order_sync_state (key, value, updated_at) VALUES ('schema', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        WHERE shop_order_sync_state.value IS NOT excluded.value
      `).run(ORDERS_SCHEMA_MARKER);
    } catch (e: any) {
      missing.push(`shop_order_sync_state (marker not written: ${e?.message || e})`);
    }
  }
  try {
    marker = (db.prepare("SELECT value FROM shop_order_sync_state WHERE key = 'schema'").get() as any)?.value ?? null;
  } catch { marker = null; }
  const status: OrdersSchemaStatus = { ok: missing.length === 0, missing, marker, checkedAt: new Date().toISOString() };
  ordersSchemaByDb.set(db, status);
  if (!status.ok) {
    console.error(
      `[orders] ERROR orders schema is NOT what this code needs — missing: ${missing.join(', ')}. ` +
      'Orders are NOT synced and the order routes answer 503 ORDERS_UNAVAILABLE until a restart finds it complete; the till works as before.'
    );
  }
  return status;
}

/** The last assertOrdersSchema result for this database (checked now if it never was). */
export function ordersSchemaStatus(db: Database.Database): OrdersSchemaStatus {
  return ordersSchemaByDb.get(db) ?? assertOrdersSchema(db);
}

/** May the order code touch this database? (ordersSchemaOk = false ⇒ no.) */
export function ordersSchemaOk(db: Database.Database): boolean {
  return ordersSchemaStatus(db).ok;
}
