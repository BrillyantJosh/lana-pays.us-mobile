/**
 * Payment links of LANA neposredno (Brilly, 25 Nov 2026): the seller of a shop
 * without a company makes a link at the till and sends it; the customer opens
 * it at home and pays from their own card, in their own browser, straight into
 * the shop's wallet, NOT through the brain (server/directLana.ts).
 *
 * ONE LINK IS ONE SALE of the direct LANA journal (table direct_lana_sales,
 * lib/directLanaStore.ts): its sale_id is made with the link, and every payment
 * of the link is an attempt of that sale, quoted, signed, checked, sent and
 * settled by exactly the code the till uses. So everything the till holds to
 * holds here too: one paid attempt per sale, one payment that may still be mined
 * per sale and per card, a replacement only with one of the same coins, a
 * payment resolved by the chain and never by time, the record published only
 * once the payment is in a block.
 *
 * WHAT THE LINK FIXES when it is made: the shop, the invoice amount, the margin
 * (the shop's at that moment: the customer pays what the link says), the
 * invoice number and the seller's note. WHAT IT DOES NOT FIX: the LANA. They
 * are priced when the customer pays, at the verified KIND 38888 price of that
 * moment, as at the till. The shop's wallet and owner are read fresh at every
 * quote and submit, as at the till.
 *
 * THE TOKEN (24 random bytes, base64url) is the customer's capability: whoever
 * holds the link may pay it, from their own card. It is never a key to anything
 * else. The link page shows no card address and no key of anybody.
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { type DirectRow, attemptsOfSale, mayStillBeMined } from './directLanaStore.js';
import { centsText, withMargin } from './directLanaCore.js';

export type LinkStatus = 'open' | 'paid' | 'cancelled' | 'expired';

export interface LinkRow {
  id: string;
  token: string;
  sale_id: string;
  unit_id: string;
  seller_hex: string;
  owner_hex: string;
  unit_name: string;
  currency: string;
  invoice_cents: string;
  margin_percent: number;
  invoice_number: string;
  note: string | null;
  status: LinkStatus;
  created_at: number;
  expires_at: number | null;
  paid_attempt_id: string | null;
  paid_at: number | null;
  cancelled_at: number | null;
  seen_by_seller: number;
  updated_at: string;
}

/** The validity of a new link: the setting of every payment link (Lana-online too), 168 h; 0 = never. */
export const LINK_EXPIRY_SETTING = 'payment_request_expiry_hours';

export const newLinkId = () => `dll_${crypto.randomBytes(16).toString('hex')}`;
/** 24 bytes, base64url: 32 characters. */
export const newLinkToken = () => crypto.randomBytes(24).toString('base64url');
export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export const linkByToken = (db: Database.Database, token: unknown): LinkRow | undefined =>
  typeof token === 'string' && TOKEN_RE.test(token)
    ? (db.prepare('SELECT * FROM direct_lana_links WHERE token = ?').get(token) as LinkRow | undefined)
    : undefined;

export const linkById = (db: Database.Database, id: unknown): LinkRow | undefined =>
  typeof id === 'string' && /^dll_[0-9a-f]{32}$/.test(id)
    ? (db.prepare('SELECT * FROM direct_lana_links WHERE id = ?').get(id) as LinkRow | undefined)
    : undefined;

/** Hours a new link is valid for (0 = never), from the shared setting. */
export function linkExpiryHours(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(LINK_EXPIRY_SETTING) as { value?: string } | undefined;
    const hours = parseInt(String(row?.value ?? '168'), 10);
    return Number.isFinite(hours) && hours > 0 ? hours : 0;
  } catch {
    return 168;
  }
}

/** Does this sale have a payment that may still be mined (on its way, sent, being checked)? */
export const saleInFlight = (attempts: DirectRow[]): boolean => attempts.some(a => mayStillBeMined(a));

/**
 * The link as the chain and the clock say it is now, written back:
 *   - a sale with a paid attempt makes the link paid (whatever it was: a
 *     payment in flight when it expired may still land, and then it is paid);
 *   - an open link past its time, with no payment that may still be mined, is
 *     expired. One with a payment in flight stays open until the chain decides.
 */
export function syncLink(db: Database.Database, link: LinkRow, nowSec: number): LinkRow {
  const attempts = attemptsOfSale(db, link.sale_id);
  const paid = attempts.find(a => a.status === 'paid');
  if (paid && link.status !== 'paid') {
    db.prepare(`UPDATE direct_lana_links SET status = 'paid', paid_attempt_id = ?, paid_at = ?, seen_by_seller = 0, updated_at = datetime('now')
      WHERE id = ? AND status <> 'paid'`).run(paid.id, paid.status_at || nowSec, link.id);
  } else if (!paid && link.status === 'open' && link.expires_at !== null && link.expires_at < nowSec && !saleInFlight(attempts)) {
    db.prepare(`UPDATE direct_lana_links SET status = 'expired', updated_at = datetime('now') WHERE id = ? AND status = 'open'`).run(link.id);
  }
  return db.prepare('SELECT * FROM direct_lana_links WHERE id = ?').get(link.id) as LinkRow;
}

