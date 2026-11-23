/**
 * The journal of direct LANA sales (table direct_lana_sales, db/schema.ts):
 * reading attempts, and moving them from one status to the next.
 *
 * Every move is ONE guarded UPDATE: it names the statuses it may move from, so
 * two requests or a request and the sweep can never both move one attempt, and
 * no attempt ever moves backwards. The allowed moves:
 *
 *   quoted       → validating | expired
 *   validating   → broadcasting | refused (sent = 0)
 *   broadcasting → sent | unknown | refused (sent = 1)
 *   sent         → paid | failed | unknown (lost from both servers, coins unspent)
 *   unknown      → sent | paid | failed | superseded
 *   refused      → sent | paid | failed | superseded   (only when sent = 1)
 *   superseded   → paid | failed
 *   paid, failed, expired, refused with sent = 0: final
 */
import type Database from 'better-sqlite3';
import type { DirectLanaPlan } from './directLanaCore.js';

export type DirectStatus =
  | 'quoted' | 'validating' | 'broadcasting' | 'sent' | 'paid'
  | 'unknown' | 'refused' | 'superseded' | 'failed' | 'expired';

export interface DirectRow {
  id: string;
  sale_id: string;
  unit_id: string;
  owner_hex: string;
  seller_hex: string;
  payer_address: string;
  payer_public_key: string;
  card_hex: string;
  payer_owner_hex: string;
  payer_wallet_type: string;
  recipient_wallet: string;
  recipient_hex: string;
  recipient_name: string;
  currency: string;
  invoice_cents: string;
  margin_percent: number;
  pay_cents: string;
  rate: string;
  rate_event_id: string;
  amount_lanoshi: string;
  fee_lanoshi: string;
  invoice_number: string;
  description: string;
  plan_json: string;
  replaces_json: string;
  txid: string | null;
  raw_tx: string | null;
  record_json: string | null;
  record_id: string | null;
  status: DirectStatus;
  sent: number;
  reason: string | null;
  broadcast_results: string | null;
  paid_height: number | null;
  record_published: number;
  record_published_at: string | null;
  record_relays: string;
  created_at: number;
  expires_at: number;
  status_at: number;
  checked_at: number | null;
}

/** Statuses in which a payment may still be mined, so its card is held. */
export const HOLDING: DirectStatus[] = ['validating', 'broadcasting', 'sent', 'unknown', 'superseded'];

/** May this attempt still end up in a block? (A refusal counts only once it was sent.) */
export function mayStillBeMined(row: Pick<DirectRow, 'status' | 'sent'>): boolean {
  return HOLDING.includes(row.status) || (row.status === 'refused' && row.sent === 1);
}

export const getAttempt = (db: Database.Database, id: unknown): DirectRow | undefined =>
  typeof id === 'string' && /^dla_[0-9a-f]{32}$/.test(id)
    ? (db.prepare('SELECT * FROM direct_lana_sales WHERE id = ?').get(id) as DirectRow | undefined)
    : undefined;

export const attemptsOfSale = (db: Database.Database, saleId: string): DirectRow[] =>
  db.prepare('SELECT * FROM direct_lana_sales WHERE sale_id = ? ORDER BY created_at, id').all(saleId) as DirectRow[];

/** Every attempt from this card address that may still be mined. */
export const heldByCard = (db: Database.Database, address: string): DirectRow[] =>
  (db.prepare(`
    SELECT * FROM direct_lana_sales
    WHERE payer_address = ? AND (status IN ('validating','broadcasting','sent','unknown','superseded') OR (status = 'refused' AND sent = 1))
    ORDER BY created_at, id
  `).all(address) as DirectRow[]);

/**
 * Is this invoice number already paid in this unit, or carried by another
 * sale that may still be paid? An attempt of the same sale does not count: it
 * is the same purchase, and its coins are shared with this one.
 */
export function invoiceNumberTaken(db: Database.Database, unitId: string, invoiceNumber: string, saleId: string): boolean {
  if (!invoiceNumber) return false;
  const row = db.prepare(`
    SELECT 1 FROM direct_lana_sales
    WHERE unit_id = ? AND invoice_number = ? AND sale_id <> ?
      AND (status IN ('validating','broadcasting','sent','unknown','superseded','paid') OR (status = 'refused' AND sent = 1))
    LIMIT 1
  `).get(unitId, invoiceNumber, saleId);
  return !!row;
}

