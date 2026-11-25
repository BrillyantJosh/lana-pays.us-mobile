/**
 * PublicDirectPay — the public /pay-direct/:token page of a LANA neposredno
 * payment link (Brilly, 25 Nov 2026).
 *
 * A shop without a company sent this link. The customer opens it at home, sees
 * the shop, the invoice, the shop's margin and the total, enters or scans the
 * private key (WIF) of their own LANA card, and pays straight into the shop's
 * wallet, NOT through the brain. Exactly the till's LANA neposredno
 * (DirectLanaTab), in the customer's own browser:
 *
 *   ready    the link and the approximate LANA at the price of now
 *   confirm  the exact LANA and the network fee from the server's plan, which
 *            this page checks against what it showed (the shop's wallet, the
 *            invoice, the margin, this card) before anything is signed
 *   status   sent, in a block, being checked (never "failed" while it may still
 *            be mined), refused (nothing was sent, and why)
 *
 * THE KEY lives only in this page's memory, as bytes, from the moment it is
 * read to the signature, and is zeroed after signing, on cancel, when the quote
 * runs out and when the page closes (lib/directLanaSign.ts). It is never sent
 * anywhere: the server gets the card's PUBLIC key, then the signed payment.
 * After a lost answer the page asks the server and never signs anything new by
 * itself; paying again spends the same coins (a replacement), so only one of
 * the two can ever be in a block.
 *
 * NO session: the link's 192-bit token is the capability.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Loader2, CheckCircle2, AlertCircle, Clock, XCircle, Globe, Store, QrCode, KeyRound, Send, RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { QRScanner } from '@/components/QRScanner';
import { DirectLanaError, centsText, lanaText, type DirectLanaPlan } from '@/lib/directLanaCore';
import { readCardKey, forgetCardKey, checkPlanForCard, signDirectSale, type CardKey, type PlanExpectation } from '@/lib/directLanaSign';
import {
  fetchPayLink, quotePayLink, submitPayLink, resendPayLink, directPayReasonKey, answerCode, OPEN_STATUSES,
} from '@/lib/directLanaApi';
import { formatMoney, formatDecimal, formatLana, shortAddress } from '@/lib/directLanaFormat';
import { exclusionFromRefusal } from '@/lib/exclusion';
import { changeLanguage } from '@/i18n';
import { LANGUAGES } from '@/i18n/languages';
import lanaIcon from '@/assets/lana-icon.png';

/** One payment of the link, as the server shows it to the customer (lib/directLanaLinks.ts publicAttemptView). */
export interface LinkPayment {
  attempt_id: string;
  sale_id: string;
  status: string;
  sent: boolean;
  reason: string | null;
  txid: string | null;
  currency: string;
  invoice_cents: string;
  margin_percent: number;
  pay_cents: string;
  rate: string;
  amount_lanoshi: string;
  fee_lanoshi: string;
  invoice_number: string;
  recipient_wallet: string;
  recipient_name: string;
  record_published: boolean;
  created_at: number;
  expires_at?: number;
}

/** GET /api/direct-pay/:token, as the server writes it. */
export interface LinkView {
  status: 'open' | 'paying' | 'paid' | 'cancelled' | 'expired' | 'closed';
  unit_id: string;
  unit_name: string;
  currency: string;
  invoice_cents: string;
  invoice: string;
  margin_percent: number;
  margin: string;
  pay_cents: string;
  total: string;
  invoice_number: string;
  note: string | null;
  sale_id: string;
  recipient: string | null;
  recipient_hex: string | null;
  price: { rate: string; lanoshi: string; lana: string } | null;
  expires_at: number | null;
  payment: LinkPayment | null;
}

type Phase = 'loading' | 'not_found' | 'closed' | 'ready' | 'quoting' | 'confirm' | 'sending' | 'status';

