/**
 * Exact amounts in the seller's language: the digits are the server's, only the
 * separators and the currency sign come from Intl (lib/directLanaFormat.ts).
 */
import { describe, it, expect } from 'vitest';
import { formatDecimal, formatMoney, formatLana, shortAddress } from './directLanaFormat';

describe('exact decimals', () => {
  it('Slovenian: a decimal comma, the digits exactly as given', () => {
    expect(formatLana('42.96875', 'sl')).toBe('42,96875 LANA');
    expect(formatLana('0.0003945', 'sl')).toBe('0,0003945 LANA');
    expect(formatDecimal('1234.5678', 'sl')).toBe('1.234,5678');
  });

  it('English: a decimal point', () => {
    expect(formatLana('42.96875', 'en')).toBe('42.96875 LANA');
    expect(formatDecimal('1234.5678', 'en')).toBe('1,234.5678');
  });

  it('money where the language puts the sign, with every digit of the price', () => {
    expect(formatMoney('11.00', 'EUR', 'sl').replace(/ /g, ' ')).toBe('11,00 €');
    expect(formatMoney('0.256', 'EUR', 'sl').replace(/ /g, ' ')).toBe('0,256 €');
    expect(formatMoney('11.00', 'EUR', 'en')).toBe('€11.00');
    expect(formatMoney('0.123456789012345678', 'EUR', 'en')).toBe('€0.123456789012345678');
  });

  it('an address is shortened for a sentence', () => {
    expect(shortAddress('LbtLTSACAREiT513CVNpbg6NeE5cFbrhkC')).toBe('LbtLTS…rhkC');
  });
});
