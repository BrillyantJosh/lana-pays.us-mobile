/**
 * POST /api/brain/purchase/preview, the handler behind the route in index.ts:
 * the brain's read-only preview of a LANA sale. It returns the LANA recipients
 * the till signs for, without committing the purchase.
 *
 * It lives apart from index.ts so a test can run it against a real database and
 * a stub brain, like brainPurchase.ts. The route itself, with its rate limit and
 * its KIND 87058 gate, stays registered in index.ts.
 *
 * A unit without a bank account (lib/noPayoutAccount.ts) is refused here,
 * before the brain is asked and before the customer's key signs anything. An
 * unknown unit is forwarded as before: the brain answers for it.
 */
import type { Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { unitHasNoPayoutAccount, noPayoutAccountRefusal } from './lib/noPayoutAccount.js';

export function brainPreviewHandler(db: Database.Database, BRAIN_API_URL: string, BRAIN_PURCHASE_KEY: string) {
  return async (req: Request, res: Response) => {
    if (!BRAIN_API_URL) {
      return res.status(503).json({ success: false, error: 'Brain service not configured' });
    }

    // One shop, as one string, the same rule as the purchase route: the check
    // below looks at a string, and the body is forwarded as it came.
    const unitId = req.body?.unit_id;
    if (unitId !== undefined && typeof unitId !== 'string') {
      return res.status(400).json({ success: false, error: 'unit_id must be a string' });
    }
    if (unitHasNoPayoutAccount(db, unitId)) {
      console.warn(`[mobile] Blocking LANA preview: unit ${String(unitId).slice(0, 12)} has no bank account (payout_account=none)`);
      return res.status(409).json(noPayoutAccountRefusal());
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
  };
}