export const planOf = (row: Pick<DirectRow, 'plan_json'>): DirectLanaPlan => JSON.parse(row.plan_json) as DirectLanaPlan;

export interface NewAttempt {
  plan: DirectLanaPlan;
  owner_hex: string;
  seller_hex: string;
  payer_owner_hex: string;
  payer_wallet_type: string;
  description: string;
  replaces: string[];
}

/**
 * Store a new quote. Older quotes of the same sale that were never signed
 * expire with it: one sale shows one quote at a time.
 */
export function insertQuote(db: Database.Database, a: NewAttempt, nowSec: number): void {
  const p = a.plan;
  db.transaction(() => {
    db.prepare(`UPDATE direct_lana_sales SET status = 'expired', reason = 'REQUOTED', status_at = ?, updated_at = datetime('now')
      WHERE sale_id = ? AND status = 'quoted'`).run(nowSec, p.sale_id);
    db.prepare(`
      INSERT INTO direct_lana_sales (
        id, sale_id, unit_id, owner_hex, seller_hex, payer_address, payer_public_key, card_hex,
        payer_owner_hex, payer_wallet_type, recipient_wallet, recipient_hex, recipient_name,
        currency, invoice_cents, margin_percent, pay_cents, rate, rate_event_id,
        amount_lanoshi, fee_lanoshi, invoice_number, description, plan_json, replaces_json,
        status, sent, created_at, expires_at, status_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', 0, ?, ?, ?)
    `).run(
      p.attempt_id, p.sale_id, p.unit_id, a.owner_hex, a.seller_hex, p.sender, p.public_key, p.card_hex,
      a.payer_owner_hex, a.payer_wallet_type, p.recipient, p.recipient_hex, p.unit_name,
      p.currency, p.invoice_cents, p.margin_percent, p.pay_cents, p.rate, p.rate_event_id,
      p.amount, p.fee, p.invoice_number, a.description, JSON.stringify(p), JSON.stringify(a.replaces),
      p.created_at, p.expires, nowSec,
    );
  })();
}

/** Why a move into 'validating' could not be made. */
export type ValidatingRefusal =
  | 'NOT_QUOTED' | 'CARD_PAYMENT_PENDING' | 'SALE_PAYMENT_PENDING' | 'SALE_ALREADY_PAID' | 'INVOICE_USED' | 'TXID_CONFLICT';