const DIGITS = /^\d+$/;
/** Refusals after which what the page shows of the shop may be old: it reads the link again. */
const STALE_VIEW = ['PLAN_RECIPIENT_CHANGED', 'PLAN_INVALID', 'WALLET_CHANGED', 'CURRENCY_MISMATCH', 'SALE_MISMATCH'];
/** Is this answer the whole payment (attemptView) of this attempt? Only then is it shown. */
const isPaymentOf = (data: any, attemptId?: string): data is LinkPayment =>
  !!data && typeof data.attempt_id === 'string' && (!attemptId || data.attempt_id === attemptId)
  && typeof data.status === 'string' && typeof data.currency === 'string' && typeof data.sent === 'boolean'
  && [data.invoice_cents, data.pay_cents, data.amount_lanoshi, data.fee_lanoshi].every(v => typeof v === 'string' && DIGITS.test(v));

/**
 * May this payment still change? Then the page keeps asking (never signing
 * anything new): on its way, sent, being checked, refused after it was sent,
 * replaced, or still a quote this page signed whose submit got no answer.
 */
const mayStillChange = (p: Pick<LinkPayment, 'status' | 'sent'>): boolean =>
  OPEN_STATUSES.includes(p.status) || p.status === 'quoted' || p.status === 'superseded' || (p.status === 'refused' && p.sent === true);

