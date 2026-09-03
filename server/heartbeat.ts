/**
 * Heartbeat Engine for Lana Pays.Us
 * Runs every 1 minute: fetches KIND 38888, KIND 30901, and registers new users
 */

import Database from 'better-sqlite3';
import { bech32 } from 'bech32';
import { fetchKind38888, fetchKind30901, fetchKind30902, fetchKind30903, fetchKind0Profile, type Kind38888Data, type Kind30901Event, type Kind30902Policy } from './lib/nostr.js';
import { readUnitOrigin } from './lib/unitOrigin.js';
import { syncShopOrders } from './lib/orderSync.js';

const HEARTBEAT_INTERVAL = 1 * 60 * 1000; // 1 minute

function hexToNpub(hexPubKey: string): string {
  const data = Buffer.from(hexPubKey, 'hex');
  const words = bech32.toWords(data);
  return bech32.encode('npub', words);
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let heartbeatStartedAt = 0;

const MAX_HEARTBEAT_DURATION = 120_000; // 2 minutes safety timeout

export async function runHeartbeat(db: Database.Database): Promise<void> {
  if (isRunning) {
    const elapsed = Date.now() - heartbeatStartedAt;
    if (elapsed > MAX_HEARTBEAT_DURATION) {
      console.warn(`Heartbeat stuck for ${Math.round(elapsed / 1000)}s — force resetting lock`);
      isRunning = false;
    } else {
      console.log('Heartbeat already running, skipping');
      return;
    }
  }

  isRunning = true;
  heartbeatStartedAt = Date.now();
  const logId = db.prepare(
    "INSERT INTO heartbeat_logs (started_at) VALUES (datetime('now'))"
  ).run().lastInsertRowid;

  console.log('Heartbeat started');

  try {
    const systemParams = await fetchKind38888();

    if (!systemParams) {
      throw new Error('Failed to fetch KIND 38888 system parameters');
    }

    // Store KIND 38888 — only insert a new row when the event actually changed.
    // Otherwise we'd append a ~92KB raw_event blob every tick and bloat the DB.
    const latest38888 = db.prepare(
      'SELECT id, event_id FROM kind_38888 ORDER BY id DESC LIMIT 1'
    ).get() as { id: number; event_id: string } | undefined;

    if (latest38888 && latest38888.event_id === systemParams.event_id) {
      // Same event — refresh the structured v3 columns (cheap, same row → no blob bloat)
      // so newly-parsed fields populate without waiting for the next event change.
      db.prepare(
        "UPDATE kind_38888 SET split_approaching = ?, freeze_lana_retail_account_above = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(systemParams.split_approaching ? 1 : 0, systemParams.freeze_lana_retail_account_above || 0, latest38888.id);
      console.log(`[sync] KIND 38888 unchanged (${systemParams.event_id.slice(0, 12)}…), refreshed v3 columns`);
    } else {
      db.prepare(`
        INSERT INTO kind_38888 (event_id, split, exchange_rates, electrum_servers, relays, version, valid_from, split_target_lana, split_started_at, split_ends_at, split_approaching, freeze_lana_retail_account_above, raw_event, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        systemParams.event_id,
        systemParams.split,
        JSON.stringify(systemParams.exchange_rates),
        JSON.stringify(systemParams.electrum_servers),
        JSON.stringify(systemParams.relays),
        systemParams.version,
        systemParams.valid_from,
        systemParams.split_target_lana || 0,
        systemParams.split_started_at || 0,
        systemParams.split_ends_at || 0,
        systemParams.split_approaching ? 1 : 0,
        systemParams.freeze_lana_retail_account_above || 0,
        systemParams.raw_event
      );
      console.log(`[sync] KIND 38888 changed → inserted new row (${systemParams.event_id.slice(0, 12)}…)`);
    }

    console.log(`KIND 38888: split=${systemParams.split}, EUR=${systemParams.exchange_rates.EUR}, USD=${systemParams.exchange_rates.USD}, GBP=${systemParams.exchange_rates.GBP}`);

    // Fetch KIND 30901 Business Units (always full — NIP-33 replaceable, small result set)
    const businessUnits = await fetchKind30901(undefined, systemParams.relays);

    if (businessUnits.length > 0) {
      const upsert = db.prepare(`
        INSERT INTO business_units (
          unit_id, event_id, pubkey, created_at, name, owner_hex, authorized_hex,
          receiver_name, receiver_address, receiver_zip, receiver_city, receiver_country,
          bank_name, bank_swift, bank_account, longitude, latitude,
          country, currency, category, category_detail, image, logo,
          status, lanapays_payout_method, lanapays_payout_wallet,
          opening_hours_json, content, raw_event, unit_type, lana_only, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(unit_id) DO UPDATE SET
          event_id = excluded.event_id,
          pubkey = excluded.pubkey,
          created_at = excluded.created_at,
          name = excluded.name,
          owner_hex = excluded.owner_hex,
          authorized_hex = excluded.authorized_hex,
          receiver_name = excluded.receiver_name,
          receiver_address = excluded.receiver_address,
          receiver_zip = excluded.receiver_zip,
          receiver_city = excluded.receiver_city,
          receiver_country = excluded.receiver_country,
          bank_name = excluded.bank_name,
          bank_swift = excluded.bank_swift,
          bank_account = excluded.bank_account,
          longitude = excluded.longitude,
          latitude = excluded.latitude,
          country = excluded.country,
          currency = excluded.currency,
          category = excluded.category,
          category_detail = excluded.category_detail,
          image = excluded.image,
          logo = excluded.logo,
          status = excluded.status,
          lanapays_payout_method = excluded.lanapays_payout_method,
          lanapays_payout_wallet = excluded.lanapays_payout_wallet,
          opening_hours_json = excluded.opening_hours_json,
          content = excluded.content,
          raw_event = excluded.raw_event,
          -- Sticky on purpose: shop's own edit form emits neither marker, so a
          -- merchant editing a simple.lanapays.us shop there would otherwise
          -- publish a replacement that quietly moves it into this app.
          unit_type = COALESCE(excluded.unit_type, business_units.unit_type),
          lana_only = MAX(excluded.lana_only, business_units.lana_only),
          updated_at = datetime('now')
      `);

      const insertMany = db.transaction((units: Kind30901Event[]) => {
        for (const u of units) {
          const origin = readUnitOrigin(u.raw_event);
          upsert.run(
            u.unit_id, u.event_id, u.pubkey, u.created_at, u.name, u.owner_hex,
            JSON.stringify(u.authorized_hex),
            u.receiver_name, u.receiver_address, u.receiver_zip, u.receiver_city, u.receiver_country,
            u.bank_name, u.bank_swift, u.bank_account, u.longitude, u.latitude,
            u.country, u.currency, u.category, u.category_detail, u.image, u.logo,
            u.status, u.lanapays_payout_method, u.lanapays_payout_wallet,
            u.opening_hours_json, u.content, u.raw_event,
            origin.unitType, origin.lanaOnly ? 1 : 0
          );
        }
      });

      insertMany(businessUnits);
      console.log(`KIND 30901: upserted ${businessUnits.length} business units`);
    }

    // Fetch KIND 30903 — Merchant Registration Gateway status & quota
    const suspensions = await fetchKind30903(systemParams.relays);
    const now = Math.floor(Date.now() / 1000);

    // Reset gateway state to 'active' baseline; events below override per unit.
    // Units with no KIND 30903 stay 'active' (legacy / pre-gateway merchants).
    db.prepare(`UPDATE business_units SET
      suspension_status = 'active',
      suspension_reason = NULL,
      suspension_until = NULL,
      suspension_content = NULL,
      quota_volume_used = 0,
      quota_volume_limit = 0,
      quota_tx_used = 0,
      quota_tx_limit = 0,
      quota_currency = '',
      quota_period = ''`).run();

    const NEW_STATUSES = new Set(['pending', 'active', 'quota_warning_80', 'quota_blocked', 'suspended', 'rejected']);

    for (const s of suspensions) {
      // Only apply if the unit exists in our DB
      const unit = db.prepare('SELECT unit_id FROM business_units WHERE unit_id = ?').get(s.unit_id) as any;
      if (!unit) continue;

      let effectiveStatus = s.status;
      if (s.status === 'suspended' && s.active_until && s.active_until < now) {
        // Legacy time-bound suspension expired — unit is active again
        effectiveStatus = 'active';
      }

      // Persist gateway status (overloaded onto suspension_status column) + quota fields.
      const knownStatus = NEW_STATUSES.has(effectiveStatus) ? effectiveStatus : 'active';

      db.prepare(`
        UPDATE business_units SET
          suspension_status = ?,
          suspension_reason = ?,
          suspension_until = ?,
          suspension_content = ?,
          quota_volume_used = ?,
          quota_volume_limit = ?,
          quota_tx_used = ?,
          quota_tx_limit = ?,
          quota_currency = ?,
          quota_period = ?
        WHERE unit_id = ?
      `).run(
        knownStatus,
        s.reason,
        s.active_until || null,
        s.content,
        s.quota_volume_used ?? 0,
        s.quota_volume_limit ?? 0,
        s.quota_tx_used ?? 0,
        s.quota_tx_limit ?? 0,
        s.quota_currency ?? '',
        s.quota_period ?? '',
        s.unit_id,
      );

      if (knownStatus !== 'active') {
        console.log(`KIND 30903: ${knownStatus} unit ${s.unit_id.slice(0, 12)}… reason: ${s.reason.slice(0, 50)}`);
      }
    }

    // Fetch KIND 30902 fee policies (includes max_tx_amount)
    const feePolicies = await fetchKind30902(systemParams.relays);

    if (feePolicies.length > 0) {
      const upsertPolicy = db.prepare(`
        INSERT INTO fee_policies (unit_id, event_id, pubkey, created_at, lana_discount_per, lanapays_us_per, max_tx_amount, max_tx_currency, caretaker_hex, caretaker_wallet, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(unit_id) DO UPDATE SET
          event_id = excluded.event_id,
          pubkey = excluded.pubkey,
          created_at = excluded.created_at,
          lana_discount_per = excluded.lana_discount_per,
          lanapays_us_per = excluded.lanapays_us_per,
          max_tx_amount = excluded.max_tx_amount,
          max_tx_currency = excluded.max_tx_currency,
          caretaker_hex = excluded.caretaker_hex,
          caretaker_wallet = excluded.caretaker_wallet,
          status = excluded.status,
          updated_at = datetime('now')
      `);

      const insertPolicies = db.transaction((policies: Kind30902Policy[]) => {
        for (const p of policies) {
          upsertPolicy.run(
            p.unit_id, p.event_id, p.pubkey, p.created_at,
            p.lana_discount_per, p.lanapays_us_per, p.max_tx_amount, p.max_tx_currency,
            p.caretaker_hex, p.caretaker_wallet, p.status
          );
        }
      });

      insertPolicies(feePolicies);
      console.log(`KIND 30902: upserted ${feePolicies.length} fee policies`);
    }

    // ── Sync merchant_quota_usage from brain ────────────────────────────
    // Brain owns the canonical write (orchestrator increments on every
    // successful purchase). Mobile pulls a snapshot here so the staff sees
    // current usage right away, not just on the next status transition.
    // Updates only the *_used columns; *_limit + status come from KIND 30903.
    try {
      const BRAIN_URL = process.env.BRAIN_API_URL || 'http://lana-brain-web:3007';
      const adminHex = '56e8670aa65491f8595dc3a71c94aa7445dcdca755ca5f77c07218498a362061';
      const period = new Date().toISOString().slice(0, 7);
      const usageRes = await fetch(`${BRAIN_URL}/api/admin/merchant-usage?period=${period}`, {
        headers: { 'x-admin-hex-id': adminHex },
        signal: AbortSignal.timeout(5000),
      });
      if (usageRes.ok) {
        const data = await usageRes.json();
        const rows = (data.usage || []) as Array<{
          unit_id: string; tx_count: number; volume_native: number;
          tx_count_cash?: number; volume_native_cash?: number;
        }>;
        const upd = db.prepare(`
          UPDATE business_units SET
            quota_volume_used = ?,
            quota_tx_used = ?,
            quota_period = ?
          WHERE unit_id = ?
        `);
        // The monthly limit is CASH-only (LANA is uncapped), so the POS gates on
        // CASH usage — mirror the *_cash counters into quota_*_used (fall back to
        // 0 for an older brain that doesn't yet return the cash columns).
        const txn = db.transaction(() => {
          for (const r of rows) upd.run(r.volume_native_cash ?? 0, r.tx_count_cash ?? 0, period, r.unit_id);
        });
        txn();
        console.log(`merchant_quota_usage: synced ${rows.length} usage rows from brain`);
      } else {
        console.warn(`merchant-usage fetch returned HTTP ${usageRes.status}`);
      }
    } catch (e: any) {
      console.warn('merchant_quota_usage sync failed (non-fatal):', e.message);
    }

    // Fetch Direct Fund capacity
    const DIRECT_FUND_URL = process.env.DIRECT_FUND_URL || 'http://lana-direct-fund-web:3005';
    const currencies = ['EUR', 'USD', 'GBP'];

    for (const cur of currencies) {
      try {
        const capRes = await fetch(`${DIRECT_FUND_URL}/api/capacity?currency=${cur}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (capRes.ok) {
          const capData = await capRes.json();
          db.prepare(`
            INSERT INTO fund_capacity (currency, total_available, max_single_budget, investor_count, blocked_count, fetched_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
          `).run(cur, capData.total_available || 0, capData.max_single_budget || 0, capData.investor_count || 0, capData.blocked_count || 0);
          console.log(`Direct Fund capacity (${cur}): ${capData.total_available} available, max single: ${capData.max_single_budget}, ${capData.investor_count} investors`);
        }
      } catch (e: any) {
        console.warn(`Failed to fetch Direct Fund capacity for ${cur}:`, e.message);
      }
    }

    // Discover and register new users from business unit p tags
    const allUnits = db.prepare('SELECT authorized_hex FROM business_units WHERE status = ?').all('active') as any[];
    const allHexIds = new Set<string>();
    for (const row of allUnits) {
      try {
        const ids: string[] = JSON.parse(row.authorized_hex || '[]');
        ids.forEach(id => allHexIds.add(id));
      } catch {}
    }

    // Find hex IDs not yet in users table
    const existingUsers = new Set(
      (db.prepare('SELECT hex_id FROM users').all() as any[]).map(r => r.hex_id)
    );
    const newHexIds = [...allHexIds].filter(id => !existingUsers.has(id));

    if (newHexIds.length > 0) {
      console.log(`Registering ${newHexIds.length} new user(s) from KIND 30901 p tags...`);

      for (const hexId of newHexIds) {
        try {
          const profile = await fetchKind0Profile(hexId);
          const npub = hexToNpub(hexId);

          db.prepare(`
            INSERT INTO users (hex_id, npub, lana_address, display_name, picture, last_login)
            VALUES (?, ?, '', ?, ?, datetime('now'))
            ON CONFLICT(hex_id) DO UPDATE SET
              display_name = COALESCE(excluded.display_name, users.display_name),
              picture = COALESCE(excluded.picture, users.picture),
              last_login = datetime('now')
          `).run(
            hexId,
            npub,
            profile?.name || profile?.display_name || null,
            profile?.picture || null
          );

          console.log(`Registered user ${hexId.slice(0, 12)}... (${profile?.name || profile?.display_name || 'no profile'})`);
        } catch (e: any) {
          console.warn(`Failed to register user ${hexId.slice(0, 12)}...:`, e.message);
        }
      }
    }

    // ── Lana-online payment-request sweeps ──────────────────────────────
    // 1) Expire overdue pending requests (lazy expiry also happens on read;
    //    this keeps statuses fresh even when nobody is looking).
    const expired = db.prepare(`
      UPDATE payment_requests SET status = 'expired'
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')
    `).run();
    if (expired.changes > 0) console.log(`[lana-online] Expired ${expired.changes} overdue payment request(s)`);
    // 2) Watchdog: a request stuck in 'paying' for >10 min means the submit
    //    died mid-flight. Re-opening it is SAFE ONLY because the brain's
    //    (unit_id, invoice_number) dedup converts any true replay into an
    //    "already paid" self-heal at the next submit (paymentRequests.ts).
    const stuck = db.prepare(`
      UPDATE payment_requests SET status = 'pending', paying_started_at = NULL,
        last_error = 'paying watchdog reset', last_error_at = datetime('now')
      WHERE status = 'paying' AND paying_started_at < datetime('now', '-10 minutes')
    `).run();
    if (stuck.changes > 0) console.warn(`[lana-online] WATCHDOG re-opened ${stuck.changes} stuck 'paying' request(s) — check brain for orphaned payments`);

    // ── Lana Online Shop orders (36520/36521/36522 + trusted 30933) ─────
    // Non-fatal: a relay hiccup must not fail the whole heartbeat.
    try {
      await syncShopOrders(db, systemParams.relays);
    } catch (e: any) {
      console.warn('[orders] sync failed (non-fatal):', e.message);
    }

    // Update heartbeat log
    db.prepare(`
      UPDATE heartbeat_logs SET
        completed_at = datetime('now'),
        success = 1
      WHERE id = ?
    `).run(logId);

    console.log('Heartbeat completed successfully');

  } catch (error: any) {
    console.error('Heartbeat failed:', error);

    db.prepare(`
      UPDATE heartbeat_logs SET
        completed_at = datetime('now'),
        success = 0,
        error = ?
      WHERE id = ?
    `).run(error.message || String(error), logId);
  } finally {
    isRunning = false;
  }
}

export function startHeartbeat(db: Database.Database): void {
  console.log('Starting heartbeat engine (interval: 1 min)');

  // Run immediately on start
  runHeartbeat(db);

  // Then every 1 minute
  heartbeatTimer = setInterval(() => {
    runHeartbeat(db);
  }, HEARTBEAT_INTERVAL);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log('Heartbeat stopped');
  }
}
