// @vitest-environment node
/**
 * What the receipt reader may hand on as an invoice number. Every dropped
 * shape here is constant per shop (or per till), so letting it through makes
 * every later receipt of that shop collide with the first one.
 * Account and VAT numbers below are made up (the IBAN is the ISO 13616 sample).
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeInvoiceNumber, looksLikeBankAccount, looksLikeTaxId, looksLikeFiscalCode, looksLikeDeviceId,
  INVOICE_NUMBER_RULES,
} from './invoiceNumber';

describe('sanitizeInvoiceNumber — real receipt numbers stay exactly as read', () => {
  it.each([
    'TRG1-L0001-52160',
    'TRG1-L0001-521',          // a short reading cannot be told apart here — the prompt fixes that
    'TRG1-320-5153',
    '26-305-000001',
    '1-MP-3650',
    '0006946/01',
    '62263/26',
    '2026-68',
    'R3-MK-1888',
    'SI-4245',
    'H052178',
    '000903',
    'Krema manni',             // a typed description on the photo path is not touched
  ])('%s', (value) => {
    expect(sanitizeInvoiceNumber(value)).toBe(value);
  });

  it('only trims — never rewrites a kept value', () => {
    expect(sanitizeInvoiceNumber('  TRG1-320 4993 ')).toBe('TRG1-320 4993');
  });

  it('a number the model sent as a number', () => {
    expect(sanitizeInvoiceNumber(52160)).toBe('52160');
  });
});

describe('sanitizeInvoiceNumber — not an invoice number → null', () => {
  it.each([
    ['nothing', null],
    ['undefined', undefined],
    ['empty', '   '],
    ['"null" as text', 'null'],
    ['"N/A"', 'N/A'],
    ['an object', { n: 1 }],
  ])('%s', (_label, value) => {
    expect(sanitizeInvoiceNumber(value as any)).toBeNull();
  });

  it.each([
    ['IBAN in groups (Slovenian shape)', 'SI56 1234 5678 9012 345'],
    ['IBAN in groups (German sample)', 'DE89 3704 0044 0532 0130 00'],
    ['IBAN compact, valid checksum', 'GB82WEST12345698765432'],
    ['labelled IBAN', 'IBAN: SI56123456789012345'],
    ['labelled TRR', 'TRR SI56 1234 5678 9012 345'],
  ])('bank account: %s', (_label, value) => {
    expect(looksLikeBankAccount(value)).toBe(true);
    expect(sanitizeInvoiceNumber(value)).toBeNull();
  });

  it.each([
    ['Slovenian VAT', 'SI12345678'],
    ['VAT with a space', 'SI 12345678'],
    ['nine digits after SI', 'SI764066126'],
    ['Austrian UID', 'ATU12345678'],
    ['labelled DDV', 'ID za DDV: 12345678'],
    ['labelled VAT', 'VAT 12345678'],
    ['davčna številka', 'Davčna številka 12345678'],
  ])('tax id: %s', (_label, value) => {
    expect(looksLikeTaxId(value)).toBe(true);
    expect(sanitizeInvoiceNumber(value)).toBeNull();
  });

  it.each([
    ['EOR uuid', 'c4b0596e-5743-4c63-8d2a-1f0e9b7c6a51'],
    ['EOR read only up to the wrap', 'c4b0596e-5743-4c63-8'],
    ['labelled EOR', 'EOR: c4b0596e-5743'],
    ['ZOI hex', '32300fa80b1c9372115c7f8d1f2b3a4e'],
    ['labelled ZOI', 'ZOI 32300fa80b'],
  ])('fiscal code: %s', (_label, value) => {
    expect(looksLikeFiscalCode(value)).toBe(true);
    expect(sanitizeInvoiceNumber(value)).toBeNull();
  });

  it.each([
    ['bare device id', 'L0001'],
    ['premises + device, no sequence', 'TRG1-L0001'],
  ])('till id: %s', (_label, value) => {
    expect(looksLikeDeviceId(value)).toBe(true);
    expect(sanitizeInvoiceNumber(value)).toBeNull();
  });

  it('a long plain number is not mistaken for a ZOI code', () => {
    expect(sanitizeInvoiceNumber('00000000000000012345678')).toBe('00000000000000012345678');
  });
});

describe('INVOICE_NUMBER_RULES — what the reader is told', () => {
  it('joins a number that wraps onto the next line', () => {
    expect(INVOICE_NUMBER_RULES).toMatch(/WRAP/);
    expect(INVOICE_NUMBER_RULES).toMatch(/without a space/);
  });
  it('prefers the labelled value', () => {
    expect(INVOICE_NUMBER_RULES).toContain('RAČUN št.');
  });
  it('names everything it must never return', () => {
    for (const word of ['IBAN', 'VAT', 'DDV', 'EOR', 'ZOI', 'L0001']) expect(INVOICE_NUMBER_RULES).toContain(word);
  });
  it('its example is not a real shop number', () => {
    expect(INVOICE_NUMBER_RULES).not.toMatch(/TRG1-L0001/);
  });
});