/** `pollMs`: how often a payment that may still change is asked about (10 s; a test asks faster). */
const PublicDirectPay = ({ pollMs = 10_000 }: { pollMs?: number }) => {
  const { token = '' } = useParams<{ token: string }>();
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en';

  const [phase, setPhase] = useState<Phase>('loading');
  const [link, setLink] = useState<LinkView | null>(null);
  const [plan, setPlan] = useState<DirectLanaPlan | null>(null);
  const [payment, setPayment] = useState<LinkPayment | null>(null);
  const [refusal, setRefusal] = useState<{ code: string; frame?: 'resend'; ground?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualKey, setManualKey] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [tick, setTick] = useState(0);
  const cardRef = useRef<CardKey | null>(null);
  const confirming = useRef(false);
  const lostSubmit = useRef<string | null>(null);

  const forgetCard = () => {
    forgetCardKey(cardRef.current);
    cardRef.current = null;
  };
  // The page closes: the card's key goes with it.
  useEffect(() => () => forgetCard(), []);

  // The language: the one the customer chose, else the browser's own list of
  // languages (src/i18n initialLocale). Nothing is saved until they choose.

  /** Read the link; show its payment if one is on its way or made. */
  const load = useCallback(async (): Promise<LinkView | null> => {
    try {
      const { status, data } = await fetchPayLink(token);
      if (status === 404) {
        setPhase('not_found');
        return null;
      }
      // Anything else that is not the link (a server being restarted, too many
      // requests from one address) is not "no such link": the page can ask again.
      if (status !== 200 || !data?.success || !data.link) {
        setRefusal({ code: 'NETWORK' });
        setPhase(p => (p === 'loading' || p === 'not_found' ? 'not_found' : p));
        return null;
      }
      const view = data.link as LinkView;
      setLink(view);
      if (view.payment && isPaymentOf(view.payment) && (mayStillChange(view.payment) || view.payment.status === 'paid')) {
        setPayment(view.payment);
        setPhase('status');
      } else if (view.status === 'open') {
        setPayment(null);
        setPhase('ready');
      } else {
        setPhase('closed');
      }
      return view;
    } catch {
      // Not "no such link": the page could not ask. It says so and can ask again.
      setRefusal({ code: 'NETWORK' });
      setPhase(p => (p === 'loading' ? 'not_found' : p));
      return null;
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  // The quote runs out: the key is zeroed, the card must be read again.
  useEffect(() => {
    if (phase !== 'confirm' || !plan) return;
    const second = setInterval(() => setTick(n => n + 1), 1000);
    const end = setTimeout(() => {
      forgetCard();
      setPlan(null);
      setRefusal({ code: 'QUOTE_EXPIRED' });
      setPhase('ready');
    }, Math.max(0, plan.expires * 1000 - Date.now()));
    return () => { clearInterval(second); clearTimeout(end); };
  }, [phase, plan]);

  // While the payment may still change, ask about it (never sign a new one).
  useEffect(() => {
    if (phase !== 'status' || !payment || !mayStillChange(payment)) return;
    const timer = setTimeout(async () => {
      try {
        const { status, data } = await fetchPayLink(token, payment.attempt_id);
        const view = data?.link as (LinkView & { asked?: LinkPayment | null }) | undefined;
        if (status === 200 && view) {
          setLink(view);
          const next = view.payment;
          const own = view.asked && isPaymentOf(view.asked, payment.attempt_id) ? view.asked : null;
          if (next && isPaymentOf(next) && next.attempt_id !== payment.attempt_id && (next.status === 'paid' || mayStillChange(next))) {
            // The link is paid, or another payment of it is on its way (the one
            // that replaced this one, from another tab or at the till): that one.
            setPayment(next);
          } else if (own && own.status !== 'quoted') {
            // This page's own payment, as it is now (in a block, failed, replaced, refused).
            setPayment(own);
          } else if (payment.status === 'quoted' && lostSubmit.current === payment.attempt_id) {
            // A submit that never arrived: the server holds the quote unsent, and it ran out.
            if ((own && own.status === 'quoted' && Date.now() / 1000 > own.expires_at + 5) || (!own && Date.now() / 1000 > payment.created_at + 130)) {
              setPayment({ ...payment, status: 'expired' });
            }
          }
        }
      } catch { /* asked again next time */ }
      setTick(n => n + 1);
    }, pollMs);
    return () => clearTimeout(timer);
  }, [phase, payment, tick, token, pollMs]);

  const expectation = (): PlanExpectation => ({
    unit_id: link?.unit_id || '',
    recipient: link?.recipient || '',
    recipient_hex: link?.recipient_hex || '',
    currency: link?.currency || '',
    invoice_cents: link?.invoice_cents || '',
    margin_percent: link?.margin_percent ?? -1,
    invoice_number: link?.invoice_number ?? '',
    sale_id: link?.sale_id || null,
  });

  const codeOfError = (e: unknown) => (e instanceof DirectLanaError ? e.code : 'NETWORK');

  /** A refusal from the server, in the customer's words (their own exclusion with its ground). */
  const refusalOf = (data: any): { code: string; ground?: string } => {
    const code = answerCode(data) || 'GENERIC';
    const verdict = exclusionFromRefusal(data);
    return verdict ? { code, ground: (verdict.ground || '').trim() } : { code };
  };

  const quote = async (card: CardKey) => {
    setPhase('quoting');
    const askedAt = Date.now();
    try {
      const { status, data } = await quotePayLink(token, card.publicKey);
      if (status !== 200 || !data?.success) {
        forgetCard();
        const r = refusalOf(data);
        // The link itself closed meanwhile: show it as it is now.
        if (['LINK_PAID', 'LINK_CANCELLED', 'LINK_EXPIRED', 'LINK_NOT_FOUND'].includes(r.code)) {
          await load();
          return;
        }
        setRefusal(r);
        setPhase('ready');
        // The shop's wallet or the link changed meanwhile: the page reads it again.
        if (STALE_VIEW.includes(r.code)) void load();
        return;
      }
      const p = data.plan as DirectLanaPlan;
      // The plan must be what this page shows, from this card, to the shop's own wallet.
      checkPlanForCard(p, card, expectation(), Date.now(), askedAt);
      setPlan(p);
      setPhase('confirm');
    } catch (e) {
      forgetCard();
      const code = codeOfError(e);
      setRefusal({ code });
      setPhase('ready');
      // What this page showed is not what the shop is now (another wallet): read it again.
      if (STALE_VIEW.includes(code)) void load();
    }
  };

  const onKey = (input: string) => {
    setRefusal(null);
    forgetCard();
    let card: CardKey;
    try {
      card = readCardKey(input);
    } catch (e) {
      setRefusal({ code: codeOfError(e) });
      return;
    }
    cardRef.current = card;
    void quote(card);
  };

  const cancel = () => {
    forgetCard();
    setPlan(null);
    setPhase('ready');
  };

  const confirm = async () => {
    if (confirming.current || !plan) return;
    confirming.current = true;
    setBusy(true);
    const card = cardRef.current;
    cardRef.current = null;
    let signed: ReturnType<typeof signDirectSale>;
    try {
      if (!card) throw new DirectLanaError('QUOTE_EXPIRED');
      checkPlanForCard(plan, card, expectation(), Date.now());
      signed = signDirectSale(card, plan); // zeroes the key
    } catch (e) {
      forgetCardKey(card);
      setRefusal({ code: codeOfError(e) });
      setPlan(null);
      setPhase('ready');
      confirming.current = false;
      setBusy(false);
      return;
    }
    setPhase('sending');
    // Not known yet: as far as this page knows, still the quote it signed.
    const pending: LinkPayment = {
      attempt_id: plan.attempt_id, sale_id: plan.sale_id, status: 'quoted', sent: false, reason: null, txid: signed.txid,
      currency: plan.currency, invoice_cents: plan.invoice_cents, margin_percent: plan.margin_percent,
      pay_cents: plan.pay_cents, rate: plan.rate, amount_lanoshi: plan.amount, fee_lanoshi: plan.fee,
      invoice_number: plan.invoice_number, recipient_wallet: plan.recipient, recipient_name: plan.unit_name,
      record_published: false, created_at: plan.created_at,
    };
    try {
      const { status, data } = await submitPayLink(token, { attempt_id: plan.attempt_id, raw: signed.raw, record: signed.record });
      if (isPaymentOf(data, plan.attempt_id)) {
        setPayment(data);
        setPhase('status');
        // A replacement refused before it left: the payment it was to replace
        // may still be mined. The customer is told, and the page shows that one.
        if (data.status === 'refused' && !data.sent && typeof (data as any).pending_attempt_id === 'string') {
          setRefusal({ code: 'PREVIOUS_PAYMENT_PENDING' });
          void load();
        } else {
          setRefusal(null);
        }
      } else if (status >= 400 && status < 500) {
        // Refused before anything was kept or sent.
        setPlan(null);
        const r = refusalOf(data);
        if (['LINK_CANCELLED', 'LINK_PAID', 'LINK_EXPIRED'].includes(r.code)) {
          await load();
        } else {
          setRefusal(r);
          setPhase('ready');
        }
      } else {
        lostSubmit.current = plan.attempt_id;
        setPayment(pending);
        setPhase('status');
      }
    } catch {
      // No answer: the payment may have gone out. Only asking can tell.
      lostSubmit.current = plan.attempt_id;
      setPayment(pending);
      setPhase('status');
    } finally {
      confirming.current = false;
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!payment || busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      const { data } = await resendPayLink(token, payment.attempt_id);
      if (isPaymentOf(data, payment.attempt_id)) setPayment(data);
      if (data && data.success === false && answerCode(data)) setRefusal({ code: answerCode(data), frame: 'resend' });
      else if (data?.resend === 'refused') setRefusal({ code: 'RESEND_REFUSED_BY_NETWORK' });
    } catch {
      setRefusal({ code: 'NETWORK', frame: 'resend' });
    } finally {
      setBusy(false);
    }
  };

  /** Pay again with the same card: the server makes it a replacement that spends the same coins. */
  const payAgain = () => {
    setRefusal(null);
    setPlan(null);
    setPhase('ready');
    setScannerOpen(true);
  };

  // ── words ──
  const reasonText = (r: { code: string; frame?: 'resend'; ground?: string }) => {
    const { key, sentence } = directPayReasonKey(r.code);
    const said = sentence ? t(key) : t(r.frame === 'resend' ? 'directPay.resendRefused' : 'directPay.refused', { reason: t(key) });
    return r.ground ? `${said} ${r.ground}` : said;
  };
  // An amount this page cannot read is shown as a dash, never as a crash.
  const money = (cents: string, currency: string) => {
    try {
      return formatMoney(centsText(BigInt(cents)), currency, locale);
    } catch {
      return '–';
    }
  };
  const lana = (lanoshi: string) => {
    try {
      return formatLana(lanaText(BigInt(lanoshi)), locale);
    } catch {
      return '–';
    }
  };

  // ── page chrome (plain render functions, never component types defined here) ──
  const currentLang = (i18n.language || 'en').split('-')[0];
  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-background flex flex-col items-center px-4 py-8">
      <div className="w-full max-w-md flex flex-col gap-5">
        <div className="flex items-center justify-between gap-2 pb-1">
          <div className="flex items-center gap-2.5 min-w-0">
            <img src={lanaIcon} alt="LANA" className="w-8 h-8 object-contain dark:invert shrink-0" />
            <span className="font-display text-lg font-bold text-foreground truncate">{t('directPay.title')}</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Globe className="w-4 h-4 text-muted-foreground" />
            <select
              value={currentLang}
              onChange={(e) => changeLanguage(e.target.value)}
              aria-label="Language"
              className="h-9 rounded-lg bg-background border border-input px-2 text-sm text-foreground"
            >
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.native}</option>)}
            </select>
          </div>
        </div>
        {children}
      </div>
    </div>
  );

  const refusalBox = () => refusal && (
    <div data-testid="pay-direct-refusal" className="rounded-2xl bg-destructive/10 border-2 border-destructive/40 p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
        <p className="text-base font-semibold text-destructive leading-snug">{reasonText(refusal)}</p>
      </div>
    </div>
  );

  /** The shop, what is paid for and the total, with the margin as its own line. */
  const linkCard = () => link && (
    <div className="glass-card rounded-2xl p-5 space-y-3 border">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center shrink-0">
          <Store className="w-5 h-5 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{t('pay.payee')}</p>
          <p data-testid="pay-direct-shop" className="text-base font-semibold text-foreground truncate">{link.unit_name}</p>
        </div>
      </div>
      {link.invoice_number && (
        <p className="text-sm text-muted-foreground">{t('directPay.invoiceNumber', { number: link.invoice_number })}</p>
      )}
      {link.note && (
        <div data-testid="pay-direct-note">
          <p className="text-xs text-muted-foreground">{t('pay.noteFromSeller')}</p>
          <p className="text-sm text-foreground break-words">{link.note}</p>
        </div>
      )}
      <div className="space-y-1.5 pt-2 border-t border-border">
        <div className="flex justify-between items-baseline gap-3">
          <span className="text-sm text-muted-foreground">{t('directLana.invoiceAmount')}</span>
          <span className="text-base font-semibold text-foreground">{money(link.invoice_cents, link.currency)}</span>
        </div>
        {link.margin_percent > 0 && (
          <div className="flex justify-between items-baseline gap-3">
            <span className="text-sm text-muted-foreground">{t('directLana.marginLine', { percent: link.margin_percent })}</span>
            <span className="text-base font-semibold text-foreground">+{money((BigInt(link.pay_cents) - BigInt(link.invoice_cents)).toString(), link.currency)}</span>
          </div>
        )}
        <div className="flex justify-between items-baseline gap-3">
          <span className="text-sm font-semibold text-foreground">{t('directLana.toPay')}</span>
          <span data-testid="pay-direct-total" className="text-xl font-bold text-foreground">{money(link.pay_cents, link.currency)}</span>
        </div>
      </div>
    </div>
  );

  // ── phases ──
  if (phase === 'loading') {
    return shell(<div className="flex justify-center py-16"><Loader2 className="w-10 h-10 animate-spin text-primary" /></div>);
  }

  if (phase === 'not_found' || !link) {
    const offline = refusal?.code === 'NETWORK';
    return shell(
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <AlertCircle className="w-12 h-12 text-muted-foreground" />
        <p className="text-base text-muted-foreground">{offline ? t('lana.networkError') : t('directPay.notFound')}</p>
        {offline && (
          <Button data-testid="pay-direct-reload" variant="outline" className="h-11 rounded-xl" onClick={() => { setRefusal(null); setPhase('loading'); void load(); }}>
            {t('directPay.tryAgain')}
          </Button>
        )}
      </div>,
    );
  }

  if (phase === 'closed') {
    const paid = link.status === 'paid';
    return shell(<>
      {linkCard()}
      <div data-testid={`pay-direct-closed-${link.status}`} className={`rounded-2xl p-6 border text-center space-y-2 ${paid ? 'bg-emerald-50 dark:bg-emerald-500/5 border-emerald-200 dark:border-emerald-500/10' : 'bg-muted border-border'}`}>
        {paid ? <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />
          : link.status === 'expired' ? <Clock className="w-10 h-10 text-muted-foreground mx-auto" />
            : <XCircle className="w-10 h-10 text-muted-foreground mx-auto" />}
        <p className="text-base font-semibold text-foreground">
          {t(paid ? 'directPay.alreadyPaid' : link.status === 'expired' ? 'directPay.expiredInfo' : link.status === 'cancelled' ? 'directPay.cancelledInfo' : 'directPay.closedInfo')}
        </p>
      </div>
      {/* Closed for now only (the shop, or no price at the moment): it can be asked again. */}
      {link.status === 'closed' && (
        <Button data-testid="pay-direct-reload" variant="outline" className="w-full h-12 rounded-2xl" onClick={() => { setRefusal(null); void load(); }}>
          {t('directPay.tryAgain')}
        </Button>
      )}
    </>);
  }

  if (phase === 'ready' || phase === 'quoting') {
    return shell(<>
      {linkCard()}
      {link.price && (
        <div className="flex flex-col items-center gap-1.5 py-1">
          <p className="text-xs text-muted-foreground">{t('pay.indicativeLana')}</p>
          <div className="flex items-center gap-2.5">
            <img src={lanaIcon} alt="" className="w-8 h-8 object-contain dark:invert" />
            <span data-testid="pay-direct-lana" className="text-4xl font-black text-primary tracking-tight">≈ {lana(link.price.lanoshi)}</span>
          </div>
          <p className="text-xs text-muted-foreground">(1 LANA = {formatMoney(link.price.rate, link.currency, locale)})</p>
          <p className="text-xs text-muted-foreground text-center px-4">{t('directPay.priceNote')}</p>
        </div>
      )}
      {refusalBox()}
      {phase === 'quoting' ? (
        <div className="flex flex-col items-center gap-3 py-4">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{t('directLana.preparing')}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground text-center">{t('directPay.enterKey')}</p>
          <Button
            data-testid="pay-direct-scan"
            onClick={() => { setRefusal(null); setScannerOpen(true); }}
            className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
          >
            <QrCode className="w-5 h-5" />
            {t('pay.scanWif')}
          </Button>
          {!showManual ? (
            <button onClick={() => setShowManual(true)} className="text-xs text-muted-foreground text-center hover:text-foreground transition-colors">
              {t('pay.enterManually')}
            </button>
          ) : (
            <div className="flex gap-2">
              <Input
                data-testid="pay-direct-key"
                type="password"
                autoComplete="off"
                placeholder={t('pay.wifManualPlaceholder')}
                value={manualKey}
                onChange={(e) => setManualKey(e.target.value)}
                className="h-12 rounded-xl bg-background border-input font-mono"
              />
              <Button
                data-testid="pay-direct-key-go"
                onClick={() => { const v = manualKey; setManualKey(''); onKey(v); }}
                disabled={!manualKey.trim()}
                className="h-12 rounded-xl px-4"
                aria-label={t('pay.enterManually')}
              >
                <KeyRound className="w-4 h-4" />
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground text-center">{t('directPay.directNote')}</p>
        </div>
      )}
      <QRScanner
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={(d) => { setScannerOpen(false); onKey(d); }}
        title={t('pay.scanWif')}
        description={t('directPay.enterKey')}
        onManualEntry={() => { setScannerOpen(false); setShowManual(true); }}
      />
    </>);
  }

  if (phase === 'confirm' && plan) {
    const left = Math.max(0, plan.expires - Math.floor(Date.now() / 1000));
    void tick;
    return shell(<>
      {linkCard()}
      {link.price && link.price.lanoshi !== plan.amount && (
        <div data-testid="pay-direct-price-changed" className="rounded-2xl bg-amber-50 dark:bg-amber-500/5 border-2 border-amber-300 dark:border-amber-500/30 p-4">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">{t('directLana.priceChanged', { lana: formatDecimal(lanaText(BigInt(plan.amount)), locale) })}</p>
        </div>
      )}
      <div className="rounded-2xl bg-primary/5 border-2 border-primary/30 p-5 space-y-2">
        <p className="text-sm text-muted-foreground">{t('pay.youWillPay')}</p>
        <p data-testid="pay-direct-exact" className="text-3xl font-black text-primary">{lana(plan.amount)}</p>
        <p data-testid="pay-direct-confirm-text" className="text-base font-semibold text-foreground leading-snug">
          {t('directPay.confirmText', {
            lana: formatDecimal(lanaText(BigInt(plan.amount)), locale),
            fee: formatDecimal(lanaText(BigInt(plan.fee)), locale),
            name: plan.unit_name,
            wallet: shortAddress(plan.recipient),
          })}
        </p>
        <p className="text-xs text-muted-foreground">{t('directLana.expiresIn', { seconds: left })}</p>
      </div>
      {refusalBox()}
      <Button
        data-testid="pay-direct-confirm"
        onClick={confirm}
        disabled={busy}
        className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <><CheckCircle2 className="w-5 h-5" />{t('pay.confirmAndPay')}</>}
      </Button>
      <Button data-testid="pay-direct-cancel" variant="outline" className="w-full h-12 rounded-2xl" onClick={cancel} disabled={busy}>
        {t('common.cancel')}
      </Button>
    </>);
  }

  if (phase === 'sending') {
    return shell(
      <div className="flex flex-col items-center justify-center gap-4 py-16">
        <Loader2 className="w-14 h-14 animate-spin text-primary" />
        <p className="text-lg font-semibold text-foreground">{t('directLana.sending')}</p>
      </div>,
    );
  }

  // ── status ──
  const a = payment;
  if (!a) return null;
  const txLink = a.txid && a.status !== 'refused' && a.status !== 'expired' && a.status !== 'quoted' ? (
    <a href={`https://chainz.cryptoid.info/lana/tx.dws?${a.txid}`} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-primary underline break-all">{a.txid}</a>
  ) : null;
  const amounts = (
    <p data-testid="pay-direct-paid-amounts" className="text-base text-foreground text-center">
      {money(a.pay_cents, a.currency)} · {lana(a.amount_lanoshi)}
    </p>
  );
  return shell(
    <div className="flex flex-col gap-5" data-testid={`pay-direct-status-${a.status}`}>
      {(a.status === 'validating' || a.status === 'broadcasting') && (
        <div className="flex flex-col items-center gap-3 py-8">
          <Loader2 className="w-14 h-14 animate-spin text-primary" />
          <p className="text-lg font-semibold text-foreground">{t('directLana.sending')}</p>
        </div>
      )}
      {(a.status === 'sent' || a.status === 'paid') && (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <CheckCircle2 className="w-14 h-14 text-primary" />
          <h2 className="text-2xl font-bold text-foreground">{t(a.status === 'paid' ? 'directPay.paidTitle' : 'directPay.sentTitle')}</h2>
          {amounts}
          <p className="text-sm text-muted-foreground">{t(a.status === 'paid' ? 'directPay.paidText' : 'directPay.sentText')}</p>
          <p className="text-xs text-muted-foreground">{t('pay.payee')}: {a.recipient_name}</p>
          {txLink}
        </div>
      )}
      {(a.status === 'unknown' || a.status === 'quoted') && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-blue-50 border-2 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800 p-6">
            <div className="flex flex-col items-center text-center gap-3">
              <Clock className="w-12 h-12 text-blue-500" />
              <p className="text-lg font-bold text-blue-700 dark:text-blue-400">{t('directPay.unknownTitle')}</p>
              <p className="text-base font-medium text-blue-700 dark:text-blue-300 leading-snug">{t('directPay.unknownText')}</p>
            </div>
          </div>
          {amounts}
          {a.status === 'unknown' && (
            <>
              <Button data-testid="pay-direct-resend" variant="outline" className="w-full h-12 rounded-2xl gap-2" onClick={resend} disabled={busy}>
                <Send className="w-4 h-4" /> {t('directPay.resend')}
              </Button>
              <p className="text-xs text-muted-foreground text-center">{t('directPay.resendHint')}</p>
            </>
          )}
          <Button data-testid="pay-direct-pay-again" variant="outline" className="w-full h-12 rounded-2xl gap-2" onClick={payAgain} disabled={busy}>
            <RefreshCw className="w-4 h-4" /> {t('directPay.payAgain')}
          </Button>
          <p className="text-xs text-muted-foreground text-center">{t('directPay.payAgainHint')}</p>
        </div>
      )}
      {a.status === 'refused' && a.sent && (
        <div className="space-y-4">
          <div data-testid="pay-direct-refused-sent" className="rounded-2xl bg-amber-50 dark:bg-amber-500/5 border-2 border-amber-300 dark:border-amber-500/30 p-6 text-center">
            <AlertCircle className="w-12 h-12 text-amber-600 mx-auto" />
            <p className="text-base font-semibold text-amber-800 dark:text-amber-300 leading-snug mt-3">{t('directPay.refusedSentText')}</p>
          </div>
          {amounts}
          <Button data-testid="pay-direct-resend" variant="outline" className="w-full h-12 rounded-2xl gap-2" onClick={resend} disabled={busy}>
            <Send className="w-4 h-4" /> {t('directPay.resend')}
          </Button>
          <p className="text-xs text-muted-foreground text-center">{t('directPay.resendHint')}</p>
          <Button data-testid="pay-direct-pay-again" className="w-full h-12 rounded-2xl gap-2" onClick={payAgain} disabled={busy}>
            <RefreshCw className="w-4 h-4" /> {t('directPay.payAgain')}
          </Button>
          <p className="text-xs text-muted-foreground text-center">{t('directPay.payAgainHint')}</p>
        </div>
      )}
      {((a.status === 'refused' && !a.sent) || a.status === 'expired') && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-destructive/10 border-2 border-destructive/50 p-6 text-center">
            <AlertCircle className="w-12 h-12 text-destructive mx-auto" />
            <p className="text-base font-semibold text-destructive leading-snug mt-3">
              {reasonText({ code: a.status === 'expired'
                ? (lostSubmit.current === a.attempt_id ? 'NOT_RECEIVED' : 'QUOTE_EXPIRED')
                : (a.reason || 'BROADCAST_REFUSED') })}
            </p>
          </div>
          <Button data-testid="pay-direct-try-again" className="w-full h-12 rounded-2xl" onClick={payAgain}>{t('directPay.tryAgain')}</Button>
        </div>
      )}
      {a.status === 'failed' && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-destructive/10 border-2 border-destructive/50 p-6 text-center">
            <AlertCircle className="w-12 h-12 text-destructive mx-auto" />
            <p className="text-lg font-bold text-destructive mt-3">{t('directLana.failedTitle')}</p>
            <p className="text-sm text-destructive mt-1">{t('directLana.failedText')}</p>
          </div>
          <Button data-testid="pay-direct-try-again" className="w-full h-12 rounded-2xl" onClick={payAgain}>{t('directPay.tryAgain')}</Button>
        </div>
      )}
      {a.status === 'superseded' && (
        <div className="rounded-2xl bg-muted p-6 text-center">
          <RefreshCw className="w-10 h-10 text-muted-foreground mx-auto" />
          <p className="text-sm text-foreground mt-2">{t('directLana.supersededText')}</p>
        </div>
      )}
      {refusalBox()}
    </div>,
  );
};

export default PublicDirectPay;
