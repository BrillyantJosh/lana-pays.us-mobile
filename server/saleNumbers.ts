/**
 * Automatic sale numbers for shops without a company (Brilly, 23 Nov 2026).
 *
 * A shop without a company and without a bank account (KIND 30901
 * payout_account "none") issues no invoices. At the till the seller says what
 * was sold, and the till adds this unit's next sale number to it. The brain
 * refuses a sale whose (unit, invoice_number) is already used: that is its
 * backstop against one sale being funded twice. Without the number, a seller
 * who sells "eggs" twice would be refused the second time.
 *
 * The number is handed out ONCE per sale, and the till keeps it for every retry
 * of that sale (CashTab), and once its text was sent, in the browser until the
 * sale is settled (src/lib/pendingSale.ts), so a reload or a trip home does not
 * make a second number for it. A retry after a lost answer therefore sends the
 * same text, and the brain's rule still refuses one sale recorded twice.
 * POST /api/cash-sale-recorded (below) tells the till what the brain has.
 *
 * One counter per unit, kept here, so two phones selling for the same shop never
 * get the same number. A number given to a sale that is then refused or
 * abandoned is just not used: numbers can have gaps, never repeats. The day the
 * number was handed out is part of the text the till sends, so even a counter
 * restored from an older backup cannot repeat the text of another day.
 *
 * Nothing here moves or prices money. The number is a label on a cash sale.
 */
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { gateNames } from './lib/exclusionGate.js';
import { unitForMerchant } from './lib/merchantAuth.js';
import { unitHasNoPayoutAccount } from './lib/noPayoutAccount.js';

/**
 * The next sale number of this unit: 1, 2, 3, ... One SQL statement, and
 * better-sqlite3 runs one statement at a time on its connection, so two calls
 * never get the same number.
 */
export function allocateSaleNumber(db: Database.Database, unitId: string): number {
  const row = db.prepare(`
    INSERT INTO unit_sale_numbers (unit_id, last_number, updated_at) VALUES (?, 1, datetime('now'))
    ON CONFLICT(unit_id) DO UPDATE SET last_number = unit_sale_numbers.last_number + 1, updated_at = datetime('now')
    RETURNING last_number
  `).get(unitId) as { last_number: number };
  return row.last_number;
}

/**
 * The day a number was handed out, written the way the shops write a date
 * (DD.MM.YYYY), in Slovenian time. The server's own clock runs in UTC.
 */
export function saleNumberDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Ljubljana', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('day')}.${part('month')}.${part('year')}`;
}

/** Why a number is not handed out to a unit that has a bank account. */
export const SALE_NUMBER_NOT_USED = 'SALE_NUMBER_NOT_USED';

/** The text a till sends for such a sale ends in its number and day (src/lib/payoutAccount.ts saleInvoiceNumber). */
const SALE_TEXT = /^.{1,100} \(#[1-9]\d{0,9}, \d{2}\.\d{2}\.\d{4}\)$/s;

/** Where the brain is asked; a test passes its own. */
export interface SaleRecordedDeps {
  brainUrl?: string;
  brainKey?: string;
  fetchImpl?: typeof fetch;
}

export function registerSaleNumberRoutes(app: Express, db: Database.Database, deps: SaleRecordedDeps = {}): void {
  /**
   * POST /api/cash-sale-number { unit_id, staff_hex }
   * → { success, number, date } for the owner or staff of a unit without a
   * company. The person holding the till is named in `staff_hex` and in
   * x-lana-hex (both asked by the KIND 87058 gate); the shop by its unit.
   */
  app.post('/api/cash-sale-number', gateNames(db, req => ({
    hex: [req.body?.staff_hex, req.headers?.['x-lana-hex']],
    unit: [req.body?.unit_id],
  })), (req, res) => {
    const unitId = req.body?.unit_id;
    if (typeof unitId !== 'string' || unitId === '') {
      return res.status(400).json({ success: false, error: 'unit_id must be a string' });
    }
    // Only the unit's owner or staff, on an active unit of this app (the same
    // rule as the payment requests).
    const hex = String(req.body?.staff_hex || req.headers?.['x-lana-hex'] || '');
    const unit = unitForMerchant(db, hex, unitId);
    if (!unit) return res.status(403).json({ success: false, error: 'NOT_AUTHORIZED' });
    // A shop with a company has invoices of its own: its numbers come from them.
    if (!unitHasNoPayoutAccount(db, unit.unit_id)) {
      return res.status(409).json({
        success: false,
        code: SALE_NUMBER_NOT_USED,
        error: 'Only a shop without a company gets an automatic sale number.',
      });
    }
    const number = allocateSaleNumber(db, unit.unit_id);
    res.json({ success: true, number, date: saleNumberDate() });
  });

  /**
   * POST /api/cash-sale-recorded { unit_id, staff_hex, invoice_number }
   * → { success, recorded } : has the brain recorded a sale with exactly this
   * text on this unit? Asked by the till of a shop without a company about a
   * sale it sent but never heard back about (the answer was lost, the tab was
   * closed or reloaded), before it lets the seller start that sale again with
   * other words or another number: the brain's only guard against one cash
   * sale recorded twice is the text, so a till that guesses records it twice.
   *
   * It answers only what the brain answered. When the brain cannot be asked,
   * or answers anything else, it is 503 and the till keeps the sale as it was
   * (the same text, which the brain refuses if it has it). The old pre-check
   * /api/brain/purchase/check-dedup answers "no duplicate" when the brain
   * cannot be reached, which is right for a hint and wrong for this question.
   */
  app.post('/api/cash-sale-recorded', gateNames(db, req => ({
    hex: [req.body?.staff_hex, req.headers?.['x-lana-hex']],
    unit: [req.body?.unit_id],
  })), async (req, res) => {
    const unitId = req.body?.unit_id;
    const text = typeof req.body?.invoice_number === 'string' ? req.body.invoice_number.trim() : '';
    if (typeof unitId !== 'string' || unitId === '' || !SALE_TEXT.test(text)) {
      return res.status(400).json({ success: false, error: 'unit_id and the sale text are required' });
    }
    const hex = String(req.body?.staff_hex || req.headers?.['x-lana-hex'] || '');
    const unit = unitForMerchant(db, hex, unitId);
    if (!unit) return res.status(403).json({ success: false, error: 'NOT_AUTHORIZED' });
    if (!unitHasNoPayoutAccount(db, unit.unit_id)) {
      return res.status(409).json({ success: false, code: SALE_NUMBER_NOT_USED, error: 'Only a shop without a company gets an automatic sale number.' });
    }
    const url = deps.brainUrl ?? process.env.BRAIN_API_URL ?? '';
    const key = deps.brainKey ?? process.env.BRAIN_PURCHASE_KEY ?? '';
    const cannotTell = () => res.status(503).json({ success: false, code: 'BRAIN_UNAVAILABLE', error: 'The brain could not be asked. Try again.' });
    if (!url) return cannotTell();
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (key) headers.Authorization = `Bearer ${key}`;
      const answer = await (deps.fetchImpl ?? fetch)(`${url}/api/purchase/check-dedup`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ unit_id: unit.unit_id, invoice_number: text }),
      });
      if (!answer.ok) return cannotTell();
      const data: any = await answer.json();
      if (data?.duplicate === true && data?.by === 'invoice') {
        return res.json({ success: true, recorded: true, original_created_at: typeof data.original_created_at === 'string' ? data.original_created_at : null });
      }
      if (data?.duplicate === false) return res.json({ success: true, recorded: false });
      return cannotTell();
    } catch {
      return cannotTell();
    }
  });
}
