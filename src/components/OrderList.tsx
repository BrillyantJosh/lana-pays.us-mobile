/**
 * OrderList — shared list of Lana Online Shop orders.
 * Used by the OrdersTab (pending / last 20) and the /orders/history page
 * (paginated). Pure display: tapping a row hands it to the parent, which
 * opens the OrderDetailSheet. Data loading stays in the parent so each
 * surface controls its own polling/pagination.
 */

import { useTranslation } from 'react-i18next';
import { ChevronRight, Package, Truck, Store } from 'lucide-react';
import { currencySymbol } from '@/lib/format';

export interface OrderItem {
  a: string;
  kind: number;
  qty: number;
  saleUnit: string;
  unitPrice: string;
  currency: string;
  /** Listing title as it was at order time (else the paid receipt's); null = unknown. */
  title?: string | null;
  /** The listing's `sku` tag (šifra). */
  sku?: string | null;
  /** The listing's `weight` tag — package size, e.g. "200 g". */
  weight?: string | null;
  /** qty × unitPrice, 2 decimals, computed by the server. */
  lineTotal?: string | null;
}

/**
 * Weight/volume sale units. Hidden ONLY when the listing carries a `weight` tag:
 * imported listings (e.g. Živa Center, unit "g" + weight "200 g", price per jar;
 * unit "L" + weight "200 ml", price per bottle) made "1 × g" read as one gram,
 * and the package size says what one piece is. Without a `weight` tag the unit
 * IS the quantity's unit (price per kg / L — the storefront shows "€x / kg"), so
 * hiding it would leave the merchant unable to tell 2 kg from 2 pieces.
 */
const MEASURE_UNITS = new Set([
  'g', 'kg', 'mg', 'dag', 'dkg', 'l', 'ml', 'dl', 'cl', 'lb', 'oz',
  'gram', 'grams', 'kilogram', 'kilograms', 'liter', 'liters', 'litre', 'litres',
]);
/** Counting units already said by "N ×". */
const PIECE_UNITS = new Set(['', 'piece', 'pieces', 'pc', 'pcs', 'kos', 'kom', 'item', 'items', 'unit', 'units']);

/**
 * The sale unit worth showing after an item's quantity: '' for plain pieces, and
 * '' for a weight/volume unit only when `weight` (the package size) stands in for it.
 */
export function itemUnitLabel(saleUnit: string | null | undefined, weight?: string | null): string {
  const u = String(saleUnit ?? '').trim();
  const k = u.toLowerCase();
  if (PIECE_UNITS.has(k)) return '';
  if (MEASURE_UNITS.has(k) && String(weight ?? '').trim() !== '') return '';
  return u;
}

/** First 8 characters of the listing's d-tag — enough to tell items apart, not a raw id dump. */
export function itemShortId(a: string): string {
  return String(a || '').split(':').slice(2).join(':').slice(0, 8);
}

/** Server lineTotal, or qty × unitPrice in exact cents for a row served without it. */
export function itemLineTotal(it: OrderItem): string {
  if (it.lineTotal) return it.lineTotal;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(it.unitPrice ?? '').trim());
  const qty = Number(it.qty);
  if (!m || !Number.isInteger(qty) || qty <= 0) return String(it.unitPrice ?? '');
  const c = (Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'))) * qty;
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

/** Mirror of the server's orderView (server/orders.ts). No PII, no plaintext. */
export interface OrderRow {
  order_id: string;
  unit_id: string;
  unit_name: string;
  unit_owner_hex: string;
  buyer_pubkey: string;
  created_at: number;
  items: OrderItem[];
  shipping: string;
  total: string;
  currency: string;
  fulfillment: 'shipping' | 'pickup';
  order_status: string;
  pay_by: number;
  client: string | null;
  paymentState: 'unpaid' | 'paid' | 'amount_mismatch' | 'expired' | 'cancelled';
  expected_total: string | null;
  price_changed: boolean;
  effectiveStatus: string;
  pending: boolean;
  paid_signer_hex: string | null;
  paid_tx_id: string | null;
  paid_event_id: string | null;
  paid_customer_hex: string | null;
  paid_amount: string | null;
  paid_lana_amount: string | null;
  paid_at: number | null;
  fulfillment_status: string | null;
  fulfillment_event_id: string | null;
  fulfillment_pubkey: string | null;
  fulfillment_created_at: number | null;
  fulfillment_carrier: string | null;
  fulfillment_tracking: string | null;
  fulfillment_published: boolean;
  delivery_event: { id: string; pubkey: string; kind: number; content: string; tags: string[][]; created_at: number; sig: string } | null;
}

/** 'amount_mismatch' → 'AmountMismatch', 'paid' → 'Paid' (for orders.status<Cap>). */
export function statusKey(status: string): string {
  const cap = status.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
  return `orders.status${cap}`;
}

const NEEDS_ACTION = new Set(['paid', 'received', 'confirmed', 'packed']);
const DONE = new Set(['shipped', 'delivered', 'completed']);
const PROBLEM = new Set(['amount_mismatch', 'rejected', 'refunded']);

export function statusStyle(status: string): string {
  if (NEEDS_ACTION.has(status)) return 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30';
  if (DONE.has(status)) return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30';
  if (PROBLEM.has(status)) return 'bg-destructive/10 text-destructive border-destructive/30';
  return 'bg-muted text-muted-foreground border-border';
}

/**
 * Order timestamps are unix seconds (from the signed events); SQLite
 * datetime('now') strings are UTC without a zone suffix — both normalized.
 */
export function localTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  try {
    if (typeof value === 'number') return new Date(value * 1000).toLocaleString();
    return new Date(value.replace(' ', 'T') + 'Z').toLocaleString();
  } catch { return String(value); }
}

export const shortHex = (hex: string | null | undefined, n = 8): string =>
  hex ? `${hex.slice(0, n)}…${hex.slice(-4)}` : '';

interface Props {
  rows: OrderRow[];
  onSelect?: (row: OrderRow) => void;
}

export function OrderList({ rows, onSelect }: Props) {
  const { t } = useTranslation();

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-6">{t('orders.empty')}</p>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {rows.map(row => {
        const qty = row.items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
        const firstTitle = row.items[0]?.title || '';
        return (
          <button
            key={row.order_id}
            type="button"
            onClick={() => onSelect?.(row)}
            className="glass-card rounded-2xl border p-4 space-y-2 text-left w-full active:scale-[0.99] transition-transform"
          >
            <div className="flex items-center justify-between gap-2">
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${statusStyle(row.effectiveStatus)}`}>
                {t(statusKey(row.effectiveStatus))}
              </span>
              <span className="text-base font-bold text-foreground shrink-0">
                {currencySymbol(row.currency)}{row.total}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate flex items-center gap-1.5">
                {row.fulfillment === 'pickup'
                  ? <Store className="w-3.5 h-3.5 shrink-0" />
                  : <Truck className="w-3.5 h-3.5 shrink-0" />}
                <span className="truncate">{row.unit_name}</span>
                <span className="shrink-0">· {qty} <Package className="w-3 h-3 inline" /></span>
              </span>
              <span className="shrink-0">{localTime(row.paid_at ?? row.created_at)}</span>
            </div>
            {firstTitle && (
              <p className="text-sm font-medium text-foreground truncate">
                {firstTitle}{row.items.length > 1 ? ` +${row.items.length - 1}` : ''}
              </p>
            )}
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="font-mono truncate">{t('orders.buyer')}: {shortHex(row.buyer_pubkey)}</span>
              <ChevronRight className="w-4 h-4 shrink-0" />
            </div>
          </button>
        );
      })}
    </div>
  );
}
