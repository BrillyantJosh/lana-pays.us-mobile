/**
 * LanaOnlineHistory — the dedicated full-history page for Lana-online
 * payment requests (/lana-online/history, merchant-protected). Same list
 * component as the tab, with offset pagination.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, ChevronLeft, ChevronRight, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { PaymentRequestList, type PaymentRequestRow } from '@/components/PaymentRequestList';

const PAGE_SIZE = 20;

interface UnitOption { unit_id: string; name: string }

const LanaOnlineHistory = () => {
  const { t } = useTranslation();
  const { session } = useAuth();
  const navigate = useNavigate();
  const hex = session?.nostrHexId || '';

  const [units, setUnits] = useState<UnitOption[]>([]);
  const [unitId, setUnitId] = useState<string>('');
  const [rows, setRows] = useState<PaymentRequestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  // Load the merchant's units; auto-select the first (or the one the tab used).
  useEffect(() => {
    if (!hex) return;
    (async () => {
      try {
        const res = await fetch(`/api/business-units/${hex}`);
        const data = await res.json();
        const list: UnitOption[] = (data.units || []).map((u: any) => ({ unit_id: u.unit_id, name: u.name }));
        setUnits(list);
        const remembered = (window as any).__selectedUnitId as string | undefined;
        setUnitId(prev => prev || (remembered && list.some(u => u.unit_id === remembered) ? remembered : list[0]?.unit_id || ''));
      } catch { /* leave empty */ }
    })();
  }, [hex]);

  const fetchPage = useCallback(async () => {
    if (!unitId || !hex) { setRows([]); setTotal(0); setLoading(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/payment-requests?unit_id=${encodeURIComponent(unitId)}&hex=${encodeURIComponent(hex)}&limit=${PAGE_SIZE}&offset=${offset}`);
      const json = await res.json();
      if (json.success) {
        setRows(json.requests || []);
        setTotal(json.total || 0);
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
            <Globe className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="font-display text-xl font-bold text-foreground">{t('lanaOnline.historyTitle')}</h1>
            <p className="text-sm text-muted-foreground">{t('lanaOnline.historySubtitle')}</p>
          </div>
        </div>

        {units.length > 1 && (
          <select
            value={unitId}
            onChange={(e) => { setUnitId(e.target.value); setOffset(0); }}
            className="h-11 rounded-xl bg-background border border-input px-3 text-sm text-foreground"
          >
            {units.map(u => <option key={u.unit_id} value={u.unit_id}>{u.name}</option>)}
          </select>
        )}

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : (
          <>
            <PaymentRequestList rows={rows} merchantHex={hex} onCancelled={fetchPage} />
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
      </main>
    </div>
  );
};

export default LanaOnlineHistory;
