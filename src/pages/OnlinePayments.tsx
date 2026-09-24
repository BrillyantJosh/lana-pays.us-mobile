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
 *
 * Rows are shown only for the query they were loaded for (unit + page): while a
 * new unit or page loads, the spinner shows, never the previous selection's
 * rows under the new one's filter.
 *
 * TWO clocks, and they say different things:
 *   - "List read at" is THIS page's own stamp, set on every successful read of
 *     the list. It is the answer to "is this still refreshing?" — a merchant
 *     whose unit has had no new request for days must be able to tell "nothing
 *     new" from "stuck". It moves on every read, manual or automatic.
 *   - "Investor status checked at" is the OLDEST time an investor status on
 *     screen was really read from the brain (the server caches it: a minute for
 *     an open leg, ten for a settled one), so it may sit still while the list
 *     stamp moves. It is about the investor column only, and staff never see
 *     it, because they get no investor column.
 *
 * The page re-reads itself while it is open and once when it is returned to.
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

/** How often an open page re-reads the list. A minute, like the balance in the
 *  top bar (TopBar.tsx) — and the server caches an open investor leg for a
 *  minute too (brainPayouts OPEN_TTL_MS), so a faster poll could not come back
 *  with anything fresher. The 15s polls in the app are the live checkout tabs
 *  (Lana-online, Orders), where a cashier is waiting for one payment; this is a
 *  read-only overview of a list that grows every few days. */
const REFRESH_MS = 60_000;

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
  customer_status: 'waiting' | 'processing' | 'paid' | 'paid_unconfirmed' | 'unverified' | 'cancelled' | 'expired' | string;
  paid_at: string | null;
  tx_hash: string | null;
  customer_name: string | null;
  /** null = the signer is staff on this unit; the investor side is the owner's. */
  investor: { invoice: Leg; reward: RewardLeg | null; checked_at: string | null } | null;
}

interface Overview {
  total: number;
  units: Array<{ unit_id: string; name: string }>;
  requests: OverviewRow[];
  /** False when the brain answered for none of the paid rows that needed it. */
  investor_available?: boolean;
  /** True when some rows carry no investor status because the signer is staff. */
  investor_owner_only?: boolean;
}

