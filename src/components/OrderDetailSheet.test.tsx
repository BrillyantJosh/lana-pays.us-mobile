/**
 * The merchant's order screen must say WHAT was ordered.
 *
 * Marjan's paid test order (Živa Center, 30. 9. 2026) showed
 * "1 × g · a5a1f51e1fb7ceecf5761aa40a04fc2b" — the listing's `unit` tag and its
 * d-tag — and, on a wide screen, Poštnina / Skupaj with their amounts pushed to
 * the far right edge. Pinned: the product name, its šifra and package size, the
 * price per piece and the line total are on the sheet; the bare d-tag and a
 * bare "× g" are not; the sheet is capped in width so amounts sit next to their
 * labels. A weight/volume unit is dropped only when the `weight` tag (package
 * size) stands in for it — a listing priced per kg without one still says "kg".
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';

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

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ session: { nostrHexId: 'ab'.repeat(32), privateKeyHex: '01'.repeat(32) }, logout: () => {} }),
}));

import i18n from '@/i18n';
import { OrderDetailSheet } from './OrderDetailSheet';
import { OrderList, type OrderRow, type OrderItem } from './OrderList';

const D_TAG = 'a5a1f51e1fb7ceecf5761aa40a04fc2b';
const OWNER = 'f2dcd8fa18fe07986243207fcbe60448739e93104837f2d7ac9d2f88158feb0b';

function row(items: OrderItem[], over: Partial<OrderRow> = {}): OrderRow {
  return {
    order_id: `${'1c3cca8beefb82db48b47bd5'}.${'9'.repeat(32)}`,
    unit_id: 'd41e2097fa3942ee9538fe5ded81bf86',
    unit_name: 'Eko veganska trgovina Živa Center',
    unit_owner_hex: OWNER,
    buyer_pubkey: '1c3cca8beefb82db48b47bd5' + '0'.repeat(40),
    created_at: 1790762301,
    items,
    shipping: '0.00',
    total: '4.08',
    currency: 'EUR',
    fulfillment: 'pickup',
    order_status: 'placed',
    pay_by: 1790764101,
    client: 'lanaeco.shop',
    paymentState: 'paid',
    expected_total: '4.08',
    price_changed: false,
    effectiveStatus: 'paid',
    pending: true,
    paid_signer_hex: 'b'.repeat(64),
    paid_tx_id: '638bc792-e859-4d4d-91c9-af47b955d4dd',
    paid_event_id: 'c'.repeat(64),
    paid_customer_hex: 'ca7231f88308' + '0'.repeat(52),
    paid_amount: '4.08',
    paid_lana_amount: '1593750000',
    paid_at: 1790762345,
    fulfillment_status: null,
    fulfillment_event_id: null,
    fulfillment_pubkey: null,
    fulfillment_created_at: null,
    fulfillment_carrier: null,
    fulfillment_tracking: null,
    fulfillment_published: true,
    delivery_event: null,
    ...over,
  };
}

const tarten: OrderItem = {
  a: `36502:${OWNER}:${D_TAG}`, kind: 36502, qty: 1, saleUnit: 'g', unitPrice: '4.08', currency: 'EUR',
  title: 'TARTEN S PETERŠILJEM BIO 200g', sku: '321', weight: '200 g', lineTotal: '4.08',
};

const sheet = (o: OrderRow) => render(<OrderDetailSheet order={o} open onOpenChange={() => {}} merchantHex={OWNER} />);
const text = () => document.body.textContent || '';

beforeAll(async () => { await i18n.changeLanguage('sl'); });

describe('OrderDetailSheet — items', () => {
  it('(g) names the product, its šifra, size, price and line total — never the d-tag or "× g"', () => {
    sheet(row([tarten]));
    expect(screen.getByText('TARTEN S PETERŠILJEM BIO 200g')).toBeInTheDocument();
    const t = text();
    expect(t).toContain('Šifra 321');
    expect(t).toContain('200 g');
    expect(t).toContain('1 × €4.08');
    expect(t).toContain('€0.00');   // Poštnina
    expect(t).toContain('Skupaj');
    expect(t).not.toContain(D_TAG);
    expect(t).not.toMatch(/×\s*g\b/);
  });

  it('a line with qty > 1 shows the price per piece and the line total', () => {
    sheet(row([{ ...tarten, qty: 3, lineTotal: '12.24' }], { total: '12.24' }));
    const t = text();
    expect(t).toContain('3 × €4.08');
    expect(t).toContain('€12.24');
  });

  it('without a title it says so, with only a short id — not the 32-hex d-tag', () => {
    sheet(row([{ ...tarten, title: null, sku: null, weight: null, lineTotal: '4.08' }]));
    const t = text();
    expect(t).toContain('Neznan izdelek');
    expect(t).toContain(D_TAG.slice(0, 8));
    expect(t).not.toContain(D_TAG);
    expect(t).not.toMatch(/×\s*g\b/);
  });

  it('a counting unit other than "piece" is still shown, with the quantity', () => {
    sheet(row([{ ...tarten, title: 'Kosilo', saleUnit: 'portion', weight: null, sku: null }]));
    expect(text()).toContain('1 portion × €4.08');
  });

  it('"piece" is never repeated after "N ×"', () => {
    sheet(row([{ ...tarten, title: 'Kosilo', saleUnit: 'piece', weight: null, sku: null }]));
    expect(text()).toContain('1 × €4.08');
    expect(text()).not.toContain('piece');
  });

  // A measure unit is hidden ONLY when the listing's `weight` tag says what one
  // piece is. Without it the unit IS the quantity's unit (price per kg/L), and
  // "2 × €12.00" would hide whether the buyer wants 2 kg or 2 pieces.
  it('a listing sold per kg with no `weight` tag keeps its unit: "2 kg × €12.00"', () => {
    sheet(row([{
      a: `36502:${'18df12f9'.repeat(8)}:pisek`, kind: 36502, qty: 2, saleUnit: 'kg', unitPrice: '12.00', currency: 'EUR',
      title: 'Eko Pišek', sku: null, weight: null, lineTotal: '24.00',
    }], { total: '24.00' }));
    const t = text();
    expect(t).toContain('2 kg × €12.00');
    expect(t).toContain('€24.00');
  });

  it('the 30933-receipt fallback (title, never a weight) keeps a per-litre unit too', () => {
    sheet(row([{
      a: `36502:${OWNER}:mleko`, kind: 36502, qty: 3, saleUnit: 'L', unitPrice: '1.20', currency: 'EUR',
      title: 'Mleko', sku: null, weight: null, lineTotal: '3.60',
    }]));
    expect(text()).toContain('3 L × €1.20');
  });

  it('a row served without the weight field at all keeps the unit as well', () => {
    const { a, kind, unitPrice, currency } = tarten;
    sheet(row([{ a, kind, qty: 2, saleUnit: 'kg', unitPrice, currency }]));
    expect(text()).toContain('2 kg × €4.08');
  });

  it('with a `weight` tag the package size stands in for the unit (Živa: unit "L", 200 ml bottle)', () => {
    sheet(row([{
      ...tarten, saleUnit: 'L', unitPrice: '11.66', weight: '200 ml', sku: '88',
      title: 'Cvetna vodica SMILJ BIO 200ml', lineTotal: '11.66',
    }]));
    const t = text();
    expect(t).toContain('200 ml');
    expect(t).toContain('1 × €11.66');
    expect(t).not.toMatch(/\bL\b/);
  });

  it('works for an order served before item titles existed (no title/sku/lineTotal fields at all)', () => {
    const { a, kind, qty, saleUnit, unitPrice, currency } = tarten;
    sheet(row([{ a, kind, qty, saleUnit, unitPrice, currency }]));
    const t = text();
    expect(t).toContain('Neznan izdelek');
    expect(t).toContain('€4.08');
    expect(t).not.toContain(D_TAG);
  });

  it('the bottom sheet is width-capped on wide screens so amounts stay next to their labels', () => {
    sheet(row([tarten]));
    expect(screen.getByRole('dialog').className).toContain('sm:max-w-xl');
  });
});

describe('OrderList — row', () => {
  it('shows the first item\'s title under the shop name', () => {
    render(<OrderList rows={[row([tarten])]} />);
    expect(screen.getByText('TARTEN S PETERŠILJEM BIO 200g')).toBeInTheDocument();
    expect(text()).not.toContain(D_TAG);
  });
});
