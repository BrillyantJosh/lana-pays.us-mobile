/** Shared display formatting for LANA amounts and fiat currency symbols.
 *  (LanaTab/CashTab keep their own local copies — production money code is
 *  not touched; new Lana-online code imports from here.) */

export const CURRENCY_SYMBOL: Record<string, string> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
};

export function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOL[currency] || currency + ' ';
}

/** Format a LANA amount: up to 8 decimals, only significant digits. */
export function formatLana(amount: number): string {
  if (Number.isInteger(amount)) return amount.toLocaleString();
  return parseFloat(amount.toFixed(8)).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

/** Lanoshis → LANA display string. */
export function formatLanoshis(lanoshis: number): string {
  return formatLana(lanoshis / 1e8);
}
