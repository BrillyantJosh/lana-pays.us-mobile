/**
 * POST /api/brain/purchase, the handler behind the route in index.ts: what the
 * till sends on its way to the brain. It lives apart from index.ts so a test can
 * run it, against a real database and a stub brain, instead of reading it as text.
 *
 * The route itself, with its rate limit and its KIND 87058 gate, stays
 * registered in index.ts.
 */
import type { Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { getMaxTransaction, foldQuotaRemaining, foldCustomerWindow, readCustomerWindowDays, clampCashAmount, round2 } from './lib/maxTransaction.js';

export function brainPurchaseHandler(db: Database.Database, BRAIN_API_URL: string, BRAIN_PURCHASE_KEY: string) {
  return async (req: Request, res: Response) => {
    if (!BRAIN_API_URL) {
      return res.status(503).json({ success: false, error: 'Brain service not configured' });
    }

    // ── Split in progress → CASH is blocked (LANA is fine). Mobile-local flag
    // (app_settings.split_happening) — the same one the POS reads via
    // /api/system-params. Backstop for the disabled cash button. ──
    if (String(req.body?.payment_type) === 'cash') {
      const sh = db.prepare("SELECT value FROM app_settings WHERE key = 'split_happening'").get() as any;
      if (sh?.value === 'true') {
        const until = db.prepare("SELECT value FROM app_settings WHERE key = 'split_happening_until'").get() as any;
        return res.status(403).json({
          success: false,
          error: 'SPLIT_HAPPENING',
          message: 'Cash payments are disabled while a Split is in progress. Please pay with LANA.',
          // The same deadline the POS shows on the button, so a client that only
          // ever sees this refusal can say when it ends too.
          until: until?.value ? String(until.value) : null,
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
            let effMax = foldQuotaRemaining(limits.max_amount, u, reqCurrency);

            // ── PER-CUSTOMER ROLLING WINDOW (owner rule, 2026-08-04). The same
            // customer may buy repeatedly at this shop, but the SUM of their
            // CASH purchases within the last N days must not exceed the shop's
            // transaction limit. The history lives only in the brain, so we ask
            // it; FAIL-OPEN on any read failure — a lookup must never stop a
            // sale at the till. Known residual race: two truly simultaneous
            // purchases can both pass this pre-flight; the brain counts
            // 'created' rows immediately, so the exposure is same-instant only.
            const custHex = String(req.body?.customer_hex || '');
            const custWallet = String(req.body?.customer_wallet || '');
            const windowCurrency = (reqCurrency || limits.currency).toUpperCase();
            if (BRAIN_API_URL && (custHex || custWallet)
                && limits.max_amount !== null && limits.max_amount > 0
                && windowCurrency === limits.currency) {
              const windowDays = readCustomerWindowDays(db);
              try {
                const params = new URLSearchParams({ unit_id: unitId, currency: windowCurrency, days: String(windowDays) });
                if (custHex) params.set('customer_hex', custHex);
                if (custWallet) params.set('customer_wallet', custWallet);
                const wRes = await fetch(`${BRAIN_API_URL}/api/purchase/customer-window?${params}`, {
                  headers: BRAIN_PURCHASE_KEY ? { Authorization: `Bearer ${BRAIN_PURCHASE_KEY}` } : {},
                  signal: AbortSignal.timeout(2500),
                });
                if (wRes.ok) {
                  const w = await wRes.json() as any;
                  const spent = round2(Number(w?.spent || 0));
                  const customerRemaining = round2(Math.max(0, limits.max_amount - spent));
                  if (customerRemaining <= 0) {
                    console.warn(`[mobile] Blocking CASH pre-flight: unit=${unitId.slice(0, 12)} customer window used up (spent ${spent}/${limits.max_amount} in ${windowDays}d)`);
                    return res.status(403).json({
                      success: false,
                      error: 'CUSTOMER_WINDOW_EXCEEDED',
                      message: `Customer reached the ${limits.max_amount.toFixed(2)} ${windowCurrency} cash limit for the last ${windowDays} day(s) — already spent ${spent.toFixed(2)}. Sell for LANA instead.`,
                      spent,
                      limit: limits.max_amount,
                      days: windowDays,
                      currency: windowCurrency,
                    });
                  }
                  effMax = foldCustomerWindow(effMax, customerRemaining);
                } else {
                  console.warn(`[mobile] customer-window check skipped (fail-open): brain ${wRes.status}${wRes.status === 404 ? ' — older brain without the endpoint' : ''}`);
                }
              } catch (e: any) {
                console.warn(`[mobile] customer-window check failed (fail-open): ${e?.message || e}`);
              }
            }

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
  };
}
