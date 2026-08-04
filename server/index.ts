/**
 * Lana Pays.Us — Express Server
 * Port 3005 | Heartbeat every 5 min | SQLite persistence
 */

import 'dotenv/config';
import express from 'express';
import { installRequestLogging } from './shared/requestLogging.js';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { getDb, closeDb } from './db/connection.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { fetchSingleBalance, electrumCall, type ElectrumServer } from './lib/electrum.js';
import { fetchKind0Profile, fetchKind0Full, broadcastEvent, SUPPORTED_LANGUAGES } from './lib/nostr.js';
import { fetchDmEvents, publishToRelays as publishDmToRelays } from './lib/dm.js';
import { registerPaymentRequestRoutes } from './paymentRequests.js';
import { getMaxTransaction, foldQuotaRemaining, clampCashAmount, round2 } from './lib/maxTransaction.js';

const LANA_RELAYS = [
  'wss://relay.lanavault.space',
  'wss://relay.lanacoin-eternity.com',
];
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '3005');

// Trust proxy (behind nginx-proxy)
app.set('trust proxy', 1);

// Body size limit
app.use(express.json({ limit: '50kb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // CORS
  const allowedOrigins = ['https://mobile.lanapays.us', 'http://localhost:8080', 'http://localhost:5173'];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});

// Initialize database
const db = getDb();

// ─── Request logging + 24h retention ──────────────────────
// Breadcrumb trail of every request path, to debug stuck flows. Stores
// method/path/status/duration/ip ONLY — never bodies (may hold WIF/secrets).
// Skips static assets; auto-purges rows older than 24h; viewable by root admin.
// Registered BEFORE the rate limiter so 429 (Too Many Requests) responses ARE logged.
installRequestLogging(app, db);

// Rate limiting — 1500/15min per IP (raised from 1000 so an active merchant session
// polling + purchasing can't exhaust the budget → 429).
const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1500, standardHeaders: true, legacyHeaders: false });
const purchaseLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.use(globalLimiter);

// ─── API Routes ────────────────────────────────────────

/**
 * Health check
 */
app.get('/health', (req, res) => {
  const lastHeartbeat = db.prepare(
    'SELECT * FROM heartbeat_logs ORDER BY id DESC LIMIT 1'
  ).get() as any;

  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any)?.count || 0;

  res.json({
    status: 'ok',
    service: 'lana-pays-mobile',
    port: PORT,
    lastHeartbeat: lastHeartbeat ? {
      startedAt: lastHeartbeat.started_at,
      completedAt: lastHeartbeat.completed_at,
      success: lastHeartbeat.success === 1,
      error: lastHeartbeat.error,
    } : null,
    userCount,
  });
});

/**
 * System parameters (KIND 38888)
 */
app.get('/api/system-params', (req, res) => {
  const row = db.prepare(
    'SELECT * FROM kind_38888 ORDER BY id DESC LIMIT 1'
  ).get() as any;

  // Split-in-progress lock — an admin-toggled app_settings flag (mobile-only),
  // independent of KIND 38888. Surfaced here so the POS reads it on its existing
  // /api/system-params poll. Always included (even when no kind_38888 row yet).
  const shRow = db.prepare("SELECT value FROM app_settings WHERE key = 'split_happening'").get() as any;
  const splitHappening = shRow?.value === 'true';

  if (!row) {
    return res.json({ data: { splitHappening } });
  }

  res.json({
    data: {
      eventId: row.event_id,
      split: row.split,
      exchangeRates: JSON.parse(row.exchange_rates || '{}'),
      electrumServers: JSON.parse(row.electrum_servers || '[]'),
      relays: JSON.parse(row.relays || '[]'),
      version: row.version,
      validFrom: row.valid_from,
      splitTargetLana: row.split_target_lana,
      splitStartedAt: row.split_started_at,
      splitEndsAt: row.split_ends_at,
      splitApproaching: row.split_approaching === 1,
      freezeLanaRetailAccountAbove: row.freeze_lana_retail_account_above,
      splitHappening,
      updatedAt: row.updated_at,
    },
  });
});

/**
 * Check balance for a single wallet address via Electrum
 */
