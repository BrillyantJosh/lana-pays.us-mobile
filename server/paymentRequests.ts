/**
 * Lana-online — remote payment requests.
 *
 * A merchant creates a payment REQUEST (stored in FIAT only); the app gives
 * them a public link /pay/<token> to send to a remote customer. The customer
 * opens the link, sees what they're buying (invoice/receipt, amount, payee),
 * enters/scans their WIF, and the browser signs a LanaCoin tx locally
 * (signCustomerLanaTx — the WIF never leaves the customer's device); the
 * signed hex is submitted here and forwarded to the brain.
 *
 * MONEY INVARIANT: the LANA amount is computed by the brain AT PAYMENT TIME
 * from the then-current KIND 38888 exchange rate. A split may republish new
 * fx rates between request creation and payment — that is why this table
 * stores amount_fiat and never a LANA amount (paid_* columns are a
 * post-payment snapshot for history display only).
 *
 * TAMPER-PROOFING: the public preview/submit endpoints always take
 * unit_id/amount/currency/invoice from the SERVER row, never from the client.
 * The brain preview response is snapshotted server-side (preview_json) and
 * the client's echoed allocations must deep-equal it at submit — the brain
 * then re-validates the total independently (drift guard).
 */

import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import type Database from 'better-sqlite3';
import type { Express } from 'express';

// ── Helpers ──────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/i;
const LANA_ADDR = /^[LM][1-9A-HJ-NP-Za-km-z]{25,40}$/;

