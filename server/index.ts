/**
 * Lana Pays.Us — Express Server
 * Port 3005 | Heartbeat every 5 min | SQLite persistence
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { getDb, closeDb } from './db/connection.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { fetchSingleBalance, type ElectrumServer } from './lib/electrum.js';
import { fetchKind0Profile } from './lib/nostr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '3005');

app.use(express.json());

// Initialize database
const db = getDb();

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

  if (!row) {
    return res.json({ data: null });
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
    console.error(`Balance check failed for ${address}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch balance', details: error.message });
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
app.post('/api/check-wallet', async (req, res) => {
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
 * Get business units where the given hex pubkey is authorized (owner or staff via p tags)
 */
app.get('/api/business-units/:hexId', (req, res) => {
  const { hexId } = req.params;

  // Query units where owner_hex matches OR hexId is in the authorized_hex JSON array
  const units = db.prepare(`
    SELECT unit_id, name, owner_hex, authorized_hex, category, category_detail,
           currency, country, image, logo, status, receiver_city,
           lanapays_payout_method, updated_at
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

  res.json({ units: filtered });
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

// ─── Static Frontend ───────────────────────────────────

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
