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
import { fetchKind0Profile, fetchKind0Full, broadcastEvent, SUPPORTED_LANGUAGES } from './lib/nostr.js';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '3005');

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

// Rate limiting
const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const purchaseLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.use(globalLimiter);

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
    console.error('[mobile-server]', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Internal server error' });
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

  // Query units where owner_hex matches OR hexId is in the authorized_hex JSON array
  const units = db.prepare(`
    SELECT unit_id, name, owner_hex, authorized_hex, category, category_detail,
           currency, country, image, logo, status, receiver_city,
           lanapays_payout_method, suspension_status, suspension_reason,
           suspension_until, suspension_content, updated_at
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

  // Get merchant limit from KIND 30902 fee policy (includes currency)
  const policy = db.prepare(
    'SELECT max_tx_amount, max_tx_currency FROM fee_policies WHERE unit_id = ?'
  ).get(unitId) as any;

  const merchantLimit = policy?.max_tx_amount ? parseFloat(policy.max_tx_amount) : null;

  // Use the currency from the fee policy tag, fall back to unit/query currency
  const currency = (policy?.max_tx_currency || fallbackCurrency).toUpperCase();

  // Get latest direct fund capacity for the unit's currency
  const capacity = db.prepare(
    'SELECT total_available, max_single_budget, investor_count, blocked_count, fetched_at FROM fund_capacity WHERE currency = ? ORDER BY id DESC LIMIT 1'
  ).get(currency) as any;

  // Max invoice = largest single budget (one invoice goes to one budget, not split across)
  // When capacity exists but is 0, that means no budget available — respect that as 0, not null
  const fundLimit = capacity
    ? (capacity.max_single_budget ?? capacity.total_available ?? 0)
    : null;

  // Calculate effective max: always use fundLimit when available (even if 0)
  let maxAmount: number | null = null;
  let source = 'none';

  if (fundLimit !== null && merchantLimit !== null) {
    maxAmount = Math.min(merchantLimit, fundLimit);
    source = maxAmount === merchantLimit ? 'merchant' : 'fund';
  } else if (fundLimit !== null) {
    maxAmount = fundLimit;
    source = 'fund';
  } else if (merchantLimit !== null) {
    maxAmount = merchantLimit;
    source = 'merchant';
  }

  res.json({
    unit_id: unitId,
    currency,
    max_amount: maxAmount !== null ? Math.round(maxAmount * 100) / 100 : null,
    source,
    merchant_limit: merchantLimit !== null ? Math.round(merchantLimit * 100) / 100 : null,
    fund_limit: fundLimit !== null ? Math.round(fundLimit * 100) / 100 : null,
    fund_investors: capacity?.investor_count || 0,
    fund_updated_at: capacity?.fetched_at || null,
  });
});

// ─── Brain API Proxy ──────────────────────────────────

const BRAIN_API_URL = process.env.BRAIN_API_URL || '';
const BRAIN_PURCHASE_KEY = process.env.BRAIN_PURCHASE_KEY || '';

/**
 * POST /api/brain/purchase
 * Proxy purchase requests to Brain orchestration service
 * Sends BRAIN_PURCHASE_KEY as Bearer token for authentication
 */
app.post('/api/brain/purchase', purchaseLimiter, async (req, res) => {
  if (!BRAIN_API_URL) {
    return res.status(503).json({ success: false, error: 'Brain service not configured' });
  }

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
    res.status(response.status).json(data);
  } catch (error: any) {
    console.error('Brain API proxy error:', error.message);
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
      return res.json({ success: true, url: `${baseUrl}/uploads/${filename}`, fallback: true });
    }

    const data = await uploadRes.json();
    res.json(data);
  } catch (err: any) {
    // Fallback: save locally if file server unreachable
    const id = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(req.file.originalname || '.jpg') || '.jpg';
    const filename = `receipt-${id}${ext}`;
    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, req.file.buffer);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, url: `${baseUrl}/uploads/${filename}`, fallback: true });
  }
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
