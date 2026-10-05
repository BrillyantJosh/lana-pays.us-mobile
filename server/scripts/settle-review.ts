/**
 * Brilly's review of paid orders that SPEC v1.1.2 step 5 does not pay
 * (shop_order_settle_review — round 3, 2 Oct 2026; widened in round 5). Run
 * by hand on the server, in the app's container (it opens the app's own
 * SQLite file):
 *
 *   npx tsx server/scripts/settle-review.ts list [--all]
 *   npx tsx server/scripts/settle-review.ts confirm <order_id> <order_event_id> --taken <event_id>
 *
 * `list` prints every open entry — its reason, ids, amounts and the stored
 * lines (listing address, qty, unit price), no buyer data. Entries listed
 * less than an hour ago are hidden unless --all: one tick's failed listing
 * REQ lists an order that the next tick may pay. Reasons:
 *   legacy_paid     a 'paid' of the older rules that step 5 does not pay
 *   terms_mismatch  a verified payment of exactly the order's total, but the
 *                   merchant's terms (now, and those kept for this event) do
 *                   not reach it
 *   not_computable  the same, with an item whose listing is unknown or off sale
 *
 * Check each against what the broker took and checked at order time — its
 * read-only tool, in the shop container:
 *   node --import tsx server/scripts/order-as-taken.ts <order_id>
 * prints the 36520 event id the broker validated, its total and the lines.
 *
 * `confirm` makes the purchase pinned on the entry the step-5a pin of exactly
 * that 36520 event (orderSync.confirmSettleReview). --taken is the event id
 * order-as-taken printed: it is refused unless that is the stored event, the
 * order's total is the pinned amount, and the NEWEST version of that 30933
 * still pays it — then nothing is written. The app never calls it.
 */
import { getDb, closeDb } from '../db/connection.js';
import { listSettleReview, confirmSettleReview, readTrustedSigners } from '../lib/orderSync.js';

const HIDE_YOUNGER_THAN_S = 3600;

function lines(itemsJson: string | null): Array<{ a: string; qty: number; unitPrice: string; currency: string }> {
  try {
    const v = JSON.parse(itemsJson || '[]');
    return Array.isArray(v) ? v.map((i: any) => ({ a: String(i?.a), qty: Number(i?.qty), unitPrice: String(i?.unitPrice), currency: String(i?.currency) })) : [];
  } catch { return []; }
}

function usage(): number {
  console.error('usage: settle-review.ts list [--all] | confirm <order_id> <order_event_id> --taken <event_id>');
  return 2;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === 'list') {
    const rest = args.slice(1);
    if (rest.some(a => a !== '--all')) return usage();
    const all = rest.includes('--all');
    const db = getDb();
    const everything = listSettleReview(db);
    const open = all ? everything : listSettleReview(db, { minAgeSeconds: HIDE_YOUNGER_THAN_S });
    for (const e of open) {
      console.log(JSON.stringify({
        reason: e.reason ?? 'legacy_paid',
        order_id: e.order_id,
        order_event_id: e.order_event_id,
        replaced_since: !!e.current_event_id && e.current_event_id !== e.order_event_id,
        verdict_now: e.verdict,
        expected_now: e.expected_total,
        order_total: e.total,
        paid_amount: e.old_paid_amount,
        paid_tx_id: e.old_paid_tx_id,
        listed_at: new Date(e.listed_at * 1000).toISOString(),
        unit_id: e.unit_id,
        lines: lines(e.items_json),
      }));
    }
    const hidden = everything.length - open.length;
    console.log(`open entries: ${open.length}${hidden > 0 ? ` (${hidden} listed less than an hour ago hidden — --all shows them)` : ''}`);
    return 0;
  }
  if (cmd === 'confirm') {
    const [, orderId, eventId, flag, taken, ...extra] = args;
    if (!orderId || !eventId || flag !== '--taken' || !taken || extra.length) return usage();
    const db = getDb();
    const r = confirmSettleReview(db, orderId, eventId, taken, { trusted: readTrustedSigners(db) });
    console.log(JSON.stringify(r));
    return r.ok ? 0 : 1;
  }
  return usage();
}

main().then(code => { closeDb(); process.exitCode = code; }, err => {
  console.error(err?.message || err);
  closeDb();
  process.exitCode = 1;
});
