/**
 * The merchant's optional note on a Lana-online payment request, on the
 * client: the field (one line, at most 200 characters counted as the server
 * counts them, says the customer sees it), and the list that shows it back —
 * as plain text, never as markup.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

vi.hoisted(() => {
  // This runner has no real Storage, and i18n reads `lang` from it at import.
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => { map.set(k, String(v)); },
      removeItem: (k: string) => { map.delete(k); },
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() { return map.size; },
    },
  });
});

import i18n from '@/i18n';
import { RequestNoteField } from './RequestNoteField';
import { PaymentRequestList, type PaymentRequestRow } from './PaymentRequestList';
import { REQUEST_NOTE_MAX, typedNote, noteToSend, noteLength } from '@/lib/requestNote';

beforeAll(async () => { await i18n.changeLanguage('en'); });

describe('typedNote / noteToSend', () => {
  it('a line break or tab becomes a space while typing', () => {
    expect(typedNote('Za Kati\nnajem\tsobe')).toBe('Za Kati najem sobe');
  });
  it(`stops at ${REQUEST_NOTE_MAX} characters, an emoji counting once`, () => {
    expect(typedNote('x'.repeat(250))).toHaveLength(REQUEST_NOTE_MAX);
    const e = typedNote('🌿'.repeat(250));
    expect(noteLength(e)).toBe(REQUEST_NOTE_MAX);
    expect(e).toBe('🌿'.repeat(REQUEST_NOTE_MAX));
  });
  it('only spaces → nothing is sent', () => {
    expect(noteToSend('   ')).toBeUndefined();
    expect(noteToSend('  Janez ')).toBe('Janez');
  });
});

function Harness() {
  const [v, setV] = useState('');
  return <><RequestNoteField value={v} onChange={setV} /><output data-testid="value">{v}</output></>;
}

describe('RequestNoteField', () => {
  it('is optional, says the customer sees it, and counts characters', () => {
    render(<Harness />);
    expect(screen.getByText(/optional/i)).toBeInTheDocument();
    expect(screen.getByText('The customer also sees this note on the payment page.')).toBeInTheDocument();
    const box = screen.getByLabelText(/Note/);
    fireEvent.change(box, { target: { value: 'Delavnica\n5. 12.' } });
    expect(screen.getByTestId('value').textContent).toBe('Delavnica 5. 12.');
    expect(screen.getByTestId('note-count').textContent).toBe(`16/${REQUEST_NOTE_MAX}`);
    fireEvent.change(box, { target: { value: 'z'.repeat(300) } });
    expect(screen.getByTestId('value').textContent).toHaveLength(REQUEST_NOTE_MAX);
  });
});

const row = (over: Partial<PaymentRequestRow>): PaymentRequestRow => ({
  id: 'r1', token: 't'.repeat(32), unit_id: 'u', unit_name: 'Shop', status: 'pending', amount_fiat: 12.5,
  currency: 'EUR', invoice_number: 'INV-1', created_at: '2026-11-22 10:00:00', expires_at: null, paid_at: null,
  tx_hash: null, paid_lana_lanoshis: null, customer_name: null, ...over,
});

describe('PaymentRequestList shows the note', () => {
  it('as plain text — markup in a note is shown, never run', () => {
    const { container } = render(<PaymentRequestList rows={[row({ note: '<img src=x onerror=alert(1)> Za Kati' })]} />);
    const note = screen.getByTestId('request-note');
    expect(note.textContent).toBe('Note: <img src=x onerror=alert(1)> Za Kati');
    expect(container.querySelector('img')).toBeNull();
  });
  it('no note → no note line', () => {
    render(<PaymentRequestList rows={[row({ id: 'r2', note: null }), row({ id: 'r3' })]} />);
    expect(screen.queryByTestId('request-note')).toBeNull();
  });
});
