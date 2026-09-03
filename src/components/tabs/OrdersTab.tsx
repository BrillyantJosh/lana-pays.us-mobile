/**
 * OrdersTab — the merchant's Lana Online Shop orders (the 4th home button).
 *
 * Lists PAID orders that still need shipping ("To ship") across every unit
 * this hex owns or staffs — or all orders — with a 15s poll while the tab is
 * open. Tapping an order opens the OrderDetailSheet (delivery details are
 * decrypted there, in the browser; "Mark shipped" signs a KIND 36521).
 * Full history with pagination lives at /orders/history.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Loader2, Package, History, ChevronRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { OrderList, type OrderRow } from '@/components/OrderList';
import { OrderDetailSheet } from '@/components/OrderDetailSheet';

interface UnitOption { unit_id: string; name: string }

interface OrdersTabProps {
  unitId?: string;
  merchantHex?: string;
  businessUnits?: UnitOption[];
}

type Scope = 'pending' | 'all';

const OrdersTab = ({ unitId, merchantHex, businessUnits = [] }: OrdersTabProps) => {
  const { t } = useTranslation();
  const { session } = useAuth();
  const hex = merchantHex || session?.nostrHexId || '';

  const [scope, setScope] = useState<Scope>('pending');
  // '' = every unit of this hex (the badge counts across all of them too).
  const [unitFilter, setUnitFilter] = useState<string>('');
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<OrderRow | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const unitIdRef = useRef(unitId);
  unitIdRef.current = unitId;

  const fetchOrders = useCallback(async () => {
    if (!hex) { setRows([]); setLoading(false); return; }
    try {
      const params = new URLSearchParams({ hex, scope, limit: '20' });
      if (unitFilter) params.set('unit_id', unitFilter);
      const res = await fetch(`/api/orders?${params.toString()}`);
      const json = await res.json();
      if (json.success) {
        const list: OrderRow[] = json.orders || [];
        setRows(list);
        // Keep the open sheet on the fresh row (status may have moved).
        setSelected(prev => prev ? (list.find(o => o.order_id === prev.order_id) || prev) : prev);
      }
    } catch { /* keep previous list */ }
    setLoading(false);
  }, [hex, scope, unitFilter]);

  useEffect(() => {
    setLoading(true);
    fetchOrders();
    const interval = setInterval(fetchOrders, 15_000);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  const openOrder = (row: OrderRow) => { setSelected(row); setSheetOpen(true); };

  return (
    <div className="flex flex-col gap-5 px-6 py-4">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
          <Package className="w-7 h-7 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-xl font-bold text-foreground">{t('orders.title')}</h2>
          <p className="text-muted-foreground text-sm">{t('home.ordersSubtitle')}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(['pending', 'all'] as Scope[]).map(s => (
          <button
            key={s}
            type="button"
            onClick={() => setScope(s)}
            className={`h-11 rounded-xl text-sm font-semibold border transition-colors ${
              scope === s ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-foreground border-border hover:bg-accent'
            }`}
          >
            {s === 'pending' ? t('orders.pending') : t('orders.all')}
          </button>
        ))}
      </div>

      {businessUnits.length > 1 && (
        <select
          value={unitFilter}
          onChange={(e) => setUnitFilter(e.target.value)}
          className="h-11 rounded-xl bg-background border border-input px-3 text-sm text-foreground"
        >
          <option value="">{t('orders.all')}</option>
          {businessUnits.map(u => <option key={u.unit_id} value={u.unit_id}>{u.name}</option>)}
        </select>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <History className="w-4 h-4 text-muted-foreground" />
            {scope === 'pending' ? t('orders.pending') : t('orders.all')}
          </h3>
          <Link to="/orders/history"
            className="text-xs text-primary font-medium flex items-center gap-0.5 hover:underline">
            {t('orders.history')}
            <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </div>
        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
        ) : (
          <OrderList rows={rows} onSelect={openOrder} />
        )}
      </div>

      <OrderDetailSheet
        order={selected}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        merchantHex={hex}
        onChanged={fetchOrders}
      />
    </div>
  );
};

export default OrdersTab;
