-- A database built by lana-pays.us-mobile origin/main code (fbb2c3d, the last pushed commit, 5 Oct 2026):
-- its initializeSchema, then ingestEvent + resolveOrders of the live-order shape — 1 item at 4.08 EUR,
-- pickup, the order's sale unit 'g' (the listing, republished after the order, says 'kos'), its 30933
-- 'processing', then the merchant's 36521 'rejected'. Synthetic keys only, no buyer data. Dumped with
-- sqlite3 .dump; the seeded defaults (admin_users, app_settings) are left out — initializeSchema seeds
-- them again. The listing as the relays serve it is origin-main-live-order.listing.json.
-- Read by server/orderTerms.test.ts.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE kind_38888 (
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
CREATE TABLE users (
      hex_id TEXT PRIMARY KEY,
      npub TEXT NOT NULL,
      lana_address TEXT NOT NULL,
      display_name TEXT,
      picture TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT DEFAULT (datetime('now'))
    );
CREATE TABLE business_units (
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
    , unit_type TEXT, lana_only INTEGER DEFAULT 0, quota_volume_used REAL DEFAULT 0, quota_volume_limit REAL DEFAULT 0, quota_tx_used INTEGER DEFAULT 0, quota_tx_limit INTEGER DEFAULT 0, quota_currency TEXT DEFAULT '', quota_period TEXT DEFAULT '');
INSERT INTO business_units VALUES('a5f7f91ca45d96e0237813fa8110a1fa','a8d741adec0698883d3ddd999b11eccd97bb515fcb333bb5b533a36c422b4244','a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9',1788168241,'Testna trgovina','a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9','["a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9"]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'EUR',NULL,NULL,NULL,NULL,'active','fiat',NULL,NULL,NULL,'{"kind":30901,"tags":[["d","a5f7f91ca45d96e0237813fa8110a1fa"],["unit_id","a5f7f91ca45d96e0237813fa8110a1fa"],["name","Testna trgovina"],["currency","EUR"],["online_shop","true"],["online_shop_pickup","true"]],"content":"","created_at":1788168241,"pubkey":"a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9","id":"a8d741adec0698883d3ddd999b11eccd97bb515fcb333bb5b533a36c422b4244","sig":"4c995702afe6787c91c6c5ebe38f499685006fe0a70c0a1e9ec3ead3420e31b34c5be3cb1a6b9c257ea972562afe0d823f3ae7285e9ae31252329eb1426e4a56"}','active',NULL,NULL,NULL,'2026-10-05 09:24:01',NULL,0,0.0,0.0,0,0,'','');
CREATE TABLE fee_policies (
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
CREATE TABLE fund_capacity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      currency TEXT NOT NULL,
      total_available REAL DEFAULT 0,
      investor_count INTEGER DEFAULT 0,
      blocked_count INTEGER DEFAULT 0,
      fetched_at TEXT DEFAULT (datetime('now'))
    , max_single_budget REAL DEFAULT 0);
CREATE TABLE heartbeat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      success INTEGER DEFAULT 0,
      error TEXT
    );
CREATE TABLE admin_users (
      hex_id TEXT PRIMARY KEY,
      name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
CREATE TABLE regular_customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id TEXT NOT NULL,
      customer_hex_id TEXT NOT NULL,
      customer_wallet TEXT NOT NULL,
      customer_npub TEXT,
      display_name TEXT,
      picture TEXT,
      added_by_hex TEXT NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')), owner_hex TEXT,
      UNIQUE(unit_id, customer_hex_id)
    );
CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      updated_by TEXT
    );