/** Canonical JSON (recursively sorted object keys) for allocation comparison. */
function stableStringify(value: any): string {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** Latest KIND 38888 row (rates + split) — same source /api/system-params uses. */
function latestSystemParams(db: Database.Database): { rates: Record<string, number>; split: string | null } {
  const row = db.prepare('SELECT split, exchange_rates FROM kind_38888 ORDER BY id DESC LIMIT 1').get() as any;
  if (!row) return { rates: {}, split: null };
  let rates: Record<string, number> = {};
  try { rates = JSON.parse(row.exchange_rates || '{}'); } catch { /* keep empty */ }
  return { rates, split: row.split ?? null };
}

/** Business unit row if `hex` is its owner or an authorized staff hex, else null. */
function unitForMerchant(db: Database.Database, hex: string, unitId: string): any | null {
  if (!HEX64.test(hex || '') || !unitId) return null;
  const u = db.prepare(`
    SELECT unit_id, name, owner_hex, authorized_hex, currency, suspension_status
    FROM business_units
    WHERE status = 'active' AND unit_id = ?
  `).get(unitId) as any;
  if (!u) return null;
  if (u.owner_hex === hex) return u;
  try {
    const authList: string[] = JSON.parse(u.authorized_hex || '[]');
    if (authList.includes(hex)) return u;
  } catch { /* fall through */ }
  return null;
}

/** All unit_ids where `hex` is owner or authorized (for cross-unit notification). */
function unitIdsForMerchant(db: Database.Database, hex: string): string[] {
  if (!HEX64.test(hex || '')) return [];
  const units = db.prepare(`
    SELECT unit_id, owner_hex, authorized_hex FROM business_units
    WHERE status = 'active' AND (owner_hex = ? OR authorized_hex LIKE ?)
  `).all(hex, `%${hex}%`) as any[];
  return units.filter(u => {
    if (u.owner_hex === hex) return true;
    try { return (JSON.parse(u.authorized_hex || '[]') as string[]).includes(hex); } catch { return false; }
  }).map(u => u.unit_id);
}

/** Lazily flip a pending request past its expires_at to 'expired'. Returns fresh row. */
function loadWithLazyExpiry(db: Database.Database, token: string): any | null {
  const row = db.prepare('SELECT * FROM payment_requests WHERE token = ?').get(token) as any;
  if (!row) return null;
  if (row.status === 'pending' && row.expires_at) {
    const changed = db.prepare(`
      UPDATE payment_requests SET status = 'expired'
      WHERE token = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')
    `).run(token);
    if (changed.changes === 1) row.status = 'expired';
  }
  return row;
}

const merchantRequestView = (r: any) => ({
  id: r.id,
  token: r.token,
  unit_id: r.unit_id,
  unit_name: r.unit_name,
  status: r.status === 'paying' ? 'pending' : r.status, // 'paying' is internal — show as pending
  amount_fiat: r.amount_fiat,
  currency: r.currency,
  invoice_number: r.invoice_number,
  receipt_url: r.receipt_url,
  created_at: r.created_at,
  expires_at: r.expires_at,
  paid_at: r.paid_at,
  tx_hash: r.tx_hash,
  paid_lana_lanoshis: r.paid_lana_lanoshis,
  paid_exchange_rate: r.paid_exchange_rate,
  customer_name: r.customer_name,
  seen_by_merchant: r.seen_by_merchant,
});

// ── Route registration ───────────────────────────────────────────────────

export function registerPaymentRequestRoutes(app: Express, db: Database.Database): void {
  const BRAIN_API_URL = process.env.BRAIN_API_URL || '';
  const BRAIN_PURCHASE_KEY = process.env.BRAIN_PURCHASE_KEY || '';

  const brainHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (BRAIN_PURCHASE_KEY) headers['Authorization'] = `Bearer ${BRAIN_PURCHASE_KEY}`;
    return headers;
  };

  // Public-page limiters (the global 1500/15min limiter still applies on top).
  const payViewLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
  const payActionLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

  // ═══ Merchant endpoints (trust-the-client hex — same pattern as
  //     /api/business-units/:hexId and /api/regular-customers) ═══

  /** Create a payment request. Stored in FIAT — no LANA amount (see header). */
  app.post('/api/payment-requests', (req, res) => {
    const { unit_id, merchant_hex, amount, currency, invoice_number,
      receipt_url, receipt_hash, receipt_type, receipt_description } = req.body || {};

    const unit = unitForMerchant(db, String(merchant_hex || ''), String(unit_id || ''));
    if (!unit) return res.status(403).json({ success: false, error: 'NOT_AUTHORIZED' });

    // Approval/suspension states block request creation (mirrors the purchase
    // pre-flight at index.ts). No cash-quota gate — this is the LANA rail.
    if (['pending', 'suspended', 'rejected'].includes(unit.suspension_status)) {
      return res.status(403).json({
        success: false,
        error: `MERCHANT_${String(unit.suspension_status).toUpperCase()}`,
        message: unit.suspension_status === 'pending'
          ? 'Merchant is awaiting admin approval — payments paused'
          : `Cannot create payment request: merchant is ${unit.suspension_status}`,
      });
    }

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ success: false, error: 'INVALID_AMOUNT' });
    }
    const cur = String(currency || '').toUpperCase();
    const { rates } = latestSystemParams(db);
    const unitCur = String(unit.currency || '').toUpperCase();
    if (!cur || (unitCur && cur !== unitCur) || (!unitCur && !(cur in rates))) {
      return res.status(400).json({ success: false, error: 'INVALID_CURRENCY' });
    }
    const invoice = String(invoice_number || '').trim();
    if (!invoice) {
      // The invoice number is REQUIRED: the brain's (unit_id, invoice_number)
      // dedup is our double-pay backstop if this process dies mid-submit.
      return res.status(400).json({ success: false, error: 'INVOICE_REQUIRED' });
    }
    // One live request per (unit, invoice) — mirrors the brain dedup semantics.
    const dup = db.prepare(`
      SELECT id FROM payment_requests
      WHERE unit_id = ? AND invoice_number = ? AND status IN ('pending','paying','paid')
    `).get(unit.unit_id, invoice) as any;
    if (dup) return res.status(409).json({ success: false, error: 'DUPLICATE_INVOICE' });

    const expiryRow = db.prepare("SELECT value FROM app_settings WHERE key = 'payment_request_expiry_hours'").get() as any;
    const expiryHours = Math.max(0, parseInt(expiryRow?.value || '168', 10) || 0);

    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString('base64url'); // 192 bits

    db.prepare(`
      INSERT INTO payment_requests (
        id, token, unit_id, merchant_hex, unit_name, amount_fiat, currency, invoice_number,
        receipt_url, receipt_hash, receipt_type, receipt_description, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
        CASE WHEN ? > 0 THEN datetime('now', '+' || ? || ' hours') ELSE NULL END)
    `).run(
      id, token, unit.unit_id, merchant_hex, unit.name || unit.unit_id, amt, cur, invoice,
      receipt_url || null, receipt_hash || null, receipt_type || null,
      receipt_description ? String(receipt_description).slice(0, 500) : null,
      expiryHours, expiryHours
    );

    const row = db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id) as any;
    console.log(`[lana-online] Request created: unit=${unit.unit_id.slice(0, 12)} ${amt} ${cur} invoice="${invoice.slice(0, 30)}"`);
    res.status(201).json({ success: true, request: merchantRequestView(row) });
  });

  /** List requests for a unit (last N + total, for the tab list and history page). */
  app.get('/api/payment-requests', (req, res) => {
    const hex = String(req.query.hex || '');
    const unitId = String(req.query.unit_id || '');
    const unit = unitForMerchant(db, hex, unitId);
    if (!unit) return res.status(403).json({ success: false, error: 'NOT_AUTHORIZED' });

    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '10'), 10) || 10));
    const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);

    // Sweep lazily so listed statuses are fresh even between heartbeats.
    db.prepare(`
      UPDATE payment_requests SET status = 'expired'
      WHERE unit_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')
    `).run(unitId);

    const total = (db.prepare('SELECT COUNT(*) AS c FROM payment_requests WHERE unit_id = ?').get(unitId) as any).c;
    const rows = db.prepare(`
      SELECT * FROM payment_requests WHERE unit_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(unitId, limit, offset) as any[];

    res.json({ success: true, total, requests: rows.map(merchantRequestView) });
  });

  /** Cancel a pending request. */
  app.post('/api/payment-requests/:id/cancel', (req, res) => {
    const hex = String(req.body?.merchant_hex || '');
    const row = db.prepare('SELECT id, unit_id, status FROM payment_requests WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    const unit = unitForMerchant(db, hex, row.unit_id);
    if (!unit) return res.status(403).json({ success: false, error: 'NOT_AUTHORIZED' });

    const changed = db.prepare(`
      UPDATE payment_requests SET status = 'cancelled' WHERE id = ? AND status = 'pending'
    `).run(row.id);
    if (changed.changes === 0) {
      const fresh = db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(row.id) as any;
      return res.status(409).json({ success: false, error: 'NOT_CANCELLABLE', status: fresh?.status });
    }
    res.json({ success: true });
  });

  /** Unseen paid count across ALL the merchant's units — drives the in-app
   *  notification (30s poll from Index). `latest` feeds the toast text. */
  app.get('/api/payment-requests/unseen-count', (req, res) => {
    const hex = String(req.query.hex || '');
    const unitIds = unitIdsForMerchant(db, hex);
    if (unitIds.length === 0) return res.json({ success: true, count: 0, latest: [] });

    const ph = unitIds.map(() => '?').join(',');
    const count = (db.prepare(`
      SELECT COUNT(*) AS c FROM payment_requests
      WHERE unit_id IN (${ph}) AND status = 'paid' AND seen_by_merchant = 0
    `).get(...unitIds) as any).c;
    const latest = db.prepare(`
      SELECT id, unit_id, unit_name, amount_fiat, currency, paid_at FROM payment_requests
      WHERE unit_id IN (${ph}) AND status = 'paid' AND seen_by_merchant = 0
      ORDER BY paid_at DESC LIMIT 3
    `).all(...unitIds) as any[];

    res.json({ success: true, count, latest });
  });

  /** Mark paid requests as seen (fired when the merchant opens the tab). */
  app.post('/api/payment-requests/mark-seen', (req, res) => {
    const hex = String(req.body?.hex || '');
    const scopeUnit = req.body?.unit_id ? String(req.body.unit_id) : null;
    const unitIds = unitIdsForMerchant(db, hex).filter(u => !scopeUnit || u === scopeUnit);
    if (unitIds.length === 0) return res.json({ success: true, updated: 0 });

    const ph = unitIds.map(() => '?').join(',');
    const changed = db.prepare(`
      UPDATE payment_requests SET seen_by_merchant = 1
      WHERE unit_id IN (${ph}) AND status = 'paid' AND seen_by_merchant = 0
    `).run(...unitIds);
    res.json({ success: true, updated: changed.changes });
  });

  // ═══ Public endpoints (no auth — the 192-bit token IS the capability) ═══

  /** Public view of a payment request — what the customer sees before paying. */
  app.get('/api/pay/:token', payViewLimiter, (req, res) => {
    const row = loadWithLazyExpiry(db, req.params.token);
    // Uniform 404 (no token oracle).
    if (!row) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const { rates } = latestSystemParams(db);
    const rate = rates[row.currency] || null;
    const indicativeLana = rate && rate > 0 ? Math.round((row.amount_fiat / rate) * 1e8) : null;

    res.json({
      success: true,
      request: {
        unitName: row.unit_name,
        amountFiat: row.amount_fiat,
        currency: row.currency,
        invoiceNumber: row.invoice_number,
        receiptUrl: row.receipt_url,
        receiptDescription: row.receipt_description,
        status: row.status === 'paying' ? 'pending' : row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        paidAt: row.paid_at,
        txHash: row.status === 'paid' ? row.tx_hash : null,
        paidLanaLanoshis: row.status === 'paid' ? row.paid_lana_lanoshis : null,
        paidExchangeRate: row.status === 'paid' ? row.paid_exchange_rate : null,
        indicativeRate: rate,
        indicativeLanaLanoshis: indicativeLana,
      },
    });
  });

  /** Brain preview with SERVER-STORED amount/unit/currency. Snapshots the
   *  response on the row so submit can enforce allocation integrity. */
  app.post('/api/pay/:token/preview', payActionLimiter, async (req, res) => {
    if (!BRAIN_API_URL) return res.status(503).json({ success: false, error: 'Brain service not configured' });

    const customerHex = String(req.body?.customer_hex || '');
    const customerWallet = String(req.body?.customer_wallet || '');
    if (!HEX64.test(customerHex) || !LANA_ADDR.test(customerWallet)) {
      return res.status(400).json({ success: false, error: 'INVALID_CUSTOMER' });
    }

    const row = loadWithLazyExpiry(db, req.params.token);
    if (!row) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (row.status !== 'pending') {
      return res.status(409).json({ success: false, error: 'REQUEST_NOT_PAYABLE', status: row.status === 'paying' ? 'pending' : row.status });
    }

    try {
      const response = await fetch(`${BRAIN_API_URL}/api/purchase/preview-lana-recipients`, {
        method: 'POST',
        headers: brainHeaders(),
        body: JSON.stringify({
          unit_id: row.unit_id,            // ← always from the row, never the client
          customer_hex: customerHex,
          customer_wallet: customerWallet,
          amount: row.amount_fiat,
          currency: row.currency,
        }),
      });
      const data: any = await response.json();
      if (!response.ok || !data?.success) {
        return res.status(response.status === 200 ? 502 : response.status).json(data);
      }

      const recipients = data.data?.recipients || [];
      const allocations = data.data?.allocations || [];
      const lanaTotalLanoshis = recipients.reduce((s: number, r: any) => s + (Number(r.amount_lanoshis) || 0), 0);
      const { rates } = latestSystemParams(db);

      db.prepare(`
        UPDATE payment_requests SET preview_json = ?, preview_at = datetime('now') WHERE token = ? AND status = 'pending'
      `).run(JSON.stringify({ recipients, allocations }), req.params.token);

      res.json({
        success: true,
        data: {
          recipients,
          allocations,
          lanaTotalLanoshis,
          exchangeRate: rates[row.currency] || null,
        },
      });
    } catch (error: any) {
      console.error('[lana-online] Brain preview error:', error.message);
      res.status(502).json({ success: false, error: 'Failed to reach Brain service' });
    }
  });

  /** Execute the payment: atomic claim → allocation integrity → brain purchase. */
  app.post('/api/pay/:token/submit', payActionLimiter, async (req, res) => {
    if (!BRAIN_API_URL) return res.status(503).json({ success: false, error: 'Brain service not configured' });

    const token = req.params.token;
    const customerHex = String(req.body?.customer_hex || '');
    const customerWallet = String(req.body?.customer_wallet || '');
    const customerName = req.body?.customer_name ? String(req.body.customer_name).slice(0, 120) : '';
    const signedTxHex = String(req.body?.signed_tx_hex || '');
    const clientAllocations = req.body?.allocations;

    if (!HEX64.test(customerHex) || !LANA_ADDR.test(customerWallet)) {
      return res.status(400).json({ success: false, error: 'INVALID_CUSTOMER' });
    }
    if (!/^[0-9a-fA-F]{20,90000}$/.test(signedTxHex)) {
      return res.status(400).json({ success: false, error: 'INVALID_SIGNED_TX' });
    }
    if (!Array.isArray(clientAllocations)) {
      return res.status(400).json({ success: false, error: 'INVALID_ALLOCATIONS' });
    }

    // 1) Atomic claim — the double-pay mutex. better-sqlite3 is synchronous on a
    //    single connection, so this UPDATE is the linearization point.
    const claimed = db.prepare(`
      UPDATE payment_requests
      SET status = 'paying', paying_started_at = datetime('now')
      WHERE token = ? AND status = 'pending'
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).run(token);
    if (claimed.changes !== 1) {
      const fresh = db.prepare('SELECT status FROM payment_requests WHERE token = ?').get(token) as any;
      if (!fresh) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      const status = fresh.status === 'pending' ? 'expired' : (fresh.status === 'paying' ? 'pending' : fresh.status);
      return res.status(409).json({ success: false, error: 'REQUEST_NOT_PAYABLE', status });
    }

    const row = db.prepare('SELECT * FROM payment_requests WHERE token = ?').get(token) as any;
    const revert = (lastError: string) => {
      db.prepare(`
        UPDATE payment_requests SET status = 'pending', paying_started_at = NULL,
          last_error = ?, last_error_at = datetime('now')
        WHERE token = ? AND status = 'paying'
      `).run(lastError.slice(0, 500), token);
    };

    // 2) Allocation integrity — echoed allocations must match the server-side
    //    preview snapshot exactly, and the snapshot must be fresh (<10 min).
    let stored: { recipients: any[]; allocations: any[] } | null = null;
    try { stored = row.preview_json ? JSON.parse(row.preview_json) : null; } catch { stored = null; }
    const previewFresh = row.preview_at
      && (db.prepare("SELECT (julianday('now') - julianday(?)) * 24 * 60 AS mins").get(row.preview_at) as any).mins < 10;
    if (!stored || !previewFresh || stableStringify(clientAllocations) !== stableStringify(stored.allocations)) {
      revert('PREVIEW_STALE (missing/old/mismatched preview snapshot)');
      return res.status(409).json({ success: false, error: 'PREVIEW_STALE' });
    }

    // 3) Brain purchase — payload built from the ROW (+ the STORED allocations).
    let response: Response;
    let data: any;
    try {
      response = await fetch(`${BRAIN_API_URL}/api/purchase`, {
        method: 'POST',
        headers: brainHeaders(),
        body: JSON.stringify({
          unit_id: row.unit_id,
          payment_type: 'lana',
          customer_hex: customerHex,
          customer_wallet: customerWallet,
          customer_name: customerName,
          amount: row.amount_fiat,
          currency: row.currency,
          invoice_number: row.invoice_number,
          receipt_url: row.receipt_url || undefined,
          receipt_hash: row.receipt_hash || undefined,
          receipt_type: row.receipt_type || undefined,
          receipt_description: row.receipt_description || undefined,
          signed_tx_hex: signedTxHex,
          allocations: stored.allocations,
        }),
      });
      data = await response.json();
    } catch (error: any) {
      // Network-unknown outcome: revert. If the brain DID process it, the next
      // attempt hits the brain (unit_id, invoice_number) dedup → self-heal below.
      console.error('[lana-online] Brain submit network error:', error.message);
      revert(`network: ${error.message}`);
      return res.status(502).json({ success: false, error: 'Failed to reach Brain service' });
    }

    // 4) Success → snapshot paid_* (display-only; the money truth is at brain).
    if (response.ok && data?.success) {
      const { split } = latestSystemParams(db);
      try {
        db.prepare(`
          UPDATE payment_requests SET
            status = 'paid', paid_at = datetime('now'),
            brain_transaction_id = ?, tx_hash = ?,
            paid_lana_lanoshis = ?, paid_exchange_rate = ?, paid_split = ?,
            customer_hex = ?, customer_wallet = ?, customer_name = ?,
            seen_by_merchant = 0, last_error = NULL
          WHERE token = ? AND status = 'paying'
        `).run(
          data.data?.transaction_id || null,
          data.data?.tx_hash || null,
          Number(data.data?.summary?.lana_for_investor) || null,
          Number(data.data?.summary?.exchange_rate) || null,
          split,
          customerHex, customerWallet, customerName || null,
          token
        );
      } catch (e: any) {
        // Payment is REAL at the brain — never fail the customer for local bookkeeping.
        console.error(`[lana-online] CRITICAL: request ${row.id} PAID at brain (tx=${data.data?.transaction_id}) but local update failed: ${e.message}`);
      }
      console.log(`[lana-online] PAID: request ${row.id} unit=${row.unit_id.slice(0, 12)} ${row.amount_fiat} ${row.currency} tx=${(data.data?.tx_hash || '').slice(0, 16)}`);
      return res.json({
        success: true,
        data: {
          txHash: data.data?.tx_hash || data.data?.transaction_id || '',
          transactionId: data.data?.transaction_id || '',
          lanaPaidLanoshis: Number(data.data?.summary?.lana_for_investor) || null,
          exchangeRate: Number(data.data?.summary?.exchange_rate) || null,
        },
      });
    }

    // 5) Brain dedup while WE are mid-'paying' ⇒ a previous attempt for this
    //    request already succeeded at the brain (crash-between). Self-heal.
    if (response.status === 409 && ['DUPLICATE_INVOICE', 'DUPLICATE_RECEIPT_IMAGE'].includes(data?.error)) {
      console.warn(`[lana-online] Request ${row.id}: brain dedup during paying → assuming prior attempt succeeded (${data?.error})`);
      db.prepare(`
        UPDATE payment_requests SET status = 'paid', paid_at = COALESCE(paid_at, datetime('now')),
          customer_hex = COALESCE(customer_hex, ?), customer_wallet = COALESCE(customer_wallet, ?),
          last_error = ?, last_error_at = datetime('now'), seen_by_merchant = 0
        WHERE token = ? AND status = 'paying'
      `).run(customerHex, customerWallet, `assumed paid via brain dedup: ${data?.error}`, token);
      return res.json({ success: true, alreadyPaid: true });
    }

    // 6) Split/rate republished between preview and submit: the brain drift
    //    guard rejects the (now stale) echoed total with a generic 400 prose
    //    message. Map it to a structured code so the page can auto-re-preview.
    const isDrift = response.status === 400 && typeof data?.error === 'string' && /deviates from expected/i.test(data.error);
    revert(`brain ${response.status}: ${data?.error || 'unknown'}`);
    if (isDrift) {
      return res.status(409).json({ success: false, error: 'PREVIEW_STALE', reason: 'rate_changed' });
    }
    console.error('[lana-online] Brain submit rejected:', response.status, JSON.stringify(data).slice(0, 300));
    return res.status(response.status).json(data);
  });

  console.log('[lana-online] Payment-request routes registered');
}
