/**
 * Shops without a bank account: shop.lanapays.us option (c), KIND 30901
 * ["payout_account","none"] (Brilly, 23 Nov 2026).
 *
 * Through the brain such a shop sells for CASH only. Its LANA comes only as a
 * direct transfer to the unit's own wallet, never through the brain, because a
 * LANA sale through the brain pays the shop's invoice to a bank account, and
 * this shop has none.
 *
 * Every route of this server that hands a LANA sale to the brain asks
 * unitHasNoPayoutAccount() and refuses with noPayoutAccountRefusal() BEFORE
 * anything is forwarded, signed or claimed:
 *   POST /api/brain/purchase          any payment_type that is not 'cash'
 *   POST /api/brain/purchase/preview  before the customer signs
 *   POST /api/payment-requests        no link is made
 *   POST /api/pay/:token/preview      before the customer signs
 *   POST /api/pay/:token/submit       before the atomic claim, so the request
 *                                     never sits in 'paying'
 * and GET /api/pay/:token shows such a link as closed. No stored row is
 * changed: a shop that later enters a bank account takes its links back.
 *
 * The brain refuses the same sale by itself (UNIT_NO_PAYOUT_ACCOUNT). The checks
 * here are defence in depth, and they give the till its words first.
 *
 * A unit whose stored event cannot be read is not such a unit: it is a unit
 * as every unit was before the tag existed. Old units stay exactly as they are.
 */
import type Database from 'better-sqlite3';
import { isNoPayoutAccountUnit } from './unitFlags.js';

/** The code a till reads. The brain refuses with the same one. */
export const UNIT_NO_PAYOUT_ACCOUNT = 'UNIT_NO_PAYOUT_ACCOUNT';

/**
 * The words. `error` carries words and `code` the code, the convention of
 * purchaseSeller.ts: a tab with older code prints `error` as it is.
 */
export const UNIT_NO_PAYOUT_ACCOUNT_WORDS =
  'This shop has no bank account, so it cannot be paid with LANA this way. Cash works as usual.';

/** The refusal body, sent with HTTP 409 (well-formed request, a rule says no), as the brain does. */
export function noPayoutAccountRefusal(): { success: false; code: string; error: string; message: string } {
  return {
    success: false,
    code: UNIT_NO_PAYOUT_ACCOUNT,
    error: UNIT_NO_PAYOUT_ACCOUNT_WORDS,
    message: UNIT_NO_PAYOUT_ACCOUNT_WORDS,
  };
}

/**
 * Does the stored KIND 30901 of this unit say it has no bank account?
 * False for an unknown unit, a unit id that is not a string, and an event that
 * cannot be read: those keep the path they had (the brain answers for them).
 */
export function unitHasNoPayoutAccount(db: Database.Database, unitId: unknown): boolean {
  if (typeof unitId !== 'string' || unitId === '') return false;
  const row = db.prepare('SELECT raw_event FROM business_units WHERE unit_id = ?').get(unitId) as
    { raw_event?: unknown } | undefined;
  return isNoPayoutAccountUnit(row?.raw_event) === true;
}