app.get('/api/balance/:address', async (req, res) => {
  const { address } = req.params;

  // Get Electrum servers from cached KIND 38888
  const sysRow = db.prepare(
    'SELECT electrum_servers, exchange_rates FROM kind_38888 ORDER BY id DESC LIMIT 1'
  ).get() as any;

  if (!sysRow) {
    return res.status(503).json({ error: 'System parameters not yet available. Please wait for heartbeat.' });
  }

  const electrumServers: ElectrumServer[] = JSON.parse(sysRow.electrum_servers || '[]')
    .map((s: any) => ({ host: s.host, port: parseInt(s.port) }));

  if (electrumServers.length === 0) {
    return res.status(503).json({ error: 'No Electrum servers available' });
  }

  const exchangeRates = JSON.parse(sysRow.exchange_rates || '{}');
  const currency = (req.query.currency as string || 'GBP').toUpperCase();
  const rate = exchangeRates[currency] || exchangeRates.GBP || 0;

  try {
    const result = await fetchSingleBalance(electrumServers, address);

    res.json({
      address,
      confirmed: result.confirmed,
      unconfirmed: result.unconfirmed,
      lana: result.balance,
      fiatValue: Math.round(result.balance * rate * 100) / 100,
      rate,
      currency,
      status: result.status,
    });
  } catch (error: any) {
    console.error('[mobile-server]', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── LANA Transaction Helpers (for client-side signing) ─
//
// These two endpoints are used by the mobile client to build & sign
// LANA transactions locally (so the customer's WIF never leaves the
// device). Mobile fetches UTXOs and raw txs here, then signs in-browser
// and sends the signed_tx_hex to Brain.

function getElectrumServersOrFail(res: express.Response): ElectrumServer[] | null {
  const sysRow = db.prepare('SELECT electrum_servers FROM kind_38888 ORDER BY id DESC LIMIT 1').get() as any;
  if (!sysRow) {
    res.status(503).json({ error: 'System parameters not yet available' });
    return null;
  }
  const servers: ElectrumServer[] = JSON.parse(sysRow.electrum_servers || '[]')
    .map((s: any) => ({ host: s.host, port: parseInt(s.port) }));
  if (servers.length === 0) {
    res.status(503).json({ error: 'No Electrum servers configured' });
    return null;
  }
  return servers;
}

/**
 * GET /api/lana-utxos/:address
 * Returns the list of UTXOs for a LanaCoin address (for client-side signing).
 */
app.get('/api/lana-utxos/:address', async (req, res) => {
  const { address } = req.params;
  if (!/^L[a-zA-Z0-9]{25,34}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid LanaCoin address format' });
  }
  const servers = getElectrumServersOrFail(res);
  if (!servers) return;

  try {
    const utxos = await electrumCall('blockchain.address.listunspent', [address], servers, 15000);
    res.json({ address, utxos: Array.isArray(utxos) ? utxos : [] });
  } catch (err: any) {
    console.error(`[mobile] UTXO fetch failed for ${address}:`, err.message);
    res.status(502).json({ error: 'Failed to fetch UTXOs from Electrum' });
  }
});

/**
 * GET /api/lana-raw-tx/:hash
 * Returns the raw transaction hex for a given txid. Used by client-side signing
 * to extract scriptPubKey of the inputs being spent.
 */
app.get('/api/lana-raw-tx/:hash', async (req, res) => {
  const { hash } = req.params;
  if (!/^[a-fA-F0-9]{64}$/.test(hash)) {
    return res.status(400).json({ error: 'Invalid tx hash format' });
  }
  const servers = getElectrumServersOrFail(res);
  if (!servers) return;

  try {
    const rawTxHex = await electrumCall('blockchain.transaction.get', [hash, false], servers, 15000);
    if (typeof rawTxHex !== 'string' || !/^[a-fA-F0-9]+$/.test(rawTxHex)) {
      return res.status(502).json({ error: 'Electrum returned non-hex response' });
    }
    res.json({ hash, raw: rawTxHex });
  } catch (err: any) {
    console.error(`[mobile] Raw TX fetch failed for ${hash}:`, err.message);
    res.status(502).json({ error: 'Failed to fetch raw transaction from Electrum' });
  }
});

/**
 * Register/update user
 */
app.post('/api/users', (req, res) => {
  const { hex_id, npub, lana_address, display_name, picture } = req.body;

  if (!hex_id || !npub || !lana_address) {
    return res.status(400).json({ error: 'Missing required fields: hex_id, npub, lana_address' });
  }

  db.prepare(`
    INSERT INTO users (hex_id, npub, lana_address, display_name, picture, last_login)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(hex_id) DO UPDATE SET
      npub = excluded.npub,
      lana_address = excluded.lana_address,
      display_name = excluded.display_name,
      picture = excluded.picture,
      last_login = datetime('now')
  `).run(hex_id, npub, lana_address, display_name || null, picture || null);

  const user = db.prepare('SELECT * FROM users WHERE hex_id = ?').get(hex_id);

  res.json({ user });
});

/**
 * Look up Nostr KIND 0 profile by hex pubkey
 */
app.post('/api/profile-lookup', async (req, res) => {
  const { hex_id } = req.body;

  if (!hex_id) {
    return res.status(400).json({ error: 'Missing required field: hex_id' });
  }

  try {
    const profile = await fetchKind0Profile(hex_id);
    res.json({ profile });
  } catch (error: any) {
    console.error(`Profile lookup failed for ${hex_id}:`, error.message);
    res.json({ profile: null });
  }
});

/**
 * Check if wallet is registered via Lana Register API
 * Uses simple_check_wallet_registration (read-only)
 */
const walletCheckLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.post('/api/check-wallet', walletCheckLimiter, async (req, res) => {
  const { wallet_id } = req.body;

  if (!wallet_id) {
    return res.status(400).json({ error: 'Missing required field: wallet_id' });
  }

  const apiKey = process.env.LANA_REGISTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Lana Register API key not configured' });
  }

  try {
    const response = await fetch('https://laluxmwarlejdwyboudz.supabase.co/functions/v1/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'simple_check_wallet_registration',
        api_key: apiKey,
        data: { wallet_id },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || 'API request failed' });
    }

    res.json(data);
  } catch (error: any) {
    console.error('Wallet check failed:', error.message);
    res.status(500).json({ error: 'Failed to check wallet registration' });
  }
});

/**
 * Register a wallet via Supabase check_wallet method
 * Auto-registers virgin (balance=0) wallets and broadcasts Nostr events
 */
app.post('/api/register/wallet', walletCheckLimiter, async (req, res) => {
  const { wallet_id, nostr_id_hex } = req.body;

  if (!wallet_id || typeof wallet_id !== 'string') {
    return res.status(400).json({ error: 'wallet_id is required' });
  }
  if (!/^L[a-zA-Z0-9]{25,34}$/.test(wallet_id)) {
    return res.status(400).json({ error: 'Invalid wallet address format' });
  }
  if (nostr_id_hex && (typeof nostr_id_hex !== 'string' || !/^[a-f0-9]{64}$/.test(nostr_id_hex))) {
    return res.status(400).json({ error: 'Invalid nostr_id_hex format' });
  }

  const apiKey = process.env.LANA_REGISTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Registration service not configured' });
  }

  try {
    const requestBody: any = {
      method: 'check_wallet',
      api_key: apiKey,
      data: { wallet_id }
    };
    if (nostr_id_hex) requestBody.data.nostr_id_hex = nostr_id_hex;

    console.log(`[mobile] Registering wallet ${wallet_id}${nostr_id_hex ? ` with nostr ${nostr_id_hex.slice(0, 8)}...` : ''}`);

    const response = await fetch('https://laluxmwarlejdwyboudz.supabase.co/functions/v1/register-virgin-wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Wallet registration failed:', response.status, data);
      return res.status(response.status).json({ error: data.message || 'Registration failed' });
    }

    console.log(`[mobile] Registration result for ${wallet_id}: ${data.status} - ${data.message}`);
    res.json(data);
  } catch (error: any) {
    console.error('Wallet registration error:', error.message);
    res.status(500).json({ error: 'Failed to register wallet' });
  }
});

/**
 * Get user by hex_id
 */
app.get('/api/users/:hexId', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE hex_id = ?').get(req.params.hexId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({ user });
});

/**
 * Look up user by wallet address (lana_address)
 */
app.get('/api/users/by-wallet/:address', (req, res) => {
  const user = db.prepare('SELECT hex_id, npub, display_name, picture FROM users WHERE lana_address = ?').get(req.params.address) as any;
  res.json({ user: user || null });
});

