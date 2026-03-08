/**
 * Heartbeat Engine for Lana Pays.Us
 * Runs every 5 minutes: fetches KIND 38888 system params from Nostr relays
 */

import Database from 'better-sqlite3';
import { fetchKind38888, type Kind38888Data } from './lib/nostr.js';

const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // 5 minutes

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
  console.log('Starting heartbeat engine (interval: 5 min)');

  // Run immediately on start
  runHeartbeat(db);

  // Then every 5 minutes
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
