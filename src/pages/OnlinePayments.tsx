/**
 * OnlinePayments — menu → "Online payments" (/lana-online/payments).
 *
 * Every Lana-online payment request the merchant created, with two answers per
 * row: did the CUSTOMER pay, and has the INVESTOR marked the merchant's payout
 * paid on direct.lana.fund. Before this page a merchant learned nothing about a
 * request until the customer had paid, and nothing about the investor at all.
 *
 * Read-only. The request is SIGNED with the session key (NIP-98) — the server
 * reads no hex from the URL. "Marked paid" is the investor's own statement, not
 * a bank confirmation, and the page says so. A status the server could not
 * check is grey with a "?", never green.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, ChevronLeft, ChevronRight, Globe, RefreshCw, HelpCircle, ExternalLink, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { signedFetch, signatureAdvice } from '@/lib/signedRequest';
import { formatTime } from '@/lib/splitBlock';
import { currencySymbol } from '@/lib/format';

const PAGE_SIZE = 20;

type LegState = 'marked_paid' | 'waiting' | 'partly' | 'unknown' | 'not_applicable';
interface Leg { state: LegState; marked_paid_at: string | null }
interface RewardLeg extends Leg { amount_fiat: number | null; currency: string | null }

interface OverviewRow {
  id: string;
  unit_id: string;
  unit_name: string;
  created_at: string;
  invoice_number: string;
  amount_fiat: number;
  currency: string;
  customer_status: 'waiting' | 'paid' | 'unverified' | 'cancelled' | 'expired' | string;
  paid_at: string | null;
  tx_hash: string | null;
  customer_name: string | null;
  investor: { invoice: Leg; reward: RewardLeg | null; checked_at: string | null };
}

interface Overview {
  checked_at: string;
  total: number;
  units: Array<{ unit_id: string; name: string }>;
  requests: OverviewRow[];
}

type LoadError = 'clock' | 'relogin' | 'load';

/** SQLite datetime('now') is UTC without a zone; ISO strings carry their own. */
function parseServerTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Day-first in English too, like every other date this POS shows. */
function formatDateTime(s: string | null | undefined, lng: string): string {
  const d = parseServerTime(s);
  if (!d) return '';
  const loc = lng === 'en' || lng.startsWith('en-US') ? 'en-GB' : lng;
  try {
    return new Intl.DateTimeFormat(loc, {
      day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

const GREEN = 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30';
const AMBER = 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30';
const GREY = 'bg-muted text-muted-foreground border-border';

function Pill({ tone, text, unknown }: { tone: string; text: string; unknown?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${tone}`}>
      {unknown && <HelpCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
      <span>{text}</span>
    </span>
  );
}

const OnlinePayments = () => {
  const { t, i18n } = useTranslation();
  const { session } = useAuth();
  const navigate = useNavigate();
  const privateKeyHex = session?.privateKeyHex || '';
  const lng = i18n.language || 'en';

  const [unitId, setUnitId] = useState<string>(''); // '' = all units
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (unitId) qs.set('unit_id', unitId);
    let next: { data: Overview | null; error: LoadError | null };
    try {
      const res = await signedFetch(privateKeyHex, `/api/payment-requests/overview?${qs.toString()}`);
      const json: any = await res.json().catch(() => null);
      if (res.status === 401) next = { data: null, error: signatureAdvice(json?.reason) };
      else if (!res.ok || !json?.success) next = { data: null, error: 'load' };
      else next = { data: json as Overview, error: null };
    } catch {
      next = { data: null, error: 'load' };
    }
    if (seq !== requestSeq.current) return; // a newer request superseded this one
    if (next.error) setError(next.error);
    else setData(next.data);
    setLoading(false);
  }, [privateKeyHex, unitId, offset]);

  useEffect(() => { load(); }, [load]);

  const units = data?.units || [];
  const rows = data?.requests || [];
  const total = data?.total || 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showUnitName = !unitId && units.length > 1;
  const checkedAt = parseServerTime(data?.checked_at);

  const customerPill = (row: OverviewRow) => {
    switch (row.customer_status) {
      case 'waiting': return <Pill tone={AMBER} text={t('onlinePayments.customerWaiting')} />;
      case 'paid': return <Pill tone={GREEN} text={t('onlinePayments.customerPaid', { date: formatDateTime(row.paid_at, lng) })} />;
      case 'cancelled': return <Pill tone={GREY} text={t('onlinePayments.customerCancelled')} />;
      case 'expired': return <Pill tone={GREY} text={t('onlinePayments.customerExpired')} />;
      default: return <Pill tone={GREY} unknown text={t('onlinePayments.customerUnverified')} />;
    }
  };

  const legPill = (leg: Leg) => {
    switch (leg.state) {
      case 'marked_paid': return <Pill tone={GREEN} text={t('onlinePayments.investorMarkedPaid', { date: formatDateTime(leg.marked_paid_at, lng) })} />;
      case 'waiting': return <Pill tone={AMBER} text={t('onlinePayments.investorWaiting')} />;
      case 'partly': return <Pill tone={AMBER} text={t('onlinePayments.investorPartly')} />;
      case 'not_applicable':
        return (
          <span className="text-xs text-muted-foreground">
            <span aria-hidden="true">— </span>{t('onlinePayments.investorNotApplicable')}
          </span>
        );
      default: return <Pill tone={GREY} unknown text={t('onlinePayments.investorUnknown')} />;
    }
  };

  const investorBlock = (row: OverviewRow) => {
    const { invoice, reward } = row.investor;
    if (!reward) {
      return (
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-xs font-medium text-muted-foreground pt-0.5 w-20 shrink-0">{t('onlinePayments.investor')}:</span>
          {legPill(invoice)}
        </div>
      );
    }
    const rewardAmount = reward.amount_fiat != null && reward.currency
      ? ` (${currencySymbol(reward.currency)}${reward.amount_fiat.toFixed(2)})`
      : '';
    return (
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('onlinePayments.investor')}:</span>
        <div className="pl-3 space-y-1.5">
          <div className="flex items-start gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground pt-0.5">{t('onlinePayments.invoiceLeg')}:</span>
            {legPill(invoice)}
          </div>
          <div className="flex items-start gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground pt-0.5">{t('onlinePayments.rewardLeg')}{rewardAmount}:</span>
            {legPill(reward)}
          </div>
        </div>
      </div>
    );
  };

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
            <h1 className="font-display text-xl font-bold text-foreground">{t('onlinePayments.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('onlinePayments.subtitle')}</p>
          </div>
        </div>

        <p className="flex items-start gap-2 text-xs text-muted-foreground rounded-xl border border-border bg-secondary/40 px-3 py-2">
          <Info className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{t('onlinePayments.markedPaidNote')}</span>
        </p>

        {units.length > 1 && (
          <select
            value={unitId}
            onChange={(e) => { setUnitId(e.target.value); setOffset(0); }}
            className="h-11 rounded-xl bg-background border border-input px-3 text-sm text-foreground"
          >
            <option value="">{t('onlinePayments.allUnits')}</option>
            {units.map(u => <option key={u.unit_id} value={u.unit_id}>{u.name}</option>)}
          </select>
        )}

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {checkedAt && !error ? t('onlinePayments.checkedAt', { time: formatTime(checkedAt, lng) }) : ''}
          </span>
          <Button variant="outline" size="sm" className="rounded-xl gap-1.5" disabled={loading} onClick={() => load()}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {t('onlinePayments.refresh')}
          </Button>
        </div>

        {error ? (
          <p className="text-sm text-destructive text-center py-6" role="alert">
            {error === 'clock' ? t('onlinePayments.sigClock')
              : error === 'relogin' ? t('onlinePayments.sigRelogin')
              : t('onlinePayments.loadError')}
          </p>
        ) : loading && !data ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">{t('onlinePayments.empty')}</p>
        ) : (
          <>
            <div className="flex flex-col gap-2.5">
              {rows.map(row => (
                <div key={row.id} className="glass-card rounded-2xl border p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground truncate">
                      {t('cash.invoiceLabel', { number: row.invoice_number })}
                    </span>
                    <span className="text-base font-bold text-foreground shrink-0">
                      {currencySymbol(row.currency)}{Number(row.amount_fiat).toFixed(2)}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {showUnitName ? `${row.unit_name} · ` : ''}{formatDateTime(row.created_at, lng)}
                  </div>

                  <div className="pt-1 border-t border-border space-y-1.5">
                    <div className="flex items-start gap-2 flex-wrap">
                      <span className="text-xs font-medium text-muted-foreground pt-0.5 w-20 shrink-0">{t('onlinePayments.customer')}:</span>
                      {customerPill(row)}
                      {row.customer_status === 'paid' && row.customer_name
                        ? <span className="text-xs text-muted-foreground pt-0.5">{row.customer_name}</span>
                        : null}
                    </div>
                    {investorBlock(row)}
                  </div>

                  {row.tx_hash && /^[0-9a-f]{64}$/i.test(row.tx_hash) && (
                    <a href={`https://chainz.cryptoid.info/lana/tx.dws?${row.tx_hash}`} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary underline">
                      <ExternalLink className="w-3.5 h-3.5" /> TX
                    </a>
                  )}
                </div>
              ))}
            </div>

            {pages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <Button variant="outline" size="sm" className="rounded-xl gap-1"
                  disabled={offset === 0 || loading}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                  <ChevronLeft className="w-4 h-4" /> {t('lanaOnline.prevPage')}
                </Button>
                <span className="text-xs text-muted-foreground">{page} / {pages}</span>
                <Button variant="outline" size="sm" className="rounded-xl gap-1"
                  disabled={offset + PAGE_SIZE >= total || loading}
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

export default OnlinePayments;
