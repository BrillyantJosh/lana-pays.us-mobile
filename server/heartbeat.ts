/**
 * Heartbeat Engine for Lana Pays.Us
 * Runs every 1 minute: fetches KIND 38888, KIND 30901, and registers new users
 */

import Database from 'better-sqlite3';
import { bech32 } from 'bech32';
import { fetchKind38888, fetchKind30901, fetchKind0Profile, type Kind38888Data, type Kind30901Event } from './lib/nostr.js';

const HEARTBEAT_INTERVAL = 1 * 60 * 1000; // 1 minute

function hexToNpub(hexPubKey: string): string {
  const data = Buffer.from(hexPubKey, 'hex');
  const words = bech32.toWords(data);
  return bech32.encode('npub', words);
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

export async function runHeartbeat(db: Database.Database): Promise<void> {
  if (isRunning) {
    console.log('Heartbeat already running, skipping');
    return;
  }

  isRunning = true;
  const logId = db.prepare(
    "INSERT INTO heartbeat_logs (started_at) VALUES (datetime('now'))"
  ).run().lastInsertRowid;

  console.log('Heartbeat started');

  try {
    const systemParams = await fetchKind38888();

    if (!systemParams) {
      throw new Error('Failed to fetch KIND 38888 system parameters');
    }

    // Store KIND 38888
    db.prepare(`
      INSERT INTO kind_38888 (event_id, split, exchange_rates, electrum_servers, relays, version, valid_from, split_target_lana, split_started_at, split_ends_at, raw_event, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
      systemParams.raw_event
    );

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
          opening_hours_json, content, raw_event, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
          updated_at = datetime('now')
      `);

      const insertMany = db.transaction((units: Kind30901Event[]) => {
        for (const u of units) {
          upsert.run(
            u.unit_id, u.event_id, u.pubkey, u.created_at, u.name, u.owner_hex,
            JSON.stringify(u.authorized_hex),
            u.receiver_name, u.receiver_address, u.receiver_zip, u.receiver_city, u.receiver_country,
            u.bank_name, u.bank_swift, u.bank_account, u.longitude, u.latitude,
            u.country, u.currency, u.category, u.category_detail, u.image, u.logo,
            u.status, u.lanapays_payout_method, u.lanapays_payout_wallet,
            u.opening_hours_json, u.content, u.raw_event
          );
        }
      });

      insertMany(businessUnits);
      console.log(`KIND 30901: upserted ${businessUnits.length} business units`);
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
            profile?.display_name || profile?.name || null,
            profile?.picture || null
          );

          console.log(`Registered user ${hexId.slice(0, 12)}... (${profile?.display_name || profile?.name || 'no profile'})`);
        } catch (e: any) {
          console.warn(`Failed to register user ${hexId.slice(0, 12)}...:`, e.message);
        }
      }
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
