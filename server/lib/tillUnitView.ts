/**
 * One business unit as GET /api/business-units/:hexId hands it to the till.
 *
 * Moved out of index.ts unchanged (23 Nov 2026) so a test can pin it: for
 * every unit without the new KIND 30901 tag the answer is the same JSON, key for
 * key and in the same order, as before. A unit without a company or a bank
 * account (payout_account "none") additionally gets:
 *   payout_account          'none'
 *   margin_percent          0..20, or null when its margin cannot be read
 *                           (it then takes no direct LANA sale)
 *   lanapays_payout_wallet  the one wallet its event names, or null
 * and EMPTY payout_problems / payout_advice: it has no bank, so a list of what
 * the bank would refuse would tell a seller without a company to enter a
 * company and an IBAN, the opposite of what they chose. The bank-file rules
 * themselves (lib/payoutDataCheck.ts, the same file in four repos) are not
 * touched.
 *
 * raw_event and bank_account never leave this server.
 */
import { checkPayoutData } from './payoutDataCheck.js';
import { isOnlineShopUnit, isNoPayoutAccountUnit, unitMarginPercent, unitPayoutWallet } from './unitFlags.js';

/**
 * Whether the merchant has entered payout data (IBAN/account). A LANA purchase
 * wires the merchant invoice to their bank (brain orchestrator merchant_payment
 * destination_type='bank'); with no IBAN it cannot be paid out — so the mobile
 * greys out "Pay with LANA". Cash needs no bank, so it stays enabled.
 * The IBAN lives in the KIND 30901 `payment_scheme_fields` tag (modern), with the
 * legacy `bank_account` column as a fallback. Read it from raw_event so no schema
 * change / re-ingestion is needed; the raw IBAN is never returned to the client.
 */
export function payoutConfigured(rawEvent: unknown, bankAccount: unknown): boolean {
  try {
    const ev = JSON.parse((rawEvent as string) || '{}');
    const tag = (ev.tags || []).find((t: any[]) => t[0] === 'payment_scheme_fields');
    if (tag && tag[1]) {
      const f = JSON.parse(tag[1]);
      if (f && typeof f === 'object' && Object.values(f).some(v => String(v ?? '').trim() !== '')) {
        return true;
      }
    }
  } catch { /* fall through to legacy / false */ }
  return !!(bankAccount && String(bankAccount).trim() !== '');
}

/** The row as the route selects it, raw_event and bank_account included. */
export function tillUnitView(u: Record<string, any>): Record<string, unknown> {
  // Strip the raw payout fields; expose only the computed booleans.
  const { raw_event, bank_account, ...rest } = u;
  // What the bank would refuse / what will likely stop a payout, by
  // direct.lana.fund's bank-file rules (lib/payoutDataCheck.ts, Brilly
  // 21 Nov 2026), and where the owner fixes it. Codes only, no IBAN.
  let tags: any[] = [];
  try { tags = JSON.parse(raw_event || '{}').tags || []; } catch { tags = []; }
  const noAccount = isNoPayoutAccountUnit(raw_event) === true;
  const payout = noAccount ? { problems: [] as string[], advice: [] as string[] } : checkPayoutData(tags);
  const simple = tags.some((t: any[]) => Array.isArray(t) && t[0] === 'unit_type' && t[1] === 'simple.lanapays.us');
  return {
    ...rest,
    payout_configured: payoutConfigured(raw_event, bank_account),
    online_shop: isOnlineShopUnit(raw_event),
    payout_problems: payout.problems,
    payout_advice: payout.advice,
    payout_fix_url: simple ? 'https://simple.lanapays.us' : 'https://shop.lanapays.us',
    // Only for a unit without a company: every other unit's answer stays as it was.
    ...(noAccount ? {
      payout_account: 'none',
      margin_percent: unitMarginPercent(raw_event) ?? null,
      lanapays_payout_wallet: unitPayoutWallet(raw_event) ?? null,
    } : {}),
  };
}
