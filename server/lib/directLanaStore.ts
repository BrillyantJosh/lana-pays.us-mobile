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
 *   superseded   → paid | failed, or back to what it was (unknown, or refused
 *                  with sent = 1) when its replacement is refused before it was
 *                  sent (refuseBeforeSending): a payment that never left
 *                  replaces nothing
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
  /** The sale's receipt photo (26 Nov 2026), or null: none was taken. Never in the plan or the record. */
  receipt_url: string | null;
  receipt_hash: string | null;
  /** What was sold, in the seller's words (26 Nov 2026), or null. Never in the plan or the record. */
  what_sold: string | null;
  plan_json: string;
  replaces_json: string;
  /** What a superseded attempt was before (JSON {status, reason}); null otherwise. */
  superseded_from: string | null;
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

/**
 * Is this receipt photo (the hash of its bytes) already paid in this unit, or
 * carried by another sale that may still be paid? As invoiceNumberTaken: the
 * same receipt is never paid twice (Brilly, 26 Nov 2026), and an attempt of the
 * same sale is the same purchase.
 */
export function receiptTaken(db: Database.Database, unitId: string, receiptHash: string | null | undefined, saleId: string): boolean {
  if (!receiptHash) return false;
  const row = db.prepare(`
    SELECT 1 FROM direct_lana_sales
    WHERE unit_id = ? AND receipt_hash = ? AND sale_id <> ?
      AND (status IN ('validating','broadcasting','sent','unknown','superseded','paid') OR (status = 'refused' AND sent = 1))
    LIMIT 1
  `).get(unitId, receiptHash, saleId);
  return !!row;
}

/**
 * The till's early warning (POST /api/brain/purchase/check-dedup asks the
 * brain, which knows nothing of direct sales): was this photo or this invoice
 * number already paid, or may it still be paid, as LANA neposredno in this
 * unit? The answer has the brain's shape, the earlier sale's time in UTC
 * 'YYYY-MM-DD HH:MM:SS'. The server still refuses at the quote and the submit.
 */
export function directDedupHit(
  db: Database.Database,
  unitId: string,
  probe: { receiptHash?: unknown; invoiceNumber?: unknown },
): { duplicate: true; by: 'receipt_image' | 'invoice'; original_created_at: string } | null {
  if (typeof unitId !== 'string' || !unitId) return null;
  const used = `(status IN ('validating','broadcasting','sent','unknown','superseded','paid') OR (status = 'refused' AND sent = 1))`;
  const when = (t: number) => new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const hash = typeof probe.receiptHash === 'string' && /^[0-9a-f]{64}$/.test(probe.receiptHash) ? probe.receiptHash : '';
  if (hash) {
    const row = db.prepare(`SELECT created_at FROM direct_lana_sales WHERE unit_id = ? AND receipt_hash = ? AND ${used} ORDER BY created_at LIMIT 1`).get(unitId, hash) as { created_at: number } | undefined;
    if (row) return { duplicate: true, by: 'receipt_image', original_created_at: when(row.created_at) };
  }
  const number = typeof probe.invoiceNumber === 'string' ? probe.invoiceNumber.trim() : '';
  if (number) {
    const row = db.prepare(`SELECT created_at FROM direct_lana_sales WHERE unit_id = ? AND invoice_number = ? AND ${used} ORDER BY created_at LIMIT 1`).get(unitId, number) as { created_at: number } | undefined;
    if (row) return { duplicate: true, by: 'invoice', original_created_at: when(row.created_at) };
  }
  return null;
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
  /** The sale's receipt photo, or null (none was taken). */
  receipt?: { url: string; hash: string | null } | null;
  /** What was sold, in the seller's words, or null. */
  whatSold?: string | null;
}

/**
 * Store a new quote. Older quotes of the same sale that were never signed
 * expire with it: one sale shows one quote at a time. `sameCardOnly` (a
 * payment link's sale, whose quotes anybody holding the link may ask for):
 * only this card's older quotes expire, so a stranger's quote never takes
 * the customer's away. An unsigned quote holds nothing: whichever of them is
 * signed and sent first is the one beginValidating lets through.
 */