/** Which selection a response belongs to. */
const queryKey = (unitId: string, offset: number) => `${unitId}|${offset}`;

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
  /** The last answer, WITH the selection it was loaded for. */
  const [data, setData] = useState<{ key: string; body: Overview } | null>(null);
  /** The unit list outlives a change of selection, so the selector stays put. */
  const [units, setUnits] = useState<Overview['units']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  /** When the list itself was last read successfully — this page's own clock. */
  const [listReadAt, setListReadAt] = useState<Date | null>(null);
  const requestSeq = useRef(0);

  /** `quiet`: a read nobody asked for (the timer, or coming back to the page).
   *  It never touches the spinner and never turns a blip into an error screen —
   *  it keeps the rows that are already there, exactly as the Lana-online and
   *  Orders tabs keep theirs. A quiet read that fails moves nothing — neither
   *  the rows nor the list stamp — so a refresh that has quietly stopped
   *  working shows up as a list stamp that has stopped moving. */
  const load = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    const seq = ++requestSeq.current;
    const key = queryKey(unitId, offset);
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
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
    if (next.error || !next.data) {
      if (!quiet) setError(next.error || 'load');
    } else {
      setError(null);
      setData({ key, body: next.data });
      setUnits(Array.isArray(next.data.units) ? next.data.units : []);
      setListReadAt(new Date());
    }
    setLoading(false); // also rescues a manual read that a quiet one overtook
  }, [privateKeyHex, unitId, offset]);

  // The page used to be read once, when it was opened, and never again: a unit
  // with no new request for days looked exactly like a page that had stopped
  // refreshing. It now polls while it is open (paused while the page is out of
  // sight, so a phone in a pocket asks nothing) and reads once more the moment
  // it is looked at again. `visibilitychange` covers a backgrounded tab or a
  // locked phone, focus/blur the case of another window on top on a desktop,
  // where no visibility change is fired. Both fire on the same return, so one
  // flag makes that one read, not two.
  useEffect(() => {
    load();
    let away = false;
    const tick = () => { if (document.visibilityState !== 'hidden') load({ quiet: true }); };
    const left = () => { away = true; };
    const returned = () => {
      if (!away || document.visibilityState === 'hidden') return;
      away = false;
      load({ quiet: true });
    };
    const onVisibility = () => (document.visibilityState === 'hidden' ? left() : returned());
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', returned);
    window.addEventListener('blur', left);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', returned);
      window.removeEventListener('blur', left);
    };
  }, [load]);

  // Only the answer for THIS selection is shown; anything else is in flight.
  const current = data && data.key === queryKey(unitId, offset) ? data.body : null;
  const rows = current?.requests || [];
  const total = current?.total || 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showUnitName = !unitId && units.length > 1;
  const investorUnavailable = current?.investor_available === false;
  const ownerOnly = current?.investor_owner_only === true;

  // The oldest time an investor status on screen was really read — the page
  // claims no fresher check than its stalest line. None read → no stamp.
  const readTimes = rows
    .map(r => parseServerTime(r.investor?.checked_at))
    .filter((d): d is Date => d !== null)
    .map(d => d.getTime());
  const checkedAt = readTimes.length ? new Date(Math.min(...readTimes)) : null;

  const customerPill = (row: OverviewRow) => {
    switch (row.customer_status) {
      case 'waiting': return <Pill tone={AMBER} text={t('onlinePayments.customerWaiting')} />;
      case 'processing': return <Pill tone={AMBER} text={t('onlinePayments.customerProcessing')} />;
      case 'paid': return <Pill tone={GREEN} text={t('onlinePayments.customerPaid', { date: formatDateTime(row.paid_at, lng) })} />;
      // Paid per this app (the tab and the toast say so too), but with no
      // transaction from the brain behind it — never green.
      case 'paid_unconfirmed': return <Pill tone={GREY} unknown text={t('onlinePayments.customerPaidUnconfirmed')} />;
      case 'cancelled': return <Pill tone={GREY} text={t('onlinePayments.customerCancelled')} />;
      case 'expired': return <Pill tone={GREY} text={t('onlinePayments.customerExpired')} />;
      default: return <Pill tone={GREY} unknown text={t('onlinePayments.customerUnverified')} />;
    }
  };

  const legPill = (leg: Leg, row: OverviewRow) => {
    switch (leg.state) {
      case 'marked_paid': return <Pill tone={GREEN} text={t('onlinePayments.investorMarkedPaid', { date: formatDateTime(leg.marked_paid_at, lng) })} />;
      case 'waiting': return <Pill tone={AMBER} text={t('onlinePayments.investorWaiting')} />;
      case 'partly': return <Pill tone={AMBER} text={t('onlinePayments.investorPartly')} />;
      case 'not_applicable':
        // "The customer has not paid yet" only while the request is open. On a
        // cancelled or expired request (whose invoice may have been paid some
        // other way) or one in flight, nothing is said about the customer.
        return row.customer_status === 'waiting' ? (
          <span className="text-xs text-muted-foreground">
            <span aria-hidden="true">— </span>{t('onlinePayments.investorNotApplicable')}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground" data-testid="investor-dash">—</span>
        );
      default: return <Pill tone={GREY} unknown text={t('onlinePayments.investorUnknown')} />;
    }
  };

  const investorBlock = (row: OverviewRow) => {
    // Staff: the investor side is the owner's (one note at the top says so).
    if (!row.investor) return null;
    const { invoice, reward } = row.investor;
    // The brain answered for none of the paid rows: one line at the top says
    // so, instead of a "?" on every paid row.
    if (investorUnavailable && row.customer_status === 'paid' && invoice.state === 'unknown' && !reward) return null;
    if (!reward) {
      return (
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-xs font-medium text-muted-foreground pt-0.5 w-20 shrink-0">{t('onlinePayments.investor')}:</span>
          {legPill(invoice, row)}
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
            {legPill(invoice, row)}
          </div>
          <div className="flex items-start gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground pt-0.5">{t('onlinePayments.rewardLeg')}{rewardAmount}:</span>
            {legPill(reward, row)}
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

        {/* What belongs on this list at all. A merchant who takes most of the
            day's money at the till reads a short list here and concludes the
            page is broken; it is not, those payments were never meant here. */}
        <p className="text-xs text-muted-foreground" data-testid="scope-note">
          {t('onlinePayments.scopeNote')}
        </p>

        <p className="flex items-start gap-2 text-xs text-muted-foreground rounded-xl border border-border bg-secondary/40 px-3 py-2">
          <Info className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{t('onlinePayments.markedPaidNote')}</span>
        </p>

        {current && (investorUnavailable || ownerOnly) && (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="investor-notes">
            {investorUnavailable && (
              <p className="flex items-start gap-2">
                <HelpCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{t('onlinePayments.investorUnavailable')}</span>
              </p>
            )}
            {ownerOnly && <p>{t('onlinePayments.investorOwnerOnly')}</p>}
          </div>
        )}

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

        <div className="flex items-start justify-between gap-2">
          {/* The list stamp first and on its own line: it is the one every
              merchant has (the investor line below it exists only for an owner
              whose rows carried a real brain read), and the two say different
              things, so they never share a line. */}
          <div className="flex flex-col gap-0.5 min-w-0">
            {listReadAt && !error && (
              <span className="text-xs text-muted-foreground" data-testid="list-read-at">
                {t('onlinePayments.listReadAt', { time: formatTime(listReadAt, lng) })}
              </span>
            )}
            {checkedAt && current && !error && (
              <span className="text-[11px] text-muted-foreground/80" data-testid="investor-checked-at">
                {t('onlinePayments.checkedAt', { time: formatTime(checkedAt, lng) })}
              </span>
            )}
          </div>
          <Button variant="outline" size="sm" className="rounded-xl gap-1.5 shrink-0" disabled={loading} onClick={() => load()}>
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
        ) : !current ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : rows.length === 0 ? (
          <div className="text-center py-6 space-y-1">
            <p className="text-sm text-muted-foreground">{t('onlinePayments.empty')}</p>
            <p className="text-xs text-muted-foreground" data-testid="empty-hint">{t('onlinePayments.emptyHint')}</p>
          </div>
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
