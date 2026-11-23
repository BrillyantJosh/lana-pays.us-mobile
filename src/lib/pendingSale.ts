/**
 * A cash sale of a shop without a company that was SENT but never confirmed
 * (review, 23 Nov 2026).
 *
 * Such a shop has no invoices: the till sends "what was sold (#n, date)" as the
 * invoice number, and the brain's only guard against one cash sale recorded
 * twice is that text (one invoice number once per unit). A till that lost the
 * answer to a sale and then sent the same sale with a new number, or with other
 * words, would have it recorded twice. So once a sale's text has been sent, it
 * is kept here, in this browser, per unit, until one of these:
 *   - the brain confirms the sale (the till shows it confirmed);
 *   - the brain says it already has it (DUPLICATE_INVOICE, or the check below);
 *   - the brain says it does not have it (POST /api/cash-sale-recorded), after
 *     which the seller may change it freely;
 *   - the seller discards it, which also asks the brain first.
 * Until then the till offers that sale again with the same text, after a
 * "Start over", a trip to the home screen, a reload, or a phone that dropped
 * the tab. Nothing here moves money; it only keeps the till from guessing.
 *
 * Kept in localStorage, every access wrapped: in a private window, with blocked
 * site data, or in a test runner without Storage it reads as nothing kept, and
 * the till behaves as it did before (the brain still refuses a repeated text).
 */
import { saleInvoiceNumber, type SaleNumber } from './payoutAccount';

export interface PendingSale {
  v: 1;
  unit_id: string;
  number: number;
  date: string;
  /** What was sold, as the seller typed it. */
  description: string;
  /** The amount field as it was sent. */
  amount: string;
  /** The exact invoice number sent to the brain. */
  text: string;
  /** When it was sent (ms). */
  at: number;
}

const key = (unitId: string) => `lanapays.cashSale.v1.${unitId}`;

/** The sale kept for this unit, or null when none is kept (or it does not read). */
export function readPendingSale(unitId: string | null | undefined): PendingSale | null {
  if (!unitId) return null;
  try {
    const raw = localStorage.getItem(key(unitId));
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || p.v !== 1 || p.unit_id !== unitId) return null;
    if (!Number.isInteger(p.number) || p.number <= 0 || typeof p.date !== 'string' || !/^\d{2}\.\d{2}\.\d{4}$/.test(p.date)) return null;
    if (typeof p.description !== 'string' || !p.description.trim() || typeof p.amount !== 'string' || typeof p.text !== 'string') return null;
    // The text is exactly what this description and number make: nothing else is ever sent for it.
    if (p.text !== saleInvoiceNumber(p.description, { number: p.number, date: p.date })) return null;
    return p as PendingSale;
  } catch {
    return null;
  }
}

/** Keep this sale as sent, right before its text goes to the brain; the sale as kept. */
export function keepPendingSale(unitId: string, sale: SaleNumber, description: string, amount: string): PendingSale {
  const p: PendingSale = {
    v: 1, unit_id: unitId, number: sale.number, date: sale.date, description: description.trim(), amount,
    text: saleInvoiceNumber(description, sale), at: Date.now(),
  };
  try {
    localStorage.setItem(key(unitId), JSON.stringify(p));
  } catch { /* not kept: the till still keeps it while this tab is open */ }
  return p;
}

/** The sale is settled one way or the other: nothing is kept for this unit any more. */
export function forgetPendingSale(unitId: string | null | undefined): void {
  if (!unitId) return;
  try {
    localStorage.removeItem(key(unitId));
  } catch { /* nothing to do */ }
}

/**
 * Has the brain recorded a sale with exactly this text on this unit?
 *   { recorded: true, date }  it has: the sale is done, never send it again
 *   { recorded: false }       it has not: the seller may change or drop it
 *   null                      cannot tell (no answer, any other answer)
 */
export async function saleRecorded(
  unitId: string,
  text: string,
  headers: Record<string, string>,
  staffHex: string | null | undefined,
): Promise<{ recorded: true; createdAt: string | null } | { recorded: false } | null> {
  try {
    const res = await fetch('/api/cash-sale-recorded', {
      method: 'POST',
      headers,
      body: JSON.stringify({ unit_id: unitId, staff_hex: staffHex || undefined, invoice_number: text }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.success !== true) return null;
    if (data.recorded === true) return { recorded: true, createdAt: typeof data.original_created_at === 'string' ? data.original_created_at : null };
    if (data.recorded === false) return { recorded: false };
  } catch { /* cannot tell */ }
  return null;
}