/**
 * Get business units where the given hex pubkey is authorized (owner or staff via p tags)
 */
app.get('/api/business-units/:hexId', (req, res) => {
  const { hexId } = req.params;

  // Query units where owner_hex matches OR hexId is in the authorized_hex JSON array.
  // suspension_status now carries the Merchant Registration Gateway status:
  //   pending|active|quota_warning_80|quota_blocked|suspended|rejected
  // Quota fields are populated from KIND 30903 by the heartbeat.
  const units = db.prepare(`
    SELECT unit_id, name, owner_hex, authorized_hex, category, category_detail,
           currency, country, image, logo, status, receiver_city,
           lanapays_payout_method, suspension_status, suspension_reason,
           suspension_until, suspension_content,
           quota_volume_used, quota_volume_limit, quota_tx_used, quota_tx_limit,
           quota_currency, quota_period, updated_at,
           bank_account, raw_event
    FROM business_units
    WHERE status = 'active'
      AND (owner_hex = ? OR authorized_hex LIKE ?)
    ORDER BY name ASC
  `).all(hexId, `%${hexId}%`) as any[];

  // Filter the LIKE results to ensure exact hex match in JSON array
  const filtered = units.filter(u => {
    if (u.owner_hex === hexId) return true;
    try {
      const authList: string[] = JSON.parse(u.authorized_hex || '[]');
      return authList.includes(hexId);
    } catch {
      return false;
    }
  });

  // Whether the merchant has entered payout data (IBAN/account). A LANA purchase
  // wires the merchant invoice to their bank (brain orchestrator merchant_payment
  // destination_type='bank'); with no IBAN it cannot be paid out — so the mobile
  // greys out "Pay with LANA". Cash needs no bank, so it stays enabled.
  // The IBAN lives in the KIND 30901 `payment_scheme_fields` tag (modern), with the
  // legacy `bank_account` column as a fallback. Read it from raw_event so no schema
  // change / re-ingestion is needed; the raw IBAN is never returned to the client.
  const hasPayout = (u: any): boolean => {
    try {
      const ev = JSON.parse(u.raw_event || '{}');
      const tag = (ev.tags || []).find((t: any[]) => t[0] === 'payment_scheme_fields');
      if (tag && tag[1]) {
        const f = JSON.parse(tag[1]);
        if (f && typeof f === 'object' && Object.values(f).some(v => String(v ?? '').trim() !== '')) {
          return true;
        }
      }
    } catch { /* fall through to legacy / false */ }
    return !!(u.bank_account && String(u.bank_account).trim() !== '');
  };

  const result = filtered.map((u) => {
    // Strip the raw payout fields; expose only the computed boolean.
    const { raw_event, bank_account, ...rest } = u;
    return { ...rest, payout_configured: hasPayout({ raw_event, bank_account }) };
  });

  res.json({ units: result });
});

// ─── Authorization Helper ─────────────────────────────
function isAuthorizedForUnit(db: any, hexId: string, unitId: string): boolean {
  const unit = db.prepare('SELECT owner_hex, authorized_hex FROM business_units WHERE unit_id = ?').get(unitId) as any;
  if (!unit) return false;
  if (unit.owner_hex === hexId) return true;
  try {
    const authList: string[] = JSON.parse(unit.authorized_hex || '[]');
    return authList.includes(hexId);
  } catch { return false; }
}

// Resolve the OWNER (merchant) of a unit. Regular customers are shared per owner,
// so all of a merchant's shops draw from one pool. Returns '' if unknown.
function ownerForUnit(db: any, unitId: string): string {
  const unit = db.prepare('SELECT owner_hex FROM business_units WHERE unit_id = ?').get(unitId) as any;
  return unit?.owner_hex || '';
}

// Distinct OWNERS (merchants) this operator can manage — owner of, or staff on, any
// active unit. Used to scope the unified regular-customers list + cross-merchant delete.
function authorizedOwners(db: any, staffHex: string): string[] {
  const units = db.prepare(`SELECT owner_hex, authorized_hex FROM business_units WHERE status = 'active'`).all() as any[];
  const owners = new Set<string>();
  for (const u of units) {
    const authed = u.owner_hex === staffHex
      || (() => { try { return JSON.parse(u.authorized_hex || '[]').includes(staffHex); } catch { return false; } })();
    if (authed && u.owner_hex) owners.add(u.owner_hex);
  }
  return [...owners];
}

// ─── Regular Customers API ────────────────────────────

/**
 * List regular customers for a business unit
 */
app.get('/api/regular-customers/:unitId', (req, res) => {
  const { unitId } = req.params;
  const staffHex = req.query.staff_hex as string;

  if (!staffHex || !unitId) {
    return res.status(400).json({ error: 'Missing staff_hex or unitId' });
  }

  if (!isAuthorizedForUnit(db, staffHex, unitId)) {
    return res.status(403).json({ error: 'Not authorized for this unit' });
  }

  // Owner-wide: every shop of this merchant shares one regular-customers pool.
  const ownerHex = ownerForUnit(db, unitId);
  const customers = db.prepare(`
    SELECT id, unit_id, customer_hex_id, customer_wallet, customer_npub,
           display_name, picture, added_by_hex, note, created_at
    FROM regular_customers
    WHERE owner_hex = ?
    ORDER BY display_name ASC, created_at ASC
  `).all(ownerHex);

  res.json({ customers });
});

/**
 * Add/upsert a regular customer
 */
app.post('/api/regular-customers', (req, res) => {
  const { unit_id, customer_hex_id, customer_wallet, customer_npub, display_name, picture, staff_hex, note } = req.body;

  if (!unit_id || !customer_hex_id || !customer_wallet || !staff_hex) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!isAuthorizedForUnit(db, staff_hex, unit_id)) {
    return res.status(403).json({ error: 'Not authorized for this unit' });
  }

  // Add to the OWNER's shared pool. unit_id is kept as "added-at" provenance and
  // is NOT overwritten on conflict (preserve where the customer was first added).
  const ownerHex = ownerForUnit(db, unit_id);
  if (!ownerHex) {
    return res.status(400).json({ error: 'Unknown unit owner — not yet synced' });
  }

  db.prepare(`
    INSERT INTO regular_customers (unit_id, owner_hex, customer_hex_id, customer_wallet, customer_npub, display_name, picture, added_by_hex, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_hex, customer_hex_id) DO UPDATE SET
      customer_wallet = excluded.customer_wallet,
      customer_npub = excluded.customer_npub,
      display_name = COALESCE(excluded.display_name, regular_customers.display_name),
      picture = COALESCE(excluded.picture, regular_customers.picture),
      note = COALESCE(excluded.note, regular_customers.note)
  `).run(unit_id, ownerHex, customer_hex_id, customer_wallet, customer_npub || null, display_name || null, picture || null, staff_hex, note || null);

  const customer = db.prepare('SELECT * FROM regular_customers WHERE owner_hex = ? AND customer_hex_id = ?').get(ownerHex, customer_hex_id);
  res.json({ success: true, customer });
});

