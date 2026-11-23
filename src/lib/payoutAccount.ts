/**
 * Shops without a company and without a bank account (shop.lanapays.us
 * option (c), KIND 30901 ["payout_account","none"], Brilly 23 Nov 2026).
 *
 * Through this till such a shop sells for CASH only. A LANA sale through the
 * brain pays the shop's invoice to a bank account, which this shop does not
 * have, so the till shows no LANA and no Lana-online tile for it, and the server
 * refuses those sales anyway (server/lib/noPayoutAccount.ts). It issues no
 * invoices either: the seller says what was sold, and the till adds the unit's
 * next sale number (server/saleNumbers.ts).
 *
 * Nothing here moves or prices money. It decides what the seller sees, and the
 * words of a refusal that already happened.
 */

/** The server's refusal of a LANA sale for such a shop. The brain uses the same code. */
export const UNIT_NO_PAYOUT_ACCOUNT = 'UNIT_NO_PAYOUT_ACCOUNT';
/** The brain's refusal of a LANA sale for a new unit that has no bank account (yet). */
export const NO_PAYOUT_ACCOUNT = 'NO_PAYOUT_ACCOUNT';
/** The brain's refusal of a sale whose reward must be paid in LANA, with no valid wallet for it. */
export const REWARD_WALLET_INVALID = 'REWARD_WALLET_INVALID';

/**
 * Is this the shop of a seller without a company? Strictly the server's 'none':
 * a field that is absent (an older server, an old unit) is a shop as before.
 */
export function isNoPayoutAccountUnit(unit: { payout_account?: unknown } | null | undefined): boolean {
  return unit?.payout_account === 'none';
}

/**
 * The code of a refusal, wherever the answer carries it. This server and the
 * brain both put the code in `code` and the plain words in `error` (and in
 * `message`), so `code` is read first. A code in `error` is read only when
 * there is no `code`: an older answer that carried the code there.
 */
function refusalCode(data: any): string | null {
  if (typeof data?.code === 'string' && data.code) return data.code;
  if (typeof data?.error === 'string' && /^[A-Z][A-Z0-9_]*$/.test(data.error)) return data.error;
  return null;
}

/** Was this sale or link refused because the shop has no bank account? */
export function isUnitNoPayoutAccount(data: any): boolean {
  return refusalCode(data) === UNIT_NO_PAYOUT_ACCOUNT;
}

/**
 * The seller's words for a refusal about the shop's payout settings, as an
 * i18n key, or null when this answer is something else. Nothing was recorded
 * or sent in any of these cases.
 */
export function payoutRefusalKey(data: any): string | null {
  switch (refusalCode(data)) {
    case UNIT_NO_PAYOUT_ACCOUNT: return 'purchase.unitNoPayoutAccount';
    case NO_PAYOUT_ACCOUNT: return 'purchase.noPayoutAccount';
    case REWARD_WALLET_INVALID: return 'purchase.rewardWalletInvalid';
    default: return null;
  }
}

/** The number the till got for one sale, and the day it got it (DD.MM.YYYY). */
export interface SaleNumber {
  number: number;
  date: string;
}

/** The longest description of what was sold the till takes. */
export const SALE_DESCRIPTION_MAX = 100;

/**
 * What a sale of a shop without a company sends as its invoice number: what
 * was sold, then the unit's sale number and the day it was given, e.g.
 * "eggs, 10 pieces (#42, 23.11.2026)". The brain refuses an invoice number used
 * twice on one unit; the sale number makes every sale's text different, and the
 * same sale keeps the same text on every retry.
 */
export function saleInvoiceNumber(description: string, sale: SaleNumber): string {
  const what = description.trim().slice(0, SALE_DESCRIPTION_MAX).trim();
  return `${what} (#${sale.number}, ${sale.date})`;
}

/** A sale number as the server hands it out, or null for anything else. */
export function readSaleNumber(data: any): SaleNumber | null {
  const n = data?.number;
  const date = data?.date;
  if (data?.success !== true || !Number.isInteger(n) || n <= 0) return null;
  if (typeof date !== 'string' || !/^\d{2}\.\d{2}\.\d{4}$/.test(date)) return null;
  return { number: n, date };
}