export function insertQuote(db: Database.Database, a: NewAttempt, nowSec: number, opts: { sameCardOnly?: boolean } = {}): void {
  const p = a.plan;
  db.transaction(() => {
    if (opts.sameCardOnly) {
      db.prepare(`UPDATE direct_lana_sales SET status = 'expired', reason = 'REQUOTED', status_at = ?, updated_at = datetime('now')
        WHERE sale_id = ? AND status = 'quoted' AND payer_address = ?`).run(nowSec, p.sale_id, p.sender);
    } else {
      db.prepare(`UPDATE direct_lana_sales SET status = 'expired', reason = 'REQUOTED', status_at = ?, updated_at = datetime('now')
        WHERE sale_id = ? AND status = 'quoted'`).run(nowSec, p.sale_id);
    }
    db.prepare(`
      INSERT INTO direct_lana_sales (
        id, sale_id, unit_id, owner_hex, seller_hex, payer_address, payer_public_key, card_hex,
        payer_owner_hex, payer_wallet_type, recipient_wallet, recipient_hex, recipient_name,
        currency, invoice_cents, margin_percent, pay_cents, rate, rate_event_id,
        amount_lanoshi, fee_lanoshi, invoice_number, description, receipt_url, receipt_hash, what_sold, plan_json, replaces_json,
        status, sent, created_at, expires_at, status_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', 0, ?, ?, ?)
    `).run(
      p.attempt_id, p.sale_id, p.unit_id, a.owner_hex, a.seller_hex, p.sender, p.public_key, p.card_hex,
      a.payer_owner_hex, a.payer_wallet_type, p.recipient, p.recipient_hex, p.unit_name,
      p.currency, p.invoice_cents, p.margin_percent, p.pay_cents, p.rate, p.rate_event_id,
      p.amount, p.fee, p.invoice_number, a.description, a.receipt?.url ?? null, a.receipt?.hash ?? null, a.whatSold ?? null,
      JSON.stringify(p), JSON.stringify(a.replaces),
      p.created_at, p.expires, nowSec,
    );
  })();
}

/**
 * A quote nobody signed holds nothing, yet its plan carries every coin's whole
 * previous transaction (up to 250,000 characters). Once it has expired that is
 * dead weight, and anybody holding a payment link could pile it up, so the
 * coins' raw bytes are dropped. The plan of an expired quote is never read
 * again (it is read only for a quote, a payment that may still be mined, or
 * one that may be sent again). Returns how many plans were made small.
 */
export function compactExpiredQuotes(db: Database.Database, limit = 200): number {
  const rows = db.prepare(`
    SELECT id, plan_json FROM direct_lana_sales
    WHERE status = 'expired' AND txid IS NULL AND plan_json GLOB '*"raw":"[0-9a-f]*'
    LIMIT ?
  `).all(limit) as Array<{ id: string; plan_json: string }>;
  const write = db.prepare(`UPDATE direct_lana_sales SET plan_json = ?, updated_at = datetime('now') WHERE id = ? AND status = 'expired' AND txid IS NULL`);
  let n = 0;
  for (const r of rows) {
    try {
      const plan = JSON.parse(r.plan_json);
      if (!Array.isArray(plan?.inputs)) continue;
      plan.inputs = plan.inputs.map((c: Record<string, unknown>) => ({ ...c, raw: '' }));
      n += write.run(JSON.stringify(plan), r.id).changes;
    } catch { /* an unreadable plan stays as it is */ }
  }
  return n;
}

/** The attempt was no longer 'quoted' when it was to move: the whole move is undone. */
class NotQuoted extends Error {}

