/**
 * Which rail an online payment request (the Lana-online tab) takes for a shop
 * (Brilly, 26 Nov 2026).
 *
 *   brain   a shop as before: a payment request /pay/<token>, paid in LANA
 *           through the brain (server/paymentRequests.ts). Nothing changes here.
 *   direct  a shop without a company and without a bank account (KIND 30901
 *           payout_account "none", shop.lanapays.us option (c)): the brain pays
 *           a shop's invoice to a bank account, which this shop does not have,
 *           so its online payment request is a LANA neposredno payment link
 *           /pay-direct/<token>, the same one the till's "Send a payment link"
 *           makes (POST /api/direct-lana/links, server/directLana.ts). The
 *           customer pays it from home, from their own card, straight into the
 *           shop's Main Wallet, with the shop's margin.
 *   closed  such a shop whose LANA neposredno is not on (the switch in the admin
 *           does not name it, or what it lacks): no link can be made, and the
 *           seller is told why, never "no bank account".
 *
 * Nothing here moves or prices money: it only decides which existing server
 * route the form calls, and what the seller reads. The server decides again,
 * from scratch, when the link is made and when it is paid.
 */

/** A shop's LANA neposredno as GET /api/business-units hands it to the till (server lib/directLanaUnit.ts directLanaView). */
export interface DirectLanaView {
  enabled: boolean;
  reason: string | null;
}

export type OnlineRequestRail =
  | { rail: 'brain' }
  | { rail: 'direct' }
  | { rail: 'closed'; reason: string };

/** The server's code for "the switch does not name this shop". */
export const DIRECT_LANA_OFF = 'DIRECT_LANA_OFF';

/**
 * `noCompany`: the shop has no company and no bank account. `directLana`: its
 * direct view, when the till has one. No view (an older server, or a shop the
 * till does not know as one yet): the form tries, and the server's answer says.
 */
export function onlineRequestRail(noCompany: boolean, directLana?: DirectLanaView | null): OnlineRequestRail {
  if (!noCompany) return { rail: 'brain' };
  if (directLana && directLana.enabled !== true) return { rail: 'closed', reason: directLana.reason || 'OTHER' };
  return { rail: 'direct' };
}

/** The reasons the home screen already has a notice for (directLana.notice.*). */
const NOTICE_REASONS = ['WALLET_INVALID', 'PAYEE_FROZEN', 'RATE_UNAVAILABLE', 'MARGIN_INVALID'];

/**
 * What the seller reads when no link can be made for such a shop, as an i18n
 * key: the switch is off → "not switched on yet, the administrator switches it
 * on"; something the shop lacks → the notice the home screen shows for it.
 */
export function closedReasonKey(reason: string | null | undefined): string {
  if (reason === DIRECT_LANA_OFF) return 'lanaOnline.directOff';
  if (reason && NOTICE_REASONS.includes(reason)) return `directLana.notice.${reason}`;
  return 'directLana.notice.OTHER';
}

/** An invoice amount the server reads (lib/directLanaCore.ts parseCents): "10", "10.5", "10,50". */
export const DIRECT_AMOUNT = /^\d{1,13}(?:[.,]\d{1,2})?$/;

/** Is this a direct-link invoice amount above zero? */
export const isDirectAmount = (text: string): boolean =>
  DIRECT_AMOUNT.test(text.trim()) && Number(text.trim().replace(',', '.')) > 0;