/**
 * Delete a regular customer
 */
app.delete('/api/regular-customers/:unitId/:customerHexId', (req, res) => {
  const { unitId, customerHexId } = req.params;
  const staffHex = req.query.staff_hex as string;

  if (!staffHex) {
    return res.status(400).json({ error: 'Missing staff_hex' });
  }

  if (!isAuthorizedForUnit(db, staffHex, unitId)) {
    return res.status(403).json({ error: 'Not authorized for this unit' });
  }

  // The management list is deduped per PERSON across all the operator's merchants,
  // so one delete must clear them everywhere this operator manages (else the row
  // would reappear from another merchant's pool after refresh).
  const owners = authorizedOwners(db, staffHex);
  if (owners.length) {
    const ph = owners.map(() => '?').join(',');
    db.prepare(`DELETE FROM regular_customers WHERE customer_hex_id = ? AND owner_hex IN (${ph})`).run(customerHexId, ...owners);
  }
  res.json({ success: true });
});

/**
 * Get ALL regular customers across all units the staff member is authorized for
 */
app.get('/api/regular-customers-all', (req, res) => {
  const staffHex = req.query.staff_hex as string;
  if (!staffHex) return res.status(400).json({ error: 'Missing staff_hex' });

  // Get all units this staff member has access to
  const units = db.prepare(`
    SELECT unit_id, name, owner_hex, authorized_hex FROM business_units WHERE status = 'active'
  `).all() as any[];

  // Distinct OWNERS whose shops this staff can operate (regulars are per-owner).
  const ownerSet = new Set<string>();
  for (const u of units) {
    const authed = u.owner_hex === staffHex
      || (() => { try { return JSON.parse(u.authorized_hex || '[]').includes(staffHex); } catch { return false; } })();
    if (authed && u.owner_hex) ownerSet.add(u.owner_hex);
  }
  if (ownerSet.size === 0) return res.json({ customers: [] });

  // unit_id → name, for the "added-at" provenance shown on each row.
  const unitMap: Record<string, string> = {};
  units.forEach(u => { unitMap[u.unit_id] = u.name; });

  const owners = [...ownerSet];
  const placeholders = owners.map(() => '?').join(',');
  // Newest first so we can keep ONE row per PERSON: a customer who is a regular at
  // two of the operator's merchants must appear only once in this unified list.
  const rows = db.prepare(`
    SELECT id, unit_id, owner_hex, customer_hex_id, customer_wallet, customer_npub,
           display_name, picture, added_by_hex, note, created_at
    FROM regular_customers
    WHERE owner_hex IN (${placeholders})
    ORDER BY id DESC
  `).all(...owners) as any[];

  const seenHex = new Set<string>();
  const enriched = rows
    .filter(c => (seenHex.has(c.customer_hex_id) ? false : (seenHex.add(c.customer_hex_id), true)))
    .map(c => ({ ...c, unit_name: unitMap[c.unit_id] || c.unit_id }))
    .sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));

  res.json({ customers: enriched });
});

/**
 * Proxy Lana8Wonder status check (avoids CORS from frontend)
 */