/** Why a move into 'validating' could not be made. */
export type ValidatingRefusal =
  | 'NOT_QUOTED' | 'CARD_PAYMENT_PENDING' | 'SALE_PAYMENT_PENDING' | 'SALE_ALREADY_PAID' | 'INVOICE_USED' | 'RECEIPT_USED' | 'TXID_CONFLICT';

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
 * for its block. The replaced ones become 'superseded' in the same transaction,
 * and keep what they were (superseded_from): the checks that follow may still
 * refuse the replacement before anything is sent, and then they are put back
 * (refuseBeforeSending), because they may still be mined.
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
      if (receiptTaken(db, row.unit_id, row.receipt_hash, row.sale_id)) return { ok: false, why: 'RECEIPT_USED' };
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
        // superseded_from is written from the row as it was (SQLite reads the
        // old values for every expression of one UPDATE).
        db.prepare(`UPDATE direct_lana_sales SET superseded_from = json_object('status', status, 'reason', reason),
            status = 'superseded', reason = ?, status_at = ?, updated_at = datetime('now')
          WHERE id = ? AND (status = 'unknown' OR (status = 'refused' AND sent = 1))`).run(supersededBy(row.id), nowSec, id);
      }
      const moved = db.prepare(`
        UPDATE direct_lana_sales SET status = 'validating', txid = ?, raw_tx = ?, record_json = ?, record_id = ?,
          status_at = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'quoted'
      `).run(signed.txid, signed.raw, JSON.stringify(signed.record), signed.record_id, nowSec, row.id);
      // Thrown, not returned: the attempts superseded above must not stay so.
      if (moved.changes !== 1) throw new NotQuoted();
      return { ok: true };
    })();
  } catch (e: any) {
    if (e instanceof NotQuoted) return { ok: false, why: 'NOT_QUOTED' };
    const text = String(e?.message || e);
    if (!/UNIQUE/i.test(text)) throw e;
    if (/txid/i.test(text)) return { ok: false, why: 'TXID_CONFLICT' };
    if (/payer_address/i.test(text)) return { ok: false, why: 'CARD_PAYMENT_PENDING' };
    return { ok: false, why: 'SALE_PAYMENT_PENDING' };
  }
}

/** The reason a replaced attempt carries: the till reads the id of its replacement from it. */
export const supersededBy = (replacementId: string) => `SUPERSEDED_BY ${replacementId}`;

/**
 * An attempt that never left is refused (validating → refused, sent = 0), and
 * every attempt it was to replace is put back as it was (unknown, or refused
 * with sent = 1), in ONE transaction. A payment that was never sent replaces
 * nothing: the one it would have replaced may still be mined, so its journal
 * row must say so again (and it may be sent again). Only rows still superseded
 * by exactly this attempt are touched; one the sweep has meanwhile found in a
 * block (paid) or spent for good (failed) stays as it is.
 *
 * `restored`: the attempts put back.
 */
export function refuseBeforeSending(
  db: Database.Database,
  id: string,
  code: string,
  nowSec: number,
): { refused: boolean; restored: string[] } {
  return db.transaction(() => {
    if (!move(db, id, ['validating'], 'refused', nowSec, { reason: code, sent: 0 })) return { refused: false, restored: [] };
    const row = db.prepare('SELECT replaces_json FROM direct_lana_sales WHERE id = ?').get(id) as Pick<DirectRow, 'replaces_json'> | undefined;
    const restored: string[] = [];
    for (const old of row ? replacesOf(row) : []) {
      const was = db.prepare(`SELECT superseded_from FROM direct_lana_sales WHERE id = ? AND status = 'superseded' AND reason = ?`)
        .get(old, supersededBy(id)) as { superseded_from: string | null } | undefined;
      if (!was) continue;
      let prev: any = null;
      try { prev = JSON.parse(was.superseded_from || 'null'); } catch { prev = null; }
      // Only ever back to a status in which it may still be mined (it was one).
      const status: DirectStatus = prev?.status === 'refused' ? 'refused' : 'unknown';
      const reason = typeof prev?.reason === 'string' ? prev.reason : 'NO_CLEAR_ANSWER';
      try {
        // Its own savepoint: if putting one back fails, it stays superseded
        // (still holding the card, still settled by the chain) and the
        // refusal of the replacement stands.
        const put = db.transaction(() => db.prepare(`
          UPDATE direct_lana_sales SET status = ?, reason = ?, superseded_from = NULL, status_at = ?, updated_at = datetime('now')
          WHERE id = ? AND status = 'superseded' AND reason = ? AND sent = 1
        `).run(status, reason, nowSec, old, supersededBy(id)).changes)();
        if (put === 1) restored.push(old);
      } catch (e: any) {
        console.error(`[direct-lana] ALERT attempt ${old} stays superseded by ${id}, which was never sent (${e?.message || e}): it may still be mined`);
      }
    }
    return { refused: true, restored };
  })();
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
    what_sold: row.what_sold ?? null,
    receipt_url: row.receipt_url ?? null,
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
