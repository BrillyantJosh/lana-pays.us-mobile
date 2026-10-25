/**
 * The invoice number the receipt reader hands back.
 *
 * It matters more than it looks. The brain refuses a purchase whose
 * (unit, invoice_number) is already used, and that number is the only
 * duplicate key that survives a NEW photo of the same receipt (the photo
 * hash changes with every shot). So a wrong reading does real damage:
 *
 * - Alaja, Oct 2026: the till prints a five-digit sequence and wraps its last
 *   two digits onto the next line. The reader returned only the first line,
 *   "TRG1-L0001-521", for about a hundred receipts in a row, and every one
 *   after the first was refused as "already used" (16 Oct: a 9,10 € receipt
 *   blocked by sales from 13 and 14 Oct).
 * - Živa Center: the shop's bank account number came back as the invoice
 *   number; VAT-like ids did too.
 *
 * Two layers. The prompt (INVOICE_NUMBER_RULES) tells the reader how to read
 * the number; sanitizeInvoiceNumber() drops what the reader still gets wrong
 * in a way we can recognise: a bank account, a VAT/tax id, the fiscal EOR/ZOI
 * codes, or a bare till/device id. Those are constant per shop, so passing
 * them on would make every later receipt of that shop collide.
 *
 * A dropped value becomes null: the number field stays EMPTY and the seller
 * must type the number from the receipt — the till refuses to go on without
 * one. Nothing empty is ever sent to the brain in its place: an empty
 * invoice_number switches the brain's number check off entirely, which would
 * leave only the photo hash, and a re-photographed receipt defeats that.
 */

/** Lines for the receipt-reading prompt, about the invoice number only. */
export const INVOICE_NUMBER_RULES = [
  '- invoiceNumber: the receipt/invoice number, or null if it is not visible. Read it like this:',
  '  - Take the value printed after a label such as "RAČUN št.", "Račun št.", "Račun", "Št. računa", "Invoice No." or "Receipt No.". Return only the value, without the label.',
  '  - Receipt printers often WRAP a long number: its last characters continue at the start of the next line, sometimes alone on that line. Join every such continuation directly onto the number, without a space. Example: the line "RAČUN št.: ABC1-L0002-417" followed by a line "38" means the number is "ABC1-L0002-41738".',
  '  - Never return any of these as invoiceNumber: a bank account or IBAN (e.g. "SI56 …", "TRR"), a VAT / DDV / tax ID (e.g. "SI12345678", "ID za DDV"), the EOR code (a long dashed code after "EOR"), the ZOI code (a long hex code after "ZOI"), or a bare till/device id such as "L0001". If only such values are visible, use null.',
].join('\n');

/** Words the reader uses when it has no number, sent back as a string. */
const NO_VALUE = /^(?:null|none|n\/?a|undefined|unknown|ni|brez|-+|\?+)$/i;

/** VAT prefixes of the countries this app serves (EU + neighbours). */
const VAT_PREFIX = '(?:AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK|XI|GB|CH|RS|BA|ME|MK)';
const VAT_ID = new RegExp(`^${VAT_PREFIX}U?\\d{8,12}$`);
const VAT_LABEL = /(?:^|[^a-z])(?:ddv|vat|uid|oib|pib|tax\s*id|dav[čc]n\w*|id\s*za\s*ddv)(?:[^a-z]|$)/i;

/** ISO 13616 check (mod 97 == 1). */
function ibanChecksumOk(compact: string): boolean {
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let rest = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

/** A bank account (IBAN / Slovenian TRR) rather than an invoice number. */
export function looksLikeBankAccount(value: string): boolean {
  const labelled = /^(?:iban|trr|ban)\b/i.test(value.trim());
  const body = value.trim().replace(/^(?:iban|trr|ban)\s*[:.]?\s*/i, '');
  const compact = body.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  // Printed in groups of four, labelled, or a valid checksum: an account.
  return labelled || /\s/.test(body) || ibanChecksumOk(compact);
}

/** A VAT / DDV / tax id rather than an invoice number. */
export function looksLikeTaxId(value: string): boolean {
  if (VAT_LABEL.test(value)) return true;
  return VAT_ID.test(value.replace(/[\s.\-]/g, '').toUpperCase());
}

/** The fiscal EOR (a UUID) or ZOI (32 hex) code rather than an invoice number. */
export function looksLikeFiscalCode(value: string): boolean {
  const v = value.trim();
  if (/(?:^|[^a-z])(?:eor|zoi)(?:[^a-z]|$)/i.test(v)) return true;
  // A UUID, also when only its first part was read (it wraps on the receipt).
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}(?:-|$)/i.test(v)) return true;
  // A long hex code: needs both a letter a-f and a digit, so a long plain
  // number is never mistaken for one.
  return /^[0-9a-f]{20,}$/i.test(v) && /[a-f]/i.test(v) && /\d/.test(v);
}

/**
 * A till/device id alone ("L0001"), or premises + device with the receipt's
 * sequence number missing ("TRG1-L0001"). Constant for a till, so it would
 * collide with every other receipt from it.
 */
export function looksLikeDeviceId(value: string): boolean {
  const v = value.trim();
  return /^L\d{3,5}$/i.test(v) || /^[A-Z0-9]{1,12}[-\s]L\d{3,5}$/i.test(v);
}

/**
 * The reader's invoice number, or null when it is missing or recognisably
 * not an invoice number. A kept value is only trimmed — never rewritten — so
 * it still compares equal to the same receipt read before.
 */
export function sanitizeInvoiceNumber(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = String(raw).trim();
  if (!value || NO_VALUE.test(value)) return null;
  if (looksLikeBankAccount(value)) return null;
  if (looksLikeTaxId(value)) return null;
  if (looksLikeFiscalCode(value)) return null;
  if (looksLikeDeviceId(value)) return null;
  return value;
}
