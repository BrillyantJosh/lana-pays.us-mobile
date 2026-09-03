/**
 * OrdersHistory — the dedicated full-history page for Lana Online Shop
 * orders (/orders/history, merchant-protected). Same list + detail sheet
 * as the tab, with offset pagination over ALL orders (every status).
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, ChevronLeft, ChevronRight, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { OrderList, type OrderRow } from '@/components/OrderList';
import { OrderDetailSheet } from '@/components/OrderDetailSheet';

const PAGE_SIZE = 20;

interface UnitOption { unit_id: string; name: string }

const OrdersHistory = () => {
  const { t } = useTranslation();
  const { session } = useAuth();
  const navigate = useNavigate();
  const hex = session?.nostrHexId || '';

  const [units, setUnits] = useState<UnitOption[]>([]);
  const [unitId, setUnitId] = useState<string>(''); // '' = all units
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<OrderRow | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Load the merchant's units for the filter (all units by default).
  useEffect(() => {
    if (!hex) return;
    (async () => {
      try {
        const res = await fetch(`/api/business-units/${hex}`);
        const data = await res.json();
        setUnits((data.units || []).map((u: any) => ({ unit_id: u.unit_id, name: u.name })));
      } catch { /* leave empty */ }
    })();
  }, [hex]);

  const fetchPage = useCallback(async () => {
    if (!hex) { setRows([]); setTotal(0); setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams({ hex, scope: 'all', limit: String(PAGE_SIZE), offset: String(offset) });
      if (unitId) params.set('unit_id', unitId);
      const res = await fetch(`/api/orders?${params.toString()}`);
      const json = await res.json();
      if (json.success) {
        const list: OrderRow[] = json.orders || [];
        setRows(list);
        setTotal(json.total || 0);
        setSelected(prev => prev ? (list.find(o => o.order_id === prev.order_id) || prev) : prev);
      }
    } catch { /* keep previous */ }
    setLoading(false);
  }, [unitId, hex, offset]);

  useEffect(() => { fetchPage(); }, [fetchPage]);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-md mx-auto px-4 py-5 flex flex-col gap-4">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors text-sm font-medium"
        >
          <ArrowLeft className="w-5 h-5" />
          {t('common.back')}
        </button>

        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <Package className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="font-display text-xl font-bold text-foreground">{t('orders.historyTitle')}</h1>
            <p className="text-sm text-muted-foreground">{t('home.ordersSubtitle')}</p>
          </div>
        </div>

        {units.length > 1 && (
          <select
            value={unitId}
            onChange={(e) => { setUnitId(e.target.value); setOffset(0); }}
            className="h-11 rounded-xl bg-background border border-input px-3 text-sm text-foreground"
          >
            <option value="">{t('orders.all')}</option>
            {units.map(u => <option key={u.unit_id} value={u.unit_id}>{u.name}</option>)}
          </select>
        )}

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : (
          <>
            <OrderList rows={rows} onSelect={(row) => { setSelected(row); setSheetOpen(true); }} />
            {pages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <Button variant="outline" size="sm" className="rounded-xl gap-1"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                  <ChevronLeft className="w-4 h-4" /> {t('lanaOnline.prevPage')}
                </Button>
                <span className="text-xs text-muted-foreground">{page} / {pages}</span>
                <Button variant="outline" size="sm" className="rounded-xl gap-1"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}>
                  {t('lanaOnline.nextPage')} <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            )}
          </>
        )}

        <OrderDetailSheet
          order={selected}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          merchantHex={hex}
          onChanged={fetchPage}
        />
      </main>
    </div>
  );
};

export default OrdersHistory;
