/**
 * Are a unit's payout details complete enough for the bank? Read from its
 * signed KIND 30901 tags. Pure; the same file lives in four places (keep them
 * alike): lana-pays-shop server/lib + src/lib, lana-pays-simple server/lib,
 * lana-pays.us-mobile server/lib.
 *
 * The rules are direct.lana.fund's for a payment in the bank file
 * (server/lib/bankExport.ts transferProblems / transferFor, 16 Nov 2026):
 *
 *   PROBLEMS — the bank refuses the WHOLE file, every merchant in it waits,
 *   and the Lana.Discount part of the batch with it (Brilly, 21 Nov 2026):
 *     ACCOUNT_MISSING  no IBAN (or, outside SEPA, no account)
 *     IBAN_INVALID     an IBAN whose check digits fail, or not a SEPA country
 *     STREET_MISSING   no street in the receiver's address
 *     TOWN_MISSING     no town in the receiver's address
 *
 *   ADVICE — paid, but likely to be stopped or to need a person:
 *     RECEIVER_NOT_CHOSEN  the receiver was typed, not picked from the
 *                          register: the funder's bank compares that name
 *                          with the account holder, and "no match" holds
 *                          every payout to the account (direct.lana.fund)
 *     HOLDER_DIFFERS       the account holder is not the receiver's name
 *     COUNTRY_UNCLEAR      the receiver's country is not a two-letter code
 *                          (the bank file then uses the IBAN's country)
 *     BIC_INVALID          a BIC that is not one (the bank file leaves it out)
 *     ZIP_MISSING          no post code
 */

export type PayoutProblem = 'ACCOUNT_MISSING' | 'IBAN_INVALID' | 'STREET_MISSING' | 'TOWN_MISSING';
export type PayoutAdvice = 'RECEIVER_NOT_CHOSEN' | 'HOLDER_DIFFERS' | 'COUNTRY_UNCLEAR' | 'BIC_INVALID' | 'ZIP_MISSING';

export interface PayoutCheck {
  problems: PayoutProblem[];
  advice: PayoutAdvice[];
}

/** The tags this check reads — what a cache needs to keep of a unit's event. */
export const PAYOUT_TAGS = [
  'payment_scheme', 'payment_scheme_fields', 'bank_account', 'bank_swift',
  'receiver_name', 'receiver_address', 'receiver_zip', 'receiver_city', 'receiver_country', 'receiver_type',
] as const;

const SEPA_COUNTRIES = new Set([
  'AD', 'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GI', 'GR', 'HR', 'HU',
  'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'SM', 'VA',
  'AL', 'MD', 'ME', 'MK', 'RS',
]);

export function compactIban(raw: unknown): string {
  return String(raw ?? '').replace(/[\s-]/g, '').toUpperCase();
}

/** ISO 13616 check digits AND a SEPA country — what the bank file accepts. */
export function validSepaIban(raw: unknown): boolean {
  const iban = compactIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  if (!SEPA_COUNTRIES.has(iban.slice(0, 2))) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

export function validBic(raw: unknown): boolean {
  return /^[A-Z]{6}[A-Z2-9][A-NP-Z0-9]([A-Z0-9]{3})?$/.test(String(raw ?? '').trim().toUpperCase());
}

const letters = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function checkPayoutData(tags: unknown): PayoutCheck {
  const list: string[][] = Array.isArray(tags) ? tags.filter((t): t is string[] => Array.isArray(t)) : [];
  const tag = (n: string) => String(list.find(t => t[0] === n)?.[1] ?? '').trim();
  let fields: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(tag('payment_scheme_fields') || '{}');
    fields = parsed && typeof parsed === 'object' ? parsed : {};
  } catch { fields = {}; }
  const field = (k: string) => String(fields[k] ?? '').trim();

  const problems: PayoutProblem[] = [];
  const advice: PayoutAdvice[] = [];

  const scheme = tag('payment_scheme') || (tag('bank_account') ? 'EU.IBAN' : '');
  if (scheme === 'EU.IBAN' || (!scheme && (field('iban') || tag('bank_account')))) {
    const iban = field('iban') || tag('bank_account');
    if (!iban) problems.push('ACCOUNT_MISSING');
    else if (!validSepaIban(iban)) problems.push('IBAN_INVALID');
    const bic = field('bic') || tag('bank_swift');
    if (bic && !validBic(bic)) advice.push('BIC_INVALID');
  } else if (!scheme || !Object.values(fields).some(v => String(v ?? '').trim() && v !== fields.account_holder)) {
    problems.push('ACCOUNT_MISSING');
  }

  if (!tag('receiver_address')) problems.push('STREET_MISSING');
  if (!tag('receiver_city')) problems.push('TOWN_MISSING');

  if (!tag('receiver_type')) advice.push('RECEIVER_NOT_CHOSEN');
  const holder = field('account_holder');
  if (holder && tag('receiver_name') && letters(holder) !== letters(tag('receiver_name'))) advice.push('HOLDER_DIFFERS');
  if (!/^[A-Z]{2}$/.test(tag('receiver_country'))) advice.push('COUNTRY_UNCLEAR');
  if (!tag('receiver_zip')) advice.push('ZIP_MISSING');

  return { problems, advice };
}
