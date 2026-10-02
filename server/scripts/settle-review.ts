/**
 * Brilly's review of the older 'paid' orders that SPEC v1.1.2 step 5 does not
 * pay (shop_order_settle_review — round 3, 2 Oct 2026). Run by hand on the
 * server, in the app's container (it opens the app's own SQLite file):
 *
 *   npx tsx server/scripts/settle-review.ts list
 *   npx tsx server/scripts/settle-review.ts confirm <order_id> <order_event_id>
 *
 * `list` prints every open entry — ids, amounts and the stored lines (listing
 * address, qty, unit price), no buyer data. Check each against what the
 * broker took and checked at order time (shop.lanapays.us: shop_order_items
 * and shop_orders.total of that order id, and its 36520 event id).
 *
 * `confirm` makes the purchase the older rules had paid the order with the
 * step-5a pin of exactly that 36520 event (orderSync.confirmSettleReview). It
 * is refused when the buyer has replaced the order since, or the event id is
 * not the stored one; and it pays only while the NEWEST version of that 30933
 * still pays that amount — a cancellation un-pays it as it un-pays every pin.
 * The app never calls it.
 */
import { getDb, closeDb } from '../db/connection.js';
import { listSettleReview, confirmSettleReview, readTrustedSigners } from '../lib/orderSync.js';

function lines(itemsJson: string | null): Array<{ a: string; qty: number; unitPrice: string; currency: string }> {
  try {
    const v = JSON.parse(itemsJson || '[]');
    return Array.isArray(v) ? v.map((i: any) => ({ a: String(i?.a), qty: Number(i?.qty), unitPrice: String(i?.unitPrice), currency: String(i?.currency) })) : [];
  } catch { return []; }
}

async function main(): Promise<number> {
  const [cmd, orderId, eventId] = process.argv.slice(2);
  if (cmd === 'list') {
    const db = getDb();
    const open = listSettleReview(db);
    for (const e of open) {
      console.log(JSON.stringify({
        order_id: e.order_id,
        order_event_id: e.order_event_id,
        replaced_since: !!e.current_event_id && e.current_event_id !== e.order_event_id,
        verdict_now: e.verdict,
        expected_now: e.expected_total,
        old_paid_amount: e.old_paid_amount,
        old_paid_tx_id: e.old_paid_tx_id,
        listed_at: new Date(e.listed_at * 1000).toISOString(),
        unit_id: e.unit_id,
        lines: lines(e.items_json),
      }));
    }
    console.log(`open entries: ${open.length}`);
    return 0;
  }
  if (cmd === 'confirm' && orderId && eventId) {
    const db = getDb();
    const r = await confirmSettleReview(db, orderId, eventId, { trusted: readTrustedSigners(db) });
    console.log(JSON.stringify(r));
    return r.ok ? 0 : 1;
  }
  console.error('usage: settle-review.ts list | confirm <order_id> <order_event_id>');
  return 2;
}

main().then(code => { closeDb(); process.exitCode = code; }, err => {
  console.error(err?.message || err);
  closeDb();
  process.exitCode = 1;
});