app.get('/api/lana8wonder/:hexId', async (req, res) => {
  const { hexId } = req.params;
  try {
    const r = await fetch(`https://check.lanapays.us/api/lana8wonder/${hexId}`, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    res.json(data);
  } catch {
    res.json({ enrolled: false });
  }
});

/**
 * Proxy profile search via mejmoSeFajn Lana Transparency module.
 * Returns ONLY profiles with a Lana wallet ID (walletOnly: true) so the
 * caller can immediately add them as regular customers.
 */
const profileSearchLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.post('/api/profile-search', profileSearchLimiter, async (req, res) => {
  const { search } = req.body;
  if (!search || typeof search !== 'string' || search.trim().length < 2) {
    return res.status(400).json({ error: 'search query must be at least 2 characters' });
  }
  try {
    const r = await fetch('https://app.mejmosefajn.org/api/functions/list-profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletOnly: true, search: search.trim() }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    // Only return profiles that ACTUALLY have a wallet (defence in depth)
    const profiles = (data.profiles || [])
      .filter((p: any) => p.lanaWalletID && p.pubkey)
      .slice(0, 30); // cap results
    res.json({ profiles, total: profiles.length });
  } catch (e: any) {
    console.error('Profile search failed:', e.message);
    res.status(502).json({ error: 'Profile search service unavailable' });
  }
});

/**
 * Proxy wallet list + freeze status check (avoids CORS)
 */
app.get('/api/wallets/:hexId', async (req, res) => {
  const { hexId } = req.params;
  try {
    const r = await fetch(`https://check.lanapays.us/api/wallets/${hexId}`, { signal: AbortSignal.timeout(10000) });
    const data = await r.json();
    res.json(data);
  } catch {
    res.json({ wallets: [], accountStatus: 'unknown', walletCount: 0 });
  }
});

/**
 * Fetch full KIND 0 profile for editing
 */
app.get('/api/profile-full/:hexId', async (req, res) => {
  const { hexId } = req.params;

  try {
    const profile = await fetchKind0Full(hexId);
    res.json({ profile });
  } catch (error: any) {
    console.error(`Full profile fetch failed for ${hexId}:`, error.message);
    res.json({ profile: null });
  }
});

/**
 * Broadcast a pre-signed Nostr event to relays
 */
app.post('/api/broadcast-event', async (req, res) => {
  const { event } = req.body;

  if (!event || !event.id || !event.sig || !event.pubkey) {
    return res.status(400).json({ error: 'Missing required event fields (id, sig, pubkey)' });
  }

  // Get relay list from KIND 38888
  const sysRow = db.prepare(
    'SELECT relays FROM kind_38888 ORDER BY id DESC LIMIT 1'
  ).get() as any;

  const relays = sysRow ? JSON.parse(sysRow.relays || '[]') : undefined;

  try {
    const result = await broadcastEvent(event, relays);
    console.log(`Broadcast KIND ${event.kind}: ${result.success.length} ok, ${result.failed.length} failed`);
    res.json(result);
  } catch (error: any) {
    console.error('Broadcast failed:', error.message);
    res.status(500).json({ error: 'Failed to broadcast event' });
  }
});

// ─── Caretaker info ───────────────────────────────────────────────
/**
 * GET /api/caretaker/:unitId
 * Returns the caretaker for a business unit (from KIND 30902 fee policy)
 * plus the caretaker's KIND 0 profile (name, picture, contact info, …).
 * If no caretaker is set or the profile isn't fetchable, returns 404.
 */
app.get('/api/caretaker/:unitId', async (req, res) => {
  const { unitId } = req.params;
  if (!unitId) return res.status(400).json({ error: 'unit_id is required' });

  const policy = db.prepare(
    'SELECT caretaker_hex, caretaker_wallet FROM fee_policies WHERE unit_id = ?'
  ).get(unitId) as { caretaker_hex?: string; caretaker_wallet?: string } | undefined;

  if (!policy?.caretaker_hex) {
    return res.status(404).json({ error: 'No caretaker assigned to this unit' });
  }

  try {
    const profile = await fetchKind0Full(policy.caretaker_hex);
    res.json({
      hex: policy.caretaker_hex,
      wallet: policy.caretaker_wallet || null,
      profile: profile?.content ?? null,
      profileFetchedAt: profile?.created_at ?? null,
    });
  } catch (error: any) {
    console.error(`Caretaker KIND 0 lookup failed for ${policy.caretaker_hex}:`, error.message);
    res.json({
      hex: policy.caretaker_hex,
      wallet: policy.caretaker_wallet || null,
      profile: null,
      profileFetchedAt: null,
    });
  }
});

// ─── NIP-04 Direct Messages ───────────────────────────────────────
/**
 * POST /api/dm/fetch
 * Body: { userPubkey, since? }
 * Returns sent + received KIND 4 events for the user across all relays.
 */
app.post('/api/dm/fetch', async (req, res) => {
  try {
    const { userPubkey, since } = req.body;
    if (!userPubkey || typeof userPubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(userPubkey)) {
      return res.status(400).json({ success: false, error: 'Valid userPubkey required', events: [] });
    }

    // Strict: only the relays advertised in the latest KIND 38888 are queried.
    // LANA_RELAYS is the seed used solely on a fresh DB before the first heartbeat.
    const relayRow = db.prepare('SELECT relays FROM kind_38888 ORDER BY id DESC LIMIT 1').get() as any;
    const relays: string[] = relayRow?.relays ? JSON.parse(relayRow.relays) : LANA_RELAYS;
    if (!relays.length) {
      return res.status(503).json({ success: false, error: 'No relays known yet (KIND 38888 not seeded)', events: [] });
    }

    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    const sinceTs = typeof since === 'number' && since > 0 ? since : thirtyDaysAgo;
    const isPolling = typeof since === 'number' && since > Math.floor(Date.now() / 1000) - 300;

    const events = await fetchDmEvents(relays, userPubkey, sinceTs, isPolling);
    res.json({ success: true, events, relayCount: relays.length });
  } catch (error: any) {
    console.error('DM fetch error:', error.message);
    res.status(500).json({ success: false, error: error.message, events: [] });
  }
});

/**
 * POST /api/dm/publish
 * Body: { event } — signed KIND 4 ciphertext event (encrypted in the browser)
 */
app.post('/api/dm/publish', async (req, res) => {
  try {
    const { event } = req.body;
    if (!event?.id || !event?.sig || !event?.pubkey || event.kind !== 4) {
      return res.status(400).json({ success: false, error: 'Signed KIND 4 event required' });
    }

    // Strict: publish only to relays advertised in the latest KIND 38888.
    // No third-party fallback — if the system is configured, we use the
    // configured set; otherwise we refuse rather than leak to unknown relays.
    const relayRow = db.prepare('SELECT relays FROM kind_38888 ORDER BY id DESC LIMIT 1').get() as any;
    const relays: string[] = relayRow?.relays ? JSON.parse(relayRow.relays) : [];
    if (!relays.length) {
      return res.status(503).json({ success: false, error: 'No relays configured (KIND 38888 not seeded yet)' });
    }

    const okCount = await publishDmToRelays(relays, event);
    console.log(`DM: published KIND 4 to ${okCount}/${relays.length} KIND-38888 relays`);
    res.json({ success: okCount > 0, publishedTo: okCount, totalRelays: relays.length });
  } catch (error: any) {
    console.error('DM publish error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Languages list for profile editing
 */
app.get('/i18n/languages', (_req, res) => {
  res.json(SUPPORTED_LANGUAGES);
});

// ─── Max Transaction Limit ────────────────────────────

/**
 * GET /api/max-transaction
 * Returns the effective max transaction amount for a business unit
 * Takes the lower of: merchant limit (KIND 30902) and direct.fund capacity
 * Query: ?unit_id=xxx&currency=EUR
 */
app.get('/api/max-transaction', (req, res) => {
  const unitId = req.query.unit_id as string;
  const fallbackCurrency = ((req.query.currency as string) || 'EUR').toUpperCase();

  if (!unitId) {
    return res.status(400).json({ error: 'unit_id is required' });
  }

  // Computation lives in lib/maxTransaction.ts, shared with the purchase
  // proxy's cash clamp. Response shape unchanged.
  res.json(getMaxTransaction(db, unitId, fallbackCurrency));
});

// ─── Brain API Proxy ──────────────────────────────────

const BRAIN_API_URL = process.env.BRAIN_API_URL || '';
const BRAIN_PURCHASE_KEY = process.env.BRAIN_PURCHASE_KEY || '';

/**
 * POST /api/brain/purchase
 * Proxy purchase requests to Brain orchestration service
 * Sends BRAIN_PURCHASE_KEY as Bearer token for authentication
 */
/**
 * POST /api/brain/purchase/preview
 * Proxy to Brain's read-only preview endpoint — returns LANA recipients
 * for client-side signing, without committing the purchase.
 */
app.post('/api/brain/purchase/preview', purchaseLimiter, async (req, res) => {
  if (!BRAIN_API_URL) {
    return res.status(503).json({ success: false, error: 'Brain service not configured' });
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (BRAIN_PURCHASE_KEY) headers['Authorization'] = `Bearer ${BRAIN_PURCHASE_KEY}`;

    const response = await fetch(`${BRAIN_API_URL}/api/purchase/preview-lana-recipients`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    // DIAGNOSTIC: pinpoint which required field is empty when Brain rejects a
    // preview with "Missing required fields" (the field names + safe prefixes,
    // never full secrets). Lets us tell the seller exactly what didn't resolve.
    if (response.status === 400 && data?.error === 'Missing required fields') {
      const b = req.body || {};
      const missing = ['unit_id', 'customer_hex', 'customer_wallet', 'amount', 'currency'].filter(f => !b[f]);
      console.warn(`[mobile] PREVIEW 400 Missing required fields → EMPTY: [${missing.join(', ') || 'none?'}] | unit_id=${b.unit_id || '∅'} hex=${(b.customer_hex || '∅').slice(0, 12)} wallet=${(b.customer_wallet || '∅').slice(0, 16)} amount=${b.amount ?? '∅'} currency=${b.currency || '∅'}`);
    }
    res.status(response.status).json(data);
  } catch (error: any) {
    console.error('[mobile] Brain preview proxy error:', error.message);
    res.status(502).json({ success: false, error: 'Failed to reach Brain service' });
  }
});

/**
 * POST /api/brain/purchase/check-dedup
 * Pre-flight: ask Brain whether this (unit_id, receipt_hash) or
 * (unit_id, invoice_number) is already used. Lets the mobile UI hide the
 * "Continue" button at the receipt step rather than blocking only at submit.
 */
app.post('/api/brain/purchase/check-dedup', purchaseLimiter, async (req, res) => {
  if (!BRAIN_API_URL) {
    return res.status(503).json({ success: false, error: 'Brain service not configured' });
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (BRAIN_PURCHASE_KEY) headers['Authorization'] = `Bearer ${BRAIN_PURCHASE_KEY}`;

    const response = await fetch(`${BRAIN_API_URL}/api/purchase/check-dedup`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error: any) {
    console.error('[mobile] Brain dedup proxy error:', error.message);
    // Don't fail the user flow if the check itself errors — Brain will still
    // enforce dedup at submit time. Return a permissive response.
    res.status(200).json({ duplicate: false });
  }
});

app.post('/api/brain/purchase', purchaseLimiter, async (req, res) => {
  if (!BRAIN_API_URL) {
    return res.status(503).json({ success: false, error: 'Brain service not configured' });
  }

  // ── Split in progress → CASH is blocked (LANA is fine). Mobile-local flag
  // (app_settings.split_happening) — the same one the POS reads via
  // /api/system-params. Backstop for the disabled cash button. ──
  if (String(req.body?.payment_type) === 'cash') {
    const sh = db.prepare("SELECT value FROM app_settings WHERE key = 'split_happening'").get() as any;
    if (sh?.value === 'true') {
      return res.status(403).json({
        success: false,
        error: 'SPLIT_HAPPENING',
        message: 'Cash payments are disabled while a Split is in progress. Please pay with LANA.',
      });
    }
  }

  // ── Defense in depth: gateway gate using last-synced KIND 30903 state ──
  // The brain is authoritative for any race condition (its own kind_30903 is
  // freshest), but a quick local check catches the obvious blocked-merchant
  // and quota-exceeded cases without burning a brain round-trip.
  const unitId = req.body?.unit_id;
  const amount = Number(req.body?.amount || 0);
  // Set when the cash clamp below rewrites the amount; echoed in the response
  // so the client can tell the user what was actually charged.
  let amountAdjusted: { original: number; adjusted: number; currency: string } | null = null;
  if (typeof unitId === 'string' && unitId.length > 0) {
    const u = db.prepare(`
      SELECT suspension_status, quota_volume_used, quota_volume_limit,
             quota_tx_used, quota_tx_limit, quota_currency, currency
      FROM business_units WHERE unit_id = ?
    `).get(unitId) as any;

    if (u) {
      const isCash = String(req.body?.payment_type) === 'cash';
      // Approval/suspension states block BOTH rails. The monthly quota
      // (quota_blocked + the volume/tx pre-flight) is CASH-only — LANA is the
      // uncapped native rail and is never gated by it. Mirrors the brain gate.
      const FULL_BLOCKED = ['pending', 'suspended', 'rejected'];
      if (FULL_BLOCKED.includes(u.suspension_status)) {
        const errCode = `MERCHANT_${String(u.suspension_status).toUpperCase()}`;
        console.warn(`[mobile] Blocking purchase pre-flight: unit ${unitId.slice(0, 12)} status=${u.suspension_status}`);
        return res.status(403).json({
          success: false,
          error: errCode,
          message: u.suspension_status === 'pending'
            ? 'Merchant is awaiting admin approval — payments paused'
            : `Cannot process purchase: merchant is ${u.suspension_status}`,
        });
      }
      if (isCash) {
        // CASH-only monthly limit. LANA is never gated here.
        if (u.suspension_status === 'quota_blocked') {
          console.warn(`[mobile] Blocking CASH pre-flight: unit ${unitId.slice(0, 12)} quota_blocked`);
          return res.status(403).json({
            success: false,
            error: 'MERCHANT_QUOTA_EXCEEDED',
            message: 'Monthly cash limit reached, resets 1st of next month',
          });
        }
        const reqCurrency = String(req.body?.currency || '').toUpperCase();

        // ── CASH CLAMP (authoritative). An invoice above the effective
        // per-transaction maximum is ADJUSTED down to it, not rejected — the
        // merchant charges the rest outside the system. This is the backstop
        // behind the client-side clamp: it also catches stale bundles and the
        // regular-customer path, whatever the client sent. It must run BEFORE
        // the volume pre-flight below, which would otherwise 403 an amount
        // the clamp brings under the quota. LANA is never clamped: its amount
        // is baked into the client-signed TX.
        if (Number.isFinite(amount) && amount > 0) {
          const limits = getMaxTransaction(db, unitId, reqCurrency || String(u.currency || 'EUR'));
          const effMax = foldQuotaRemaining(limits.max_amount, u, reqCurrency);
          const clamp = clampCashAmount(amount, effMax);
          if (clamp.adjusted) {
            req.body.amount = clamp.amount;
            amountAdjusted = { original: round2(amount), adjusted: clamp.amount, currency: limits.currency };
            console.warn(`[mobile] CASH amount clamped: unit=${unitId.slice(0, 12)} ${amount} -> ${clamp.amount} (limit source=${limits.source})`);
          }
        }
        const effAmount = Number(req.body?.amount || 0);

        // Pre-flight quota — only when currencies match (otherwise let brain do
        // the conversion via KIND 38888 rates). After the clamp this only fires
        // when the remaining volume is effectively zero — which stays a BLOCK,
        // since an amount cannot be adjusted down to nothing.
        const quotaCurrency = String(u.quota_currency || u.currency || 'EUR').toUpperCase();
        if (u.quota_volume_limit > 0 && reqCurrency === quotaCurrency
            && u.quota_volume_used + effAmount > u.quota_volume_limit) {
          console.warn(`[mobile] Blocking CASH pre-flight: unit ${unitId.slice(0, 12)} would exceed volume quota`);
          return res.status(403).json({
            success: false,
            error: 'MERCHANT_QUOTA_EXCEEDED',
            message: 'This cash purchase would exceed the monthly volume limit',
          });
        }
        if (u.quota_tx_limit > 0 && u.quota_tx_used + 1 > u.quota_tx_limit) {
          console.warn(`[mobile] Blocking CASH pre-flight: unit ${unitId.slice(0, 12)} would exceed tx quota`);
          return res.status(403).json({
            success: false,
            error: 'MERCHANT_QUOTA_EXCEEDED',
            message: 'Monthly cash transaction limit reached',
          });
        }
      }
    }
  }

  // Debug: log what we're sending to Brain
  console.log('[mobile] Purchase request body:', JSON.stringify({
    unit_id: req.body?.unit_id || 'EMPTY',
    payment_type: req.body?.payment_type || 'EMPTY',
    customer_hex: req.body?.customer_hex ? req.body.customer_hex.slice(0, 12) + '...' : 'EMPTY',
    customer_wallet: req.body?.customer_wallet ? req.body.customer_wallet.slice(0, 10) + '...' : 'EMPTY',
    amount: req.body?.amount,
    currency: req.body?.currency || 'EMPTY',
    invoice: req.body?.invoice_number || 'EMPTY',
  }));

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (BRAIN_PURCHASE_KEY) {
      headers['Authorization'] = `Bearer ${BRAIN_PURCHASE_KEY}`;
    }

    const response = await fetch(`${BRAIN_API_URL}/api/purchase`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    if (response.status !== 200) {
      console.error('[mobile] Brain purchase response:', response.status, JSON.stringify(data));
    }
    // Tell the client the charged amount differs from what it sent. Old
    // bundles ignore the extra field; new ones toast it.
    if (amountAdjusted && response.ok && data && typeof data === 'object') {
      (data as any).amount_adjusted = amountAdjusted;
    }
    res.status(response.status).json(data);
  } catch (error: any) {
    console.error('[mobile] Brain API proxy error:', error.message);
    res.status(502).json({ success: false, error: 'Failed to reach Brain service' });
  }
});

// ─── Invoice Image Uploads ────────────────────────────

const uploadsDir = path.resolve(__dirname, '../data/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (_req, file, cb) => {
      const id = crypto.randomBytes(12).toString('hex');
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${id}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// Serve uploaded files publicly
app.use('/uploads', express.static(uploadsDir));

/**
 * Upload invoice images (up to 5 at once)
 * Returns array of public URLs
 */
app.post('/api/upload', upload.array('images', 5), (req, res) => {
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No images provided' });
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const baseUrl = `${protocol}://${host}`;

  const urls = files.map(f => `${baseUrl}/uploads/${f.filename}`);

  res.json({ urls });
});

// ─── Receipt Upload Proxy ──────────────────────────────
// Proxies receipt uploads to file server (65.21.189.205:3099)
const RECEIPT_UPLOAD_URL = process.env.RECEIPT_UPLOAD_URL || 'http://65.21.189.205:3099/api/upload';
const RECEIPT_UPLOAD_KEY = process.env.RECEIPT_UPLOAD_KEY || 'lana_receipt_upload_2026_secure';

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    cb(null, allowed.includes(file.mimetype));
  },
});

app.post('/api/receipt/upload', receiptUpload.single('receipt'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // SHA-256 of the uploaded bytes — travels back to the client and is later
  // sent in the purchase body so Brain can dedup against double-funding.
  // Computed server-side (not client-side) so a malicious client can't lie
  // about the hash; this is the hash of bytes we actually received.
  const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

  try {
    // Forward to file server
    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
    formData.append('receipt', blob, req.file.originalname || 'receipt.jpg');

    const uploadRes = await fetch(RECEIPT_UPLOAD_URL, {
      method: 'POST',
      headers: { 'X-Upload-Key': RECEIPT_UPLOAD_KEY },
      body: formData,
    });

    if (!uploadRes.ok) {
      // Fallback: save locally
      const id = crypto.randomBytes(16).toString('hex');
      const ext = path.extname(req.file.originalname || '.jpg') || '.jpg';
      const filename = `receipt-${id}${ext}`;
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, req.file.buffer);

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      return res.json({ success: true, url: `${baseUrl}/uploads/${filename}`, hash, fallback: true });
    }

    const data = await uploadRes.json();
    res.json({ ...data, hash });
  } catch (err: any) {
    // Fallback: save locally if file server unreachable
    const id = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(req.file.originalname || '.jpg') || '.jpg';
    const filename = `receipt-${id}${ext}`;
    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, req.file.buffer);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, url: `${baseUrl}/uploads/${filename}`, hash, fallback: true });
  }
});

// ─── Receipt Analysis (Claude Vision) ──────────────────
import sharp from 'sharp';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MAX_IMAGE_BYTES = 3_500_000; // 3.5 MB raw → ~4.7 MB base64 (under Claude's 5 MB limit)

app.post('/api/receipt/analyze', receiptUpload.single('receipt'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image provided' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.json({ isReceipt: false, description: 'Receipt analysis not configured', amount: null, invoiceNumber: null });
  }

  try {
    let imageBuffer = req.file.buffer;
    let mediaType: 'image/jpeg' | 'image/png' | 'image/webp' = req.file.mimetype as any;
    const currency = (req.body.currency as string) || 'EUR';

    // The seller's UI language — Claude writes the human-readable
    // items/description in this language so the receipt summary matches
    // the rest of the app. Map our short codes to full language names so
    // the model is unambiguous. Falls back to English.
    const LANG_NAMES: Record<string, string> = {
      en: 'English', sl: 'Slovenian', de: 'German', it: 'Italian', es: 'Spanish',
      pt: 'Portuguese', hr: 'Croatian', sr: 'Serbian', pl: 'Polish',
      hu: 'Hungarian', ru: 'Russian', zh: 'Chinese',
    };
    const langCode = ((req.body.lang as string) || 'en').slice(0, 2).toLowerCase();
    const langName = LANG_NAMES[langCode] || 'English';

    // Resize if image exceeds Claude's 5 MB base64 limit
    if (imageBuffer.length > MAX_IMAGE_BYTES) {
      console.log(`[mobile] Receipt image too large (${(imageBuffer.length / 1024 / 1024).toFixed(1)} MB), resizing...`);
      imageBuffer = await sharp(imageBuffer)
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      mediaType = 'image/jpeg';
      console.log(`[mobile] Resized to ${(imageBuffer.length / 1024 / 1024).toFixed(1)} MB`);
    }

    const base64Image = imageBuffer.toString('base64');

    const requestBody = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Image },
          },
          {
            type: 'text',
            text: `Analyze this image. Respond ONLY with valid JSON (no markdown, no code blocks).

If this is a receipt/invoice/bill:
{"isReceipt":true,"amount":NUMBER_OR_NULL,"currency":"${currency}","invoiceNumber":"STRING_OR_NULL","items":"brief description of purchased items"}

If this is NOT a receipt (photo of people, items, scene, etc.):
{"isReceipt":false,"description":"what the image shows in 1-2 sentences","amount":null,"invoiceNumber":null}

Rules:
- amount must be a number (no currency symbols), or null if unreadable
- invoiceNumber: receipt/invoice number if visible, null otherwise
- For non-receipts, describe what you see objectively
- IMPORTANT: write the "items" and "description" text in ${langName}. All other JSON keys and values stay exactly as specified.`
          }
        ]
      }],
    });

    // Retry on transient Anthropic errors: 429 (rate-limited), 5xx, 529 (overloaded).
    // Backoff: 500 ms → 1500 ms → 3500 ms (max 3 attempts, total <6 s).
    const RETRY_DELAYS_MS = [500, 1500, 3500];
    let response: Response | null = null;
    let lastErrText = '';
    let lastStatus = 0;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: requestBody,
      });

      if (r.ok) { response = r; break; }

      lastStatus = r.status;
      lastErrText = await r.text();
      const transient = r.status === 429 || r.status === 529 || (r.status >= 500 && r.status < 600);

      if (!transient || attempt === RETRY_DELAYS_MS.length) {
        // Non-retryable, or out of retries
        console.error(`[mobile] Claude Vision error (attempt ${attempt + 1}):`, r.status, lastErrText);
        break;
      }

      console.warn(`[mobile] Claude Vision transient ${r.status}, retrying in ${RETRY_DELAYS_MS[attempt]}ms (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1})`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }

    if (!response) {
      // All attempts failed — signal the reason so the client can show a sensible message.
      const overloaded = lastStatus === 429 || lastStatus === 529 || (lastStatus >= 500 && lastStatus < 600);
      return res.json({
        isReceipt: false,
        description: '',
        amount: null,
        invoiceNumber: null,
        analysisError: overloaded ? 'overloaded' : 'failed',
      });
    }

    const result = await response.json();
    const text = result.content?.[0]?.text || '{}';

    // Parse the JSON response (handle potential markdown wrapping)
    let analysis;
    try {
      const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analysis = JSON.parse(jsonStr);
    } catch {
      console.warn('[mobile] Failed to parse Claude response:', text);
      analysis = { isReceipt: false, description: text.slice(0, 200), amount: null, invoiceNumber: null };
    }

    res.json(analysis);
  } catch (err: any) {
    console.error('[mobile] Receipt analysis error:', err.message);
    res.json({ isReceipt: false, description: '', amount: null, invoiceNumber: null, analysisError: 'failed' });
  }
});