CREATE TABLE payment_requests (
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
CREATE TABLE shop_orders (
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
INSERT INTO shop_orders VALUES('d98f6843ca4d4f6e625ddbce.c5e610adc4f2f138fd5a2214fef1d1ab','aafd83dcb0a8ff80da1b374c593d00f4a4de8791eaf24217396d1b79321dd2bc','d98f6843ca4d4f6e625ddbce2daa37d44c7d0c95eca7c53250a22bc41569bcf7',1790760241,'a5f7f91ca45d96e0237813fa8110a1fa','a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9','[{"a":"36502:a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9:834390b217ee3c996161760e5b1cb7f7","kind":36502,"qty":1,"saleUnit":"g","unitPrice":"4.08","currency":"EUR"}]','0.00','4.08','EUR','pickup','placed',1790762041,'lanaeco.shop',NULL,'{"kind":36520,"tags":[["d","d98f6843ca4d4f6e625ddbce.c5e610adc4f2f138fd5a2214fef1d1ab"],["a","30901:a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9:a5f7f91ca45d96e0237813fa8110a1fa"],["p","a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9"],["unit_id","a5f7f91ca45d96e0237813fa8110a1fa"],["invoice_number","d98f6843ca4d4f6e625ddbce.c5e610adc4f2f138fd5a2214fef1d1ab"],["item","36502:a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9:834390b217ee3c996161760e5b1cb7f7","1","g","4.08","EUR"],["shipping","0.00","EUR"],["total","4.08","EUR"],["fulfillment","pickup"],["status","placed"],["pay_by","1790762041"],["client","lanaeco.shop"],["v","1"]],"content":"","created_at":1790760241,"pubkey":"d98f6843ca4d4f6e625ddbce2daa37d44c7d0c95eca7c53250a22bc41569bcf7","id":"aafd83dcb0a8ff80da1b374c593d00f4a4de8791eaf24217396d1b79321dd2bc","sig":"7a0d9cc12013ec6ffc5fab89e0a66e51bdd5c5842037c6b93340c78defce2c73edb04e46cddf6456c11de82634baed26cd1f8a3c858b03f5544f56acdac3d5a5"}','paid','4.08',0,'rejected',0,'806ffd58c7d8c7b036741d5226d1a916a1b76360c361160b65adc23cbc9336b3','e42b1f9a-3d3c-4ed9-b442-29675dbd5487','f16971553d8946ac5a0d312379a5d11e63e141d7d862618cf2ed239bc21d9099','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','4.08','1593750000',1790760285,'aafd83dcb0a8ff80da1b374c593d00f4a4de8791eaf24217396d1b79321dd2bc','rejected','172a5c64f4b7871bae72af0889ee967d4d43d0c77bcdb1d94c2098119150db5b','a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9',1790760841,NULL,NULL,1,1790760901,'2026-10-05 09:24:01');
CREATE TABLE shop_order_fulfillments (
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
INSERT INTO shop_order_fulfillments VALUES('d98f6843ca4d4f6e625ddbce.c5e610adc4f2f138fd5a2214fef1d1ab','172a5c64f4b7871bae72af0889ee967d4d43d0c77bcdb1d94c2098119150db5b','a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9',1790760841,'rejected','30933:806ffd58c7d8c7b036741d5226d1a916a1b76360c361160b65adc23cbc9336b3:e42b1f9a-3d3c-4ed9-b442-29675dbd5487',NULL,NULL,NULL,NULL,NULL,'','{"kind":36521,"tags":[["d","d98f6843ca4d4f6e625ddbce.c5e610adc4f2f138fd5a2214fef1d1ab"],["a","36520:d98f6843ca4d4f6e625ddbce2daa37d44c7d0c95eca7c53250a22bc41569bcf7:d98f6843ca4d4f6e625ddbce.c5e610adc4f2f138fd5a2214fef1d1ab"],["a","30901:a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9:a5f7f91ca45d96e0237813fa8110a1fa"],["p","d98f6843ca4d4f6e625ddbce2daa37d44c7d0c95eca7c53250a22bc41569bcf7"],["unit_id","a5f7f91ca45d96e0237813fa8110a1fa"],["status","rejected"],["payment","30933:806ffd58c7d8c7b036741d5226d1a916a1b76360c361160b65adc23cbc9336b3:e42b1f9a-3d3c-4ed9-b442-29675dbd5487"],["v","1"]],"content":"","created_at":1790760841,"pubkey":"a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9","id":"172a5c64f4b7871bae72af0889ee967d4d43d0c77bcdb1d94c2098119150db5b","sig":"255646a7f87bc62994525949920f12ac431c46bb8a2e107397efb265d09cd5967edb1189033870be260a352ed7d1a8284df77c2b4642ac881cb2006cf3a3f91c"}',1,'2026-10-05 09:24:01');
CREATE TABLE shop_order_payments (
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
INSERT INTO shop_order_payments VALUES('806ffd58c7d8c7b036741d5226d1a916a1b76360c361160b65adc23cbc9336b3','e42b1f9a-3d3c-4ed9-b442-29675dbd5487','f16971553d8946ac5a0d312379a5d11e63e141d7d862618cf2ed239bc21d9099',1790760285,'a5f7f91ca45d96e0237813fa8110a1fa','d98f6843ca4d4f6e625ddbce.c5e610adc4f2f138fd5a2214fef1d1ab','Testni izdelek ×1 · 36520:d98f6843ca4d4f6e625ddbce2daa37d44c7d0c95eca7c53250a22bc41569bcf7:d98f6843ca4d4f6e625ddbce.c5e610adc4f2f138fd5a2214fef1d1ab','4.08','EUR','1593750000','lana','processing','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','{"kind":30933,"tags":[["d","e42b1f9a-3d3c-4ed9-b442-29675dbd5487"],["p","ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],["unit_id","a5f7f91ca45d96e0237813fa8110a1fa"],["payment_type","lana"],["customer_hex","ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],["merchant_hex","a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9"],["amount","4.08"],["currency","EUR"],["lana_amount","1593750000"],["status","processing"],["invoice_number","d98f6843ca4d4f6e625ddbce.c5e610adc4f2f138fd5a2214fef1d1ab"],["receipt_description","Testni izdelek ×1 · 36520:d98f6843ca4d4f6e625ddbce2daa37d44c7d0c95eca7c53250a22bc41569bcf7:d98f6843ca4d4f6e625ddbce.c5e610adc4f2f138fd5a2214fef1d1ab"]],"content":"","created_at":1790760285,"pubkey":"806ffd58c7d8c7b036741d5226d1a916a1b76360c361160b65adc23cbc9336b3","id":"f16971553d8946ac5a0d312379a5d11e63e141d7d862618cf2ed239bc21d9099","sig":"a07c1ae898d0d4ec2ac888076e6d708bf6781cead7d30412849252e9111cb8441d323daa8f39021897d7dfc8925f879d7bd8ea40c2d1b36bf5cbf0ab838b0a35"}');
CREATE TABLE shop_order_delivery (
      d TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      recipient_hex TEXT NOT NULL,
      buyer_pubkey TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      raw_event TEXT NOT NULL
    );
CREATE TABLE shop_order_sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
CREATE TABLE shop_order_item_snapshots (
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
INSERT INTO shop_order_item_snapshots VALUES('d98f6843ca4d4f6e625ddbce.c5e610adc4f2f138fd5a2214fef1d1ab','36502:a74090c27ad7814d71e0f35fdbc5a63fe2dba557b75135aae1330ea179e575f9:834390b217ee3c996161760e5b1cb7f7','69e6f3edf546298428de80d6167567f5ded377c1a00f4f790818b8053acf5089',1790673841,'Testni izdelek',NULL,NULL,'g','4.08','EUR','listing',1790760301);
CREATE UNIQUE INDEX idx_regcust_owner_customer
      ON regular_customers(owner_hex, customer_hex_id);
CREATE INDEX idx_payreq_unit_created ON payment_requests(unit_id, created_at DESC);
CREATE INDEX idx_payreq_status ON payment_requests(status);
CREATE INDEX idx_shop_orders_unit_created ON shop_orders(unit_id, created_at DESC);
CREATE INDEX idx_shop_orders_pending ON shop_orders(pending);
CREATE INDEX idx_shop_payments_invoice ON shop_order_payments(unit_id, invoice_number);
CREATE INDEX idx_shop_delivery_order ON shop_order_delivery(order_id, recipient_hex);
COMMIT;
