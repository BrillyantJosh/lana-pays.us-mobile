/**
 * PublicPay — the public /pay/:token page for Lana-online remote payments.
 *
 * A remote customer opens the merchant's link, sees what they're buying
 * (payee, fiat amount, invoice, receipt link), enters or scans their WIF,
 * and the browser signs the LanaCoin tx LOCALLY (signCustomerLanaTx — the
 * WIF never leaves this device) and submits the signed hex.
 *
 * MONEY INVARIANT: the request is stored in FIAT; the exact LANA amount is
 * computed at PAYMENT time (brain preview → recipients). The number shown
 * before preview is indicative only. If a split/rate change lands between
 * preview and submit, the server answers 409 PREVIEW_STALE and this page
 * automatically re-previews and asks the customer to confirm again.
 *
 * NO session/auth — the 192-bit URL token is the capability.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Loader2, CheckCircle2, AlertCircle, Snowflake, ExternalLink,
  QrCode, KeyRound, Receipt, Store, Clock, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { QRScanner } from '@/components/QRScanner';
import { convertWifToIds } from '@/lib/crypto';
import { signCustomerLanaTx } from '@/lib/transaction';
import { classifyWifInput } from '@/lib/wifInput';
import { currencySymbol, formatLanoshis } from '@/lib/format';
import { changeLanguage } from '@/i18n';
import lanaIcon from '@/assets/lana-icon.png';

interface RequestView {
  unitName: string;
  amountFiat: number;
  currency: string;
  invoiceNumber: string;
  receiptUrl: string | null;
  receiptDescription: string | null;
  status: 'pending' | 'paid' | 'cancelled' | 'expired';
  createdAt: string;
  expiresAt: string | null;
  paidAt: string | null;
  txHash: string | null;
  paidLanaLanoshis: number | null;
  paidExchangeRate: number | null;
  indicativeRate: number | null;
  indicativeLanaLanoshis: number | null;
}

interface PreviewData {
  recipients: { address: string; amount_lanoshis: number }[];
  allocations: any[];
  lanaTotalLanoshis: number;
  exchangeRate: number | null;
}

type Phase = 'loading' | 'not_found' | 'closed' | 'ready' | 'checking' | 'confirm' | 'paying' | 'paid';

const PublicPay = () => {
  const { token } = useParams<{ token: string }>();
  const { t } = useTranslation();

  const [phase, setPhase] = useState<Phase>('loading');
  const [request, setRequest] = useState<RequestView | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rateChanged, setRateChanged] = useState(false);
  const [isFrozen, setIsFrozen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualWif, setManualWif] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [paidResult, setPaidResult] = useState<{ txHash: string; lanaPaidLanoshis: number | null; exchangeRate: number | null } | null>(null);

  // The customer's key material lives ONLY in these refs for the duration of
  // the confirm→sign window. Never sent to any server, never persisted.
  const wifRef = useRef<string>('');
  const customerRef = useRef<{ hex: string; wallet: string; name: string }>({ hex: '', wallet: '', name: '' });

  // Public page: default the language from the browser (merchants set theirs
  // at login; a remote customer has no session).
  useEffect(() => {
    if (!localStorage.getItem('lang') && navigator.language) {
      changeLanguage(navigator.language);
    }
  }, []);

  const loadRequest = useCallback(async (): Promise<RequestView | null> => {
    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(token || '')}`);
      if (res.status === 404) { setPhase('not_found'); return null; }
      const json = await res.json();
      if (!json.success) { setPhase('not_found'); return null; }
      const r: RequestView = json.request;
      setRequest(r);
      if (r.status !== 'pending') setPhase(r.status === 'paid' && paidResult ? 'paid' : 'closed');
      return r;
    } catch {
      setError(t('lana.networkError'));
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    (async () => {
      const r = await loadRequest();
      if (r && r.status === 'pending') setPhase('ready');
    })();
  }, [loadRequest]);

  const sym = request ? currencySymbol(request.currency) : '';

  // ── The WIF pipeline (mirrors LanaTab.handleWifScan, against /api/pay/*) ──
  const handleWif = async (data: string) => {
    if (!request) return;
    const trimmed = data.trim();

    const kind = classifyWifInput(trimmed);
    if (kind === 'address') { setError(t('lana.walletAddressNotWif')); return; }
    if (kind === 'nostr') { setError(t('lana.nostrKeyNotWif')); return; }

    setError(null);
    setIsFrozen(false);
    setRateChanged(false);
    setPhase('checking');

    try {
      const ids = await convertWifToIds(trimmed);
      let customerHex = ids.nostrHexId;

      // Registration/freeze check (registrar is the identity source of truth).
      try {
        const checkRes = await fetch('/api/check-wallet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_id: ids.walletId }),
        });
        const checkJson = await checkRes.json();
        if (checkJson.success && checkJson.registered && checkJson.wallet?.nostr_hex_id) {
          customerHex = checkJson.wallet.nostr_hex_id;
        }
        if (checkJson.success && checkJson.wallet?.frozen) {
          setIsFrozen(true);
          setPhase('ready');
          return;
        }
        if (checkJson.success && !checkJson.registered) {
          const balRes = await fetch(`/api/balance/${encodeURIComponent(ids.walletId)}?currency=${request.currency}`);
          const balData = await balRes.json();
          if ((balData.lana || 0) > 0) {
            setError(t('lana.walletNotVirgin', { balance: (balData.lana || 0).toLocaleString() }));
            setPhase('ready');
            return;
          }
          try {
            await fetch('/api/register/wallet', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ wallet_id: ids.walletId, nostr_id_hex: ids.nostrHexId }),
            });
          } catch { /* best effort */ }
        }
      } catch { /* soft-fail — balance check below is the important one */ }

      // Balance check against the indicative amount (exact total comes from preview).
      const res = await fetch(`/api/balance/${encodeURIComponent(ids.walletId)}?currency=${request.currency}`);
      const balanceData = await res.json();
      if (!res.ok) throw new Error(balanceData.error || 'Failed to check balance');
      const walletLana = balanceData.lana || 0;
      const neededLana = (request.indicativeLanaLanoshis || 0) / 1e8;
      if (neededLana > 0 && walletLana < neededLana) {
        setError(t('lana.insufficientBalance', {
          balance: walletLana.toLocaleString(),
          required: formatLanoshis(request.indicativeLanaLanoshis || 0),
        }));
        setPhase('ready');
        return;
      }

      // Best-effort display name (brain snapshots it on the transaction).
      let customerName = '';
      try {
        const lookup = await fetch(`/api/users/by-wallet/${encodeURIComponent(ids.walletId)}`);
        if (lookup.ok) customerName = (await lookup.json())?.user?.display_name || '';
      } catch { /* ignore */ }

      wifRef.current = trimmed;
      customerRef.current = { hex: customerHex, wallet: ids.walletId, name: customerName };

      const ok = await runPreview();
      if (ok) setPhase('confirm');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('lana.invalidWifKey'));
      setPhase('ready');
    }
  };

  /** Server-authoritative preview: exact recipients + LANA total at the current rate. */
  const runPreview = async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(token || '')}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_hex: customerRef.current.hex,
          customer_wallet: customerRef.current.wallet,
        }),
      });
      const json = await res.json();
      if (res.status === 409 && json?.error === 'REQUEST_NOT_PAYABLE') {
        await loadRequest();
        setPhase('closed');
        return false;
      }
      if (!res.ok || !json.success) {
        setError(json?.error || t('lana.purchaseFailed'));
        setPhase('ready');
        return false;
      }
      if (!Array.isArray(json.data?.recipients) || json.data.recipients.length === 0) {
        setError(t('lana.purchaseFailed'));
        setPhase('ready');
        return false;
      }
      setPreview(json.data);
      return true;
    } catch {
      setError(t('lana.networkError'));
      setPhase('ready');
      return false;
    }
  };

  /** Sign locally + submit. Auto re-previews once on PREVIEW_STALE (split/rate change). */
  const confirmAndPay = async (isRetryAfterStale = false) => {
    if (!preview || !request) return;
    setPhase('paying');
    setError(null);

    let signedTxHex: string;
    try {
      const signed = await signCustomerLanaTx({
        wif: wifRef.current,
        recipients: preview.recipients.map(r => ({ address: r.address, amount: r.amount_lanoshis })),
      });
      signedTxHex = signed.signedTxHex;
    } catch (signErr: any) {
      setError(signErr?.message || t('lana.purchaseFailed'));
      setPhase('confirm');
      return;
    }

    let res: Response;
    let json: any;
    try {
      res = await fetch(`/api/pay/${encodeURIComponent(token || '')}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_hex: customerRef.current.hex,
          customer_wallet: customerRef.current.wallet,
          customer_name: customerRef.current.name,
          signed_tx_hex: signedTxHex,
          allocations: preview.allocations,
        }),
      });
      json = await res.json();
    } catch {
      setError(t('lana.networkError'));
      setPhase('confirm');
      return;
    }

    if (res.ok && json?.success) {
      wifRef.current = ''; // drop the key material immediately
      if (json.alreadyPaid) {
        await loadRequest();
        setPhase('closed');
        return;
      }
      setPaidResult({
        txHash: json.data?.txHash || '',
        lanaPaidLanoshis: json.data?.lanaPaidLanoshis ?? null,
        exchangeRate: json.data?.exchangeRate ?? null,
      });
      setPhase('paid');
      return;
    }

    // Split/rate republished between preview and submit → one automatic
    // re-preview, then ask the customer to confirm the NEW amount.
    if (res.status === 409 && json?.error === 'PREVIEW_STALE') {
      if (!isRetryAfterStale) {
        const ok = await runPreview();
        if (ok) {
          setRateChanged(true);
          setPhase('confirm');
        }
        return;
      }
      setError(t('lana.purchaseFailed'));
      setPhase('confirm');
      return;
    }

    if (res.status === 409 && json?.error === 'REQUEST_NOT_PAYABLE') {
      await loadRequest();
      setPhase('closed');
      return;
    }

    // Same error mapping as LanaTab.
    if (res.status === 409 && json?.error === 'SELF_PURCHASE') {
      setError(t('purchase.cannotSellToYourself'));
    } else if (res.status === 422 && json?.error === 'INVALID_WALLET') {
      setError(json?.field === 'customer_wallet' ? t('purchase.invalidCustomerWallet') : t('purchase.invalidMerchantWallet'));
    } else if (res.status === 402 && json?.error === 'CUSTOMER_LANA_FAILED') {
      setError(t('purchase.customerLanaFailed'));
    } else {
      setError(json?.error || t('lana.purchaseFailed'));
    }
    setPhase('confirm');
  };

  // ── Shared page chrome ───────────────────────────────────────────────────
  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="min-h-screen bg-background flex flex-col items-center px-4 py-8">
      <div className="w-full max-w-md flex flex-col gap-5">
        <div className="flex items-center justify-center gap-2.5 pb-1">
          <img src={lanaIcon} alt="LANA" className="w-8 h-8 object-contain dark:invert" />
          <span className="font-display text-lg font-bold text-foreground">{t('pay.title')}</span>
        </div>
        {children}
      </div>
    </div>
  );

  const RequestCard = () => request && (
    <div className="glass-card rounded-2xl p-5 space-y-3 border">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center shrink-0">
          <Store className="w-5 h-5 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{t('pay.payee')}</p>
          <p className="text-base font-semibold text-foreground truncate">{request.unitName}</p>
        </div>
      </div>
      <div className="flex justify-between items-baseline pt-2 border-t border-border">
        <span className="text-sm text-muted-foreground">{t('cash.invoiceLabel', { number: request.invoiceNumber })}</span>
        <span className="text-2xl font-bold text-foreground">{sym}{request.amountFiat.toFixed(2)}</span>
      </div>
      {request.receiptDescription && (
        <div>
          <p className="text-xs text-muted-foreground">{t('pay.whatYouBuy')}</p>
          <p className="text-sm text-foreground/85 whitespace-pre-wrap break-words">{request.receiptDescription}</p>
        </div>
      )}
      {request.receiptUrl && (
        <a href={request.receiptUrl} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm text-primary underline">
          <Receipt className="w-4 h-4" /> {t('pay.viewReceipt')}
        </a>
      )}
    </div>
  );

  // ── Phases ───────────────────────────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 py-16">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
        </div>
      </Shell>
    );
  }

  if (phase === 'not_found') {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <AlertCircle className="w-12 h-12 text-muted-foreground" />
          <p className="text-base text-muted-foreground">{t('pay.notFound')}</p>
        </div>
      </Shell>
    );
  }

  if (phase === 'closed' && request) {
    return (
      <Shell>
        <RequestCard />
        <div className={`rounded-2xl p-6 border text-center space-y-2 ${
          request.status === 'paid'
            ? 'bg-emerald-50 dark:bg-emerald-500/5 border-emerald-200 dark:border-emerald-500/10'
            : 'bg-muted border-border'
        }`}>
          {request.status === 'paid' ? (
            <>
              <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />
              <p className="text-base font-semibold text-emerald-700 dark:text-emerald-400">{t('pay.alreadyPaid')}</p>
              {request.paidLanaLanoshis ? (
                <p className="text-sm text-muted-foreground">{formatLanoshis(request.paidLanaLanoshis)} LANA</p>
              ) : null}
              {request.txHash && request.txHash.length === 64 && (
                <a href={`https://chainz.cryptoid.info/lana/tx.dws?${request.txHash}`} target="_blank" rel="noopener noreferrer"
                  className="text-xs font-mono text-primary underline break-all block">{request.txHash}</a>
              )}
            </>
          ) : request.status === 'expired' ? (
            <>
              <Clock className="w-10 h-10 text-muted-foreground mx-auto" />
              <p className="text-base font-semibold text-foreground">{t('pay.expiredInfo')}</p>
            </>
          ) : (
            <>
              <XCircle className="w-10 h-10 text-muted-foreground mx-auto" />
              <p className="text-base font-semibold text-foreground">{t('pay.cancelledInfo')}</p>
            </>
          )}
        </div>
      </Shell>
    );
  }

  if (phase === 'checking') {
    return (
      <Shell>
        <RequestCard />
        <div className="flex flex-col items-center gap-3 py-10">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{t('lana.checkingBalance')}</p>
        </div>
      </Shell>
    );
  }

  if (phase === 'confirm' && preview && request) {
    return (
      <Shell>
        <RequestCard />
        {rateChanged && (
          <div className="rounded-2xl bg-amber-50 dark:bg-amber-500/5 border border-amber-200 dark:border-amber-500/10 p-4">
            <p className="text-sm text-amber-700 dark:text-amber-400 text-center">{t('pay.rateUpdatedReconfirm')}</p>
          </div>
        )}
        {error && (
          <div className="rounded-2xl bg-destructive/10 border-2 border-destructive/50 p-4">
            <p className="text-sm font-semibold text-destructive text-center">{error}</p>
          </div>
        )}
        <div className="flex flex-col items-center gap-2 py-4">
          <p className="text-sm text-muted-foreground">{t('pay.youWillPay')}</p>
          <div className="flex items-center gap-3">
            <img src={lanaIcon} alt="Lana" className="w-10 h-10 object-contain dark:invert" />
            <span className="text-5xl font-black text-primary tracking-tight">{formatLanoshis(preview.lanaTotalLanoshis)}</span>
            <span className="text-2xl font-bold text-primary/70">LANA</span>
          </div>
          {preview.exchangeRate ? (
            <p className="text-xs text-muted-foreground">
              {t('lana.rateDisplay', { symbol: sym, rate: parseFloat(preview.exchangeRate.toFixed(8)) })}
            </p>
          ) : null}
        </div>
        <Button
          onClick={() => confirmAndPay(rateChanged)}
          className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
        >
          <CheckCircle2 className="w-5 h-5" />
          {t('pay.confirmAndPay')}
        </Button>
      </Shell>
    );
  }

  if (phase === 'paying') {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center gap-4 py-16">
          <Loader2 className="w-14 h-14 animate-spin text-primary" />
          <h2 className="text-xl font-bold text-foreground">{t('lana.processingTitle')}</h2>
        </div>
      </Shell>
    );
  }

  if (phase === 'paid' && request) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 py-6">
          <CheckCircle2 className="w-14 h-14 text-primary" />
          <h2 className="text-2xl font-bold text-foreground">{t('pay.paidTitle')}</h2>
          <p className="text-lg text-muted-foreground">{t('cash.invoiceLabel', { number: request.invoiceNumber })}</p>
        </div>
        <div className="glass-card rounded-2xl p-5 space-y-3 border">
          <div className="flex justify-between items-baseline">
            <span className="text-sm text-muted-foreground">{t('lana.amountLabel')}</span>
            <span className="text-base font-semibold text-foreground">{sym}{request.amountFiat.toFixed(2)}</span>
          </div>
          {paidResult?.lanaPaidLanoshis ? (
            <div className="flex justify-between items-baseline">
              <span className="text-sm text-muted-foreground">LANA</span>
              <span className="text-base font-bold text-primary">{formatLanoshis(paidResult.lanaPaidLanoshis)} LANA</span>
            </div>
          ) : null}
          {paidResult?.exchangeRate ? (
            <div className="flex justify-between items-baseline">
              <span className="text-sm text-muted-foreground">{t('lana.rateLabel')}</span>
              <span className="text-sm text-foreground">
                {t('lana.rateDisplay', { symbol: sym, rate: parseFloat(paidResult.exchangeRate.toFixed(8)) })}
              </span>
            </div>
          ) : null}
          <div className="pt-2 border-t border-border space-y-1">
            <p className="text-xs text-muted-foreground">{t('pay.payee')}</p>
            <p className="text-sm font-semibold text-foreground">{request.unitName}</p>
          </div>
          {paidResult?.txHash && paidResult.txHash.length === 64 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t('lana.blockchainTx')}</p>
              <a href={`https://chainz.cryptoid.info/lana/tx.dws?${paidResult.txHash}`} target="_blank" rel="noopener noreferrer"
                className="text-xs font-mono text-primary underline break-all">{paidResult.txHash}</a>
            </div>
          )}
        </div>
        <p className="text-sm text-muted-foreground text-center">{t('pay.paidClose')}</p>
      </Shell>
    );
  }

  // ── phase === 'ready' ─────────────────────────────────────────────────────
  return (
    <Shell>
      <RequestCard />

      {/* Indicative LANA + the at-payment-rate note (the money-honesty line) */}
      {request?.indicativeLanaLanoshis ? (
        <div className="flex flex-col items-center gap-1.5 py-2">
          <p className="text-xs text-muted-foreground">{t('pay.indicativeLana')}</p>
          <div className="flex items-center gap-2.5">
            <img src={lanaIcon} alt="Lana" className="w-8 h-8 object-contain dark:invert" />
            <span className="text-4xl font-black text-primary tracking-tight">≈ {formatLanoshis(request.indicativeLanaLanoshis)}</span>
            <span className="text-xl font-bold text-primary/70">LANA</span>
          </div>
          <p className="text-xs text-muted-foreground text-center px-4">{t('pay.finalRateNote')}</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground text-center px-4">{t('pay.finalRateNote')}</p>
      )}

      {/* Frozen wallet */}
      {isFrozen && (
        <div className="rounded-2xl bg-blue-50 border border-blue-200 p-4 space-y-3 dark:bg-blue-950/30 dark:border-blue-800">
          <div className="flex items-center gap-3">
            <Snowflake className="w-5 h-5 text-blue-500 flex-shrink-0" />
            <p className="text-sm font-medium text-blue-700 dark:text-blue-400">{t('lana.walletFrozen')}</p>
          </div>
          <p className="text-xs text-muted-foreground">{t('lana.frozenDescription')}</p>
          <a href="https://unfreeze.lanapays.us" target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full h-11 rounded-xl bg-blue-100 text-blue-700 text-sm font-semibold hover:bg-blue-200 transition-colors dark:bg-blue-900/40 dark:text-blue-400 dark:hover:bg-blue-900/60">
            <ExternalLink className="w-4 h-4" />
            {t('lana.goToUnfreeze')}
          </a>
        </div>
      )}

      {error && (
        <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground text-center">{t('pay.enterWif')}</p>
        <Button
          onClick={() => setScannerOpen(true)}
          className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
        >
          <QrCode className="w-5 h-5" />
          {t('pay.scanWif')}
        </Button>
        {!showManual ? (
          <button onClick={() => setShowManual(true)}
            className="text-xs text-muted-foreground text-center hover:text-foreground transition-colors">
            {t('pay.enterManually')}
          </button>
        ) : (
          <div className="flex gap-2">
            <Input
              type="password"
              autoComplete="off"
              placeholder={t('pay.wifManualPlaceholder')}
              value={manualWif}
              onChange={(e) => setManualWif(e.target.value)}
              className="h-12 rounded-xl bg-background border-input font-mono"
            />
            <Button
              onClick={() => { const v = manualWif; setManualWif(''); handleWif(v); }}
              disabled={!manualWif.trim()}
              className="h-12 rounded-xl px-4"
            >
              <KeyRound className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>

      <QRScanner
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={(d) => { setScannerOpen(false); handleWif(d); }}
        title={t('pay.scanWif')}
        description={t('pay.enterWif')}
        onManualEntry={() => { setScannerOpen(false); setShowManual(true); }}
      />
    </Shell>
  );
};

export default PublicPay;