// ─── Admin API ──────────────────────────────────────────

function requireAdmin(req: any, res: any): string | null {
  const hexId = req.headers['x-admin-hex-id'] as string;
  if (!hexId) { res.status(401).json({ error: 'Missing admin header' }); return null; }
  const admin = db.prepare('SELECT * FROM admin_users WHERE hex_id = ?').get(hexId) as any;
  if (!admin) { res.status(403).json({ error: 'Not an admin' }); return null; }
  return hexId;
}

// Check if a user is admin
app.get('/api/admin/check', (req, res) => {
  const hexId = req.query.hex_id as string;
  if (!hexId) return res.json({ isAdmin: false });
  const admin = db.prepare('SELECT * FROM admin_users WHERE hex_id = ?').get(hexId) as any;
  res.json({ isAdmin: !!admin, name: admin?.name || null });
});

// Get all app settings
app.get('/api/admin/settings', (req, res) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;
  const rows = db.prepare('SELECT key, value, updated_at FROM app_settings ORDER BY key').all() as any[];
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;
  res.json({ settings });
});

// Update app settings
app.put('/api/admin/settings', (req, res) => {
  const adminHex = requireAdmin(req, res);
  if (!adminHex) return;
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object required' });
  }
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at, updated_by)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `);
  let updated = 0;
  for (const [key, value] of Object.entries(settings)) {
    upsert.run(key, String(value), adminHex);
    updated++;
  }
  res.json({ success: true, updated });
});

// ─── Lana-online payment requests (merchant + public /api/pay/:token) ─────

registerPaymentRequestRoutes(app, db);

// ─── Static Frontend (MUST be after all API routes) ───────────────────────

const distPath = path.resolve(__dirname, '../dist');
app.use(express.static(distPath));
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// ─── Start Server ──────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Lana Pays.Us server running on port ${PORT}`);
  startHeartbeat(db);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  stopHeartbeat();
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  stopHeartbeat();
  closeDb();
  process.exit(0);
});
