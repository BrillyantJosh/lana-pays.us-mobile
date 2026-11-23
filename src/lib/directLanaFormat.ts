/**
 * Exact amounts, written the way the seller's language writes numbers.
 *
 * Every amount of a direct LANA sale arrives as an exact decimal string
 * ("11.00", "42.96875", "0.256"): what the customer pays and what the public
 * record says. Turning one into a float to format it could show a digit that is
 * not in it, so the digits are kept as they are and only the separators and the
 * currency sign come from Intl.
 */

function separators(locale: string): { decimal: string } {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1.5);
    return { decimal: parts.find(p => p.type === 'decimal')?.value ?? '.' };
  } catch {
    return { decimal: '.' };
  }
}

/** "1234.5678" → "1,234.5678" (en) or "1.234,5678" (sl). Digits exactly as given. */
export function formatDecimal(value: string, locale: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!m) return String(value);
  let whole: string;
  try {
    whole = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 }).format(BigInt(m[2]));
  } catch {
    whole = m[2];
  }
  return `${m[1]}${whole}${m[3] ? separators(locale).decimal + m[3] : ''}`;
}

/** "11.00" EUR → "11,00 €" (sl) or "€11.00" (en): the currency where the language puts it. */
export function formatMoney(value: string, currency: string, locale: string): string {
  try {
    const parts = new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).formatToParts(1.5);
    let placed = false;
    let out = '';
    for (const p of parts) {
      if (p.type === 'integer' || p.type === 'group' || p.type === 'decimal' || p.type === 'fraction') {
        if (!placed) out += formatDecimal(value, locale);
        placed = true;
      } else if (p.type !== 'minusSign') {
        out += p.value;
      }
    }
    return out;
  } catch {
    return `${formatDecimal(value, locale)} ${currency}`;
  }
}

/** A LANA amount: "42,96875 LANA". */
export const formatLana = (value: string, locale: string): string => `${formatDecimal(value, locale)} LANA`;

/** An address shortened for a line of text: Lb8k…3xQz. */
export const shortAddress = (address: string): string =>
  address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