/** The attempts a quote replaces: each of them shares at least one coin with it. */
export function replacesOf(row: Pick<DirectRow, 'replaces_json'>): string[] {
  try {
    const list = JSON.parse(row.replaces_json || '[]');
    return Array.isArray(list) ? list.filter((x: unknown): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Keep the signed bytes and the signed record, and move the attempt to
 * 'validating', in ONE transaction, BEFORE anything is sent.
 *
 * THE REPLACEMENT RULE (Brilly's default, 23 Nov 2026). An attempt that may
 * still be mined (unknown, refused after it was sent, superseded) can be
 * replaced only by a payment that spends at least one of its coins, so at most
 * one of the two can ever be in a block. The quote proved that for every
 * attempt it lists in `replaces`. Here, every OTHER attempt from the same card
 * or of the same sale that may still be mined must be in that list, or nothing
 * moves; one that is 'sent' (or on its way) is never replaced: the card waits
 * for its block. The replaced ones become 'superseded' in the same transaction.
 * The unique indexes refuse a second unresolved payment of the card or of the
 * sale, and a txid stored twice, even if two requests race here.
 */
export function beginValidating(
  db: Database.Database,
  row: DirectRow,
  signed: { txid: string; raw: string; record: unknown; record_id: string },
  nowSec: number,
): { ok: true } | { ok: false; why: ValidatingRefusal } {
  const replaces = replacesOf(row);
  type Out = { ok: true } | { ok: false; why: ValidatingRefusal };
  try {
    return db.transaction((): Out => {
      const fresh = db.prepare('SELECT status FROM direct_lana_sales WHERE id = ?').get(row.id) as { status: string } | undefined;
      if (fresh?.status !== 'quoted') return { ok: false, why: 'NOT_QUOTED' };
      if (db.prepare("SELECT 1 FROM direct_lana_sales WHERE sale_id = ? AND status = 'paid' LIMIT 1").get(row.sale_id)) {
        return { ok: false, why: 'SALE_ALREADY_PAID' };
      }
      if (invoiceNumberTaken(db, row.unit_id, row.invoice_number, row.sale_id)) return { ok: false, why: 'INVOICE_USED' };
      const others = db.prepare(`
        SELECT id, sale_id, payer_address, status, sent FROM direct_lana_sales
        WHERE id <> ? AND (payer_address = ? OR sale_id = ?)
          AND (status IN ('validating','broadcasting','sent','unknown','superseded') OR (status = 'refused' AND sent = 1))
      `).all(row.id, row.payer_address, row.sale_id) as Array<{ id: string; sale_id: string; payer_address: string; status: string; sent: number }>;
      for (const o of others) {
        const live = o.status === 'validating' || o.status === 'broadcasting' || o.status === 'sent';
        if (live || !replaces.includes(o.id)) {
          return { ok: false, why: o.sale_id === row.sale_id ? 'SALE_PAYMENT_PENDING' : 'CARD_PAYMENT_PENDING' };
        }
      }
      for (const id of replaces) {
        db.prepare(`UPDATE direct_lana_sales SET status = 'superseded', reason = ?, status_at = ?, updated_at = datetime('now')
          WHERE id = ? AND (status = 'unknown' OR (status = 'refused' AND sent = 1))`).run(`SUPERSEDED_BY ${row.id}`, nowSec, id);
      }
      const moved = db.prepare(`
        UPDATE direct_lana_sales SET status = 'validating', txid = ?, raw_tx = ?, record_json = ?, record_id = ?,
          status_at = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'quoted'
      `).run(signed.txid, signed.raw, JSON.stringify(signed.record), signed.record_id, nowSec, row.id);
      if (moved.changes !== 1) return { ok: false, why: 'NOT_QUOTED' };
      return { ok: true };
    })();
  } catch (e: any) {
    const text = String(e?.message || e);
    if (!/UNIQUE/i.test(text)) throw e;
    if (/txid/i.test(text)) return { ok: false, why: 'TXID_CONFLICT' };
    if (/payer_address/i.test(text)) return { ok: false, why: 'CARD_PAYMENT_PENDING' };
    return { ok: false, why: 'SALE_PAYMENT_PENDING' };
  }
}

/** One guarded move. True when this call made it. */
export function move(
  db: Database.Database,
  id: string,
  from: DirectStatus[],
  to: DirectStatus,
  nowSec: number,
  extra: { reason?: string | null; sent?: 0 | 1; broadcast_results?: string; paid_height?: number; fromSent?: 0 | 1 } = {},
): boolean {
  const sets = ['status = ?', 'status_at = ?', "updated_at = datetime('now')"];
  const values: unknown[] = [to, nowSec];
  if (extra.reason !== undefined) { sets.push('reason = ?'); values.push(extra.reason); }
  if (extra.sent !== undefined) { sets.push('sent = ?'); values.push(extra.sent); }
  if (extra.broadcast_results !== undefined) { sets.push('broadcast_results = ?'); values.push(extra.broadcast_results); }
  if (extra.paid_height !== undefined) { sets.push('paid_height = ?'); values.push(extra.paid_height); }
  const where = [`id = ?`, `status IN (${from.map(() => '?').join(',')})`];
  values.push(id, ...from);
  if (extra.fromSent !== undefined) { where.push('sent = ?'); values.push(extra.fromSent); }
  const r = db.prepare(`UPDATE direct_lana_sales SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`).run(...values);
  return r.changes === 1;
}

/** What the till sees of one attempt. No key, no raw bytes, nobody's name. */
export function attemptView(row: DirectRow) {
  return {
    attempt_id: row.id,
    sale_id: row.sale_id,
    unit_id: row.unit_id,
    status: row.status,
    sent: row.sent === 1,
    reason: row.reason,
    txid: row.status === 'quoted' ? null : row.txid,
    currency: row.currency,
    invoice_cents: row.invoice_cents,
    margin_percent: row.margin_percent,
    pay_cents: row.pay_cents,
    rate: row.rate,
    amount_lanoshi: row.amount_lanoshi,
    fee_lanoshi: row.fee_lanoshi,
    invoice_number: row.invoice_number,
    recipient_wallet: row.recipient_wallet,
    recipient_name: row.recipient_name,
    payer_address: row.payer_address,
    paid_height: row.paid_height,
    record_published: row.record_published === 1,
    created_at: row.created_at,
    expires_at: row.expires_at,
    status_at: row.status_at,
  };
}
