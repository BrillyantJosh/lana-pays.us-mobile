/**
 * Do a merchant's payout details belong together? Pure; the same file lives
 * in six places (keep them alike): lana-pays-shop server/lib + src/lib,
 * lana-pays-simple server/lib + src/lib, lana-pays.us-mobile server/lib,
 * lana-direct-fund server/lib.
 *
 * THE BIC AND THE IBAN (Brilly, 28 Nov 2026). Two Halcom files of
 * direct.lana.fund (25 and 26 Nov) carried a BIC that did not belong to the
 * account, and each was cancelled within minutes and made again: "KBMACI2X"
 * on a Slovenian OTP account (CI — Côte d'Ivoire — typed for SI) and
 * UniCredit's BACXSI22 on an NLB account. A SEPA payment needs no BIC — the
 * bank finds it from the IBAN — but a wrong one makes the bank refuse it.
 *  - The BIC's country (its 5th and 6th letter) must be the IBAN's country.
 *  - For a Slovenian IBAN also the bank: the IBAN's 5th and 6th digit are the
 *    bank's code, and SI_BANK_BIC names the bank's BIC. A code that is not
 *    there is 'unknown_bank' and passes: nothing is refused that we cannot know.
 *  - An empty BIC stays allowed.
 * Only the first eight characters are compared (bank, country, place); an
 * eleven-character BIC's branch is not judged.
 *
 * THE RECEIVER'S NAME: the funder's bank compares it with the account
 * holder, so a web or e-mail address typed there ("Www.<the farm>.si",
 * 25 Nov 2026) can never match. Only what is clearly not a name is caught;
 * names are not checked against any bank.
 */

export type BicFit = 'ok' | 'empty' | 'country_mismatch' | 'bank_mismatch' | 'unknown_bank';

/**
 * The Slovenian code of each bank (IBAN characters 5–6; characters 5–9 for an
 * institution Banka Slovenije gave a five-digit code) → the first eight
 * characters of its BIC. Every code on Banka Slovenije's list "Seznam
 * identifikacijskih oznak in pripadajočih BIC kod" (bsi.si/en/d/list-of-identifiers-of-psp,
 * as of 18 Aug 2026, read 28 Nov 2026). A bank that took over another keeps
 * the other's code under its own BIC (30 = NLB, former N Banka). Codes of
 * banks merged away and not on the list (03 SKB, 05 Abanka …) are left out.
 */
export const SI_BANK_BIC: Readonly<Record<string, string>> = {
  '01': 'BSLJSI2X', // Banka Slovenije (incl. the state's accounts)
  '02': 'LJBASI2X', // NLB
  '04': 'KBMASI2X', // OTP banka (former Nova KBM)
  '07': 'GORESI2X', // Gorenjska banka
  '10': 'BAKOSI2X', // Banka Intesa Sanpaolo
  '19': 'SZKBSI2X', // Deželna banka Slovenije
  '29': 'BACXSI22', // UniCredit Banka Slovenija
  '30': 'LJBASI2X', // NLB (former N Banka)
  '33': 'HAABSI22', // Addiko Bank
  '34': 'KSPKSI22', // Banka Sparkasse
  '35': 'BFKKSI22', // BKS Bank AG, bančna podružnica
  '38': 'SIDRSI22', // SID banka
  '60': 'HLONSI22', // Hranilnica LON
  '61': 'HDELSI22', // Delavska hranilnica
  '64': 'HKVISI22', // Primorska hranilnica Vipava
  '79095': 'KDDSSI22', // KDD – Centralna klirinško depotna družba
  '91002': 'PWSRSI22', // Dinaro
};

const compact = (raw: unknown) => String(raw ?? '').replace(/[\s-]/g, '').toUpperCase();

/**
 * Does the BIC belong to the IBAN's country and, for Slovenia, its bank?
 * 'ok' and 'unknown_bank' pass, 'empty' is allowed; only 'country_mismatch'
 * and 'bank_mismatch' are wrong. What is not a BIC or an IBAN at all is for
 * validBic and the IBAN check to say: it is 'unknown_bank' here.
 */
export function checkBicAgainstIban(ibanRaw: unknown, bicRaw: unknown): BicFit {
  const bic = compact(bicRaw);
  if (!bic) return 'empty';
  const iban = compact(ibanRaw).replace(/^IBAN:?(?=[A-Z]{2}\d{2})/, '');
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban) || !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) return 'unknown_bank';
  const country = iban.slice(0, 2);
  if (bic.slice(4, 6) !== country) return 'country_mismatch';
  if (country !== 'SI') return 'ok';
  const bank = SI_BANK_BIC[iban.slice(4, 9)] ?? SI_BANK_BIC[iban.slice(4, 6)];
  if (!bank) return 'unknown_bank';
  return bic.slice(0, 8) === bank ? 'ok' : 'bank_mismatch';
}

/** A BIC that names another country or (Slovenia) another bank than the IBAN's. */
export const bicMismatch = (fit: BicFit): fit is 'country_mismatch' | 'bank_mismatch' =>
  fit === 'country_mismatch' || fit === 'bank_mismatch';

/** A web or e-mail address typed where the receiver's name goes — never a name a bank holds. */
export function receiverIsAddress(raw: unknown): boolean {
  const s = String(raw ?? '').trim();
  return /^(https?:\/\/|www\.)/i.test(s) || /:\/\//.test(s) || /[^\s@]@[^\s@]+\.[a-z]{2,}/i.test(s);
}