/** The same for every link at once (the sweep). Returns how many links changed. */
export function syncAllLinks(db: Database.Database, nowSec: number): { paid: number; expired: number } {
  const paid = db.prepare(`
    UPDATE direct_lana_links SET status = 'paid',
      paid_attempt_id = (SELECT s.id FROM direct_lana_sales s WHERE s.sale_id = direct_lana_links.sale_id AND s.status = 'paid' ORDER BY s.status_at LIMIT 1),
      paid_at = COALESCE((SELECT s.status_at FROM direct_lana_sales s WHERE s.sale_id = direct_lana_links.sale_id AND s.status = 'paid' ORDER BY s.status_at LIMIT 1), ?),
      seen_by_seller = 0, updated_at = datetime('now')
    WHERE status <> 'paid' AND EXISTS (SELECT 1 FROM direct_lana_sales s WHERE s.sale_id = direct_lana_links.sale_id AND s.status = 'paid')
  `).run(nowSec).changes;
  const expired = db.prepare(`
    UPDATE direct_lana_links SET status = 'expired', updated_at = datetime('now')
    WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM direct_lana_sales s WHERE s.sale_id = direct_lana_links.sale_id
          AND (s.status IN ('validating','broadcasting','sent','unknown','superseded','paid') OR (s.status = 'refused' AND s.sent = 1))
      )
  `).run(nowSec).changes;
  return { paid, expired };
}

/**
 * The payment a link shows: the paid one; otherwise the newest that may still
 * be mined; otherwise the newest that failed for good (a page that was waiting
 * on it learns how it ended; the link is open for a new try); otherwise none.
 * A quote, or a try refused before it was sent, is never shown: nothing of it
 * moved, and on somebody else's screen it would read as a payment under way.
 */
export function linkPayment(db: Database.Database, link: LinkRow): DirectRow | null {
  const attempts = attemptsOfSale(db, link.sale_id);
  const paid = attempts.find(a => a.status === 'paid');
  if (paid) return paid;
  const live = attempts.filter(a => mayStillBeMined(a));
  if (live.length) return live[live.length - 1];
  const failed = attempts.filter(a => a.status === 'failed');
  return failed.length ? failed[failed.length - 1] : null;
}

/**
 * What the link is for the person looking at it:
 *   paid       a payment of it is in a block
 *   paying     a payment of it may still be mined (being sent, sent, being checked)
 *   open, cancelled, expired  as stored
 */
export function linkStatusOf(link: LinkRow, payment: DirectRow | null): 'open' | 'paying' | 'paid' | 'cancelled' | 'expired' {
  if (link.status === 'paid' || payment?.status === 'paid') return 'paid';
  if (payment && mayStillBeMined(payment)) return 'paying';
  return link.status;
}

/** The amounts of a link, as exact strings. */
export function linkAmounts(link: Pick<LinkRow, 'invoice_cents' | 'margin_percent'>) {
  const invoice = BigInt(link.invoice_cents);
  const pay = withMargin(invoice, link.margin_percent);
  return {
    invoice_cents: link.invoice_cents,
    invoice: centsText(invoice),
    margin_percent: link.margin_percent,
    margin: centsText(pay - invoice),
    pay_cents: pay.toString(),
    total: centsText(pay),
  };
}

/**
 * What the CUSTOMER's page sees of a payment: what it is and whether it went.
 * Never the card's address (the page is open to whoever holds the link), never
 * a key, never the raw bytes.
 */
export function publicAttemptView(row: DirectRow) {
  return {
    attempt_id: row.id,
    sale_id: row.sale_id,
    status: row.status,
    sent: row.sent === 1,
    reason: row.reason,
    txid: row.status === 'quoted' || row.status === 'expired' || (row.status === 'refused' && row.sent !== 1) ? null : row.txid,
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
    paid_height: row.paid_height,
    record_published: row.record_published === 1,
    created_at: row.created_at,
    expires_at: row.expires_at,
    status_at: row.status_at,
  };
}

/** An answer about an attempt, made fit for the customer's page: the card's address is taken out. */
export function forCustomer<T extends Record<string, unknown>>(body: T): T {
  if (!body || typeof body !== 'object') return body;
  const { payer_address: _hidden, ...rest } = body as any;
  void _hidden;
  return rest as T;
}

/** What the SELLER sees of a link: the link itself, its amounts and its payment. */
export function sellerLinkView(link: LinkRow, payment: DirectRow | null, attemptView: (r: DirectRow) => unknown) {
  return {
    id: link.id,
    token: link.token,
    path: `/pay-direct/${link.token}`,
    sale_id: link.sale_id,
    unit_id: link.unit_id,
    unit_name: link.unit_name,
    currency: link.currency,
    ...linkAmounts(link),
    invoice_number: link.invoice_number,
    note: link.note,
    status: linkStatusOf(link, payment),
    created_at: link.created_at,
    expires_at: link.expires_at,
    paid_at: link.paid_at,
    seen: link.seen_by_seller === 1,
    payment: payment ? attemptView(payment) : null,
  };
}
