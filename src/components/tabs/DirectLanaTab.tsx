/**
 * LANA neposredno at the till: a shop without a company takes LANA from the
 * customer's card straight into the owner's wallet, with the shop's margin on
 * top, not through the brain (server/directLana.ts).
 *
 *   entry      the invoice amount, and an invoice number if the seller has one
 *   breakdown  invoice, margin, total, LANA at the price, "the customer pays
 *              the network fee"; then the customer's card is scanned
 *   confirm    the exact LANA, the fee and the shop; nothing can be undone
 *   status     sent, paid (in a block), unknown (being checked: no second
 *              payment), refused (nothing was sent, and why)
 *   list       the shop's direct sales
 *
 * The card's key lives only in this component's memory, as bytes, from the
 * scan to the signature, and is zeroed after signing, on cancel, when the quote
 * runs out and when the tab closes (lib/directLanaSign.ts). After a lost answer
 * the till asks the server about the payment and never signs a new one by
 * itself; a new payment for the same sale spends the same coins (a
 * replacement), so only one of them can ever be in a block.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, CheckCircle2, AlertCircle, Clock, ListChecks, RefreshCw, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { QRScanner } from '@/components/QRScanner';
import { useAuth } from '@/contexts/AuthContext';
import { DirectLanaError, centsText, lanaText, type DirectLanaPlan } from '@/lib/directLanaCore';
import { readCardKey, forgetCardKey, checkPlanForCard, signDirectSale, type CardKey, type PlanExpectation } from '@/lib/directLanaSign';
import {
  fetchDirectPrice, requestDirectQuote, submitDirectSale, fetchDirectSale, fetchDirectSales, resendDirectSale,
  OPEN_STATUSES, directReasonKey, answerCode,
} from '@/lib/directLanaApi';
import { formatMoney, formatDecimal, formatLana, shortAddress } from '@/lib/directLanaFormat';
import lanaIcon from '@/assets/lana-icon.png';

export interface DirectLanaUnit {
  unit_id: string;
  name: string;
  currency: string;
  owner_hex: string;
  lanapays_payout_wallet?: string | null;
}

/** GET /api/direct-lana/price, as the server writes it: exact strings. */
interface Price {
  currency: string;
  invoice_cents: string;
  invoice: string;
  margin_percent: number;
  margin: string;
  pay_cents: string;
  total: string;
  lanoshi: string;
  lana: string;
  rate: string;
  recipient: string;
  recipient_name: string;
}

/** One attempt as the server shows it (lib/directLanaStore.ts attemptView). */
export interface DirectAttempt {
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
}

/** The sale an attempt belongs to, as the price step would have shown it (to pay it again). */
function priceOfAttempt(a: DirectAttempt): Price {
  const invoice = BigInt(a.invoice_cents);
  const pay = BigInt(a.pay_cents);
  return {
    currency: a.currency,
    invoice_cents: a.invoice_cents,
    invoice: centsText(invoice),
    margin_percent: a.margin_percent,
    margin: centsText(pay - invoice),
    pay_cents: a.pay_cents,
    total: centsText(pay),
    lanoshi: a.amount_lanoshi,
    lana: lanaText(BigInt(a.amount_lanoshi)),
    rate: a.rate,
    recipient: a.recipient_wallet,
    recipient_name: a.recipient_name,
  };
}

type Step = 'entry' | 'breakdown' | 'quoting' | 'confirm' | 'sending' | 'status' | 'list';

const CURRENCY_SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };

/**
 * May this attempt still change? Then the till keeps asking about it (never
 * signing anything new): on its way, sent, being checked, and also one every
 * server refused after it was sent, or one that was replaced, since either may
 * still turn up in a block. And one still 'quoted' after this till signed it:
 * its submit never arrived, and until the quote runs out on the server it still
 * could (the server then calls it expired, for certain).
 */
const mayStillChange = (a: Pick<DirectAttempt, 'status' | 'sent'>): boolean =>
  OPEN_STATUSES.includes(a.status) || a.status === 'quoted' || a.status === 'superseded' || (a.status === 'refused' && a.sent === true);

/**
 * May this attempt still end up in a block though it is not known to be on its
 * way? Then a new payment is started only after the seller says it is for
 * another purchase (the customer may otherwise pay twice).
 */
const stillUnsettled = (a: Pick<DirectAttempt, 'status' | 'sent'>): boolean =>
  mayStillChange(a) && a.status !== 'sent';

const DIGITS = /^\d+$/;
/** Is this answer the whole attempt (lib/directLanaStore.ts attemptView) of this payment? Only then is it shown. */
const isAttemptOf = (data: any, attemptId: string): data is DirectAttempt =>
  !!data && data.attempt_id === attemptId && typeof data.status === 'string' && typeof data.currency === 'string'
  && typeof data.sent === 'boolean'
  && [data.invoice_cents, data.pay_cents, data.amount_lanoshi, data.fee_lanoshi].every(v => typeof v === 'string' && DIGITS.test(v));

/** The attempt that replaced this one, from its reason ("SUPERSEDED_BY dla_…"), or null. */
const replacedBy = (a: Pick<DirectAttempt, 'status' | 'reason'>): string | null => {
  const m = a.status === 'superseded' ? /^SUPERSEDED_BY (dla_[0-9a-f]{32})$/.exec(a.reason || '') : null;
  return m ? m[1] : null;
};

/**
 * `pollMs`: how often a payment that may still change is asked about (8 s at
 * the till; a test asks faster).
 */
const DirectLanaTab = ({ unit, pollMs = 8000 }: { unit: DirectLanaUnit; pollMs?: number }) => {
  const { t, i18n } = useTranslation();
  const { session } = useAuth();
  const locale = i18n.language || 'en';

  const [step, setStep] = useState<Step>('entry');
  const [amount, setAmount] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [price, setPrice] = useState<Price | null>(null);
  const [plan, setPlan] = useState<DirectLanaPlan | null>(null);
  const [saleId, setSaleId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<DirectAttempt | null>(null);
  // `frame` 'resend': the refusal of a re-send of a payment that may still be
  // mined. It is said as "not sent again", never as "LANA were not sent".
  const [refusal, setRefusal] = useState<{ code: string; pendingAttempt?: string; frame?: 'resend' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [sales, setSales] = useState<DirectAttempt[] | null>(null);
  const [tick, setTick] = useState(0);
  // "New payment" pressed while the shown payment may still be mined: asked first.
  const [confirmingNew, setConfirmingNew] = useState(false);
  const cardRef = useRef<CardKey | null>(null);
  const confirming = useRef(false);
  // The attempt whose submit got no answer at all from this till's point of view.
  const lostSubmit = useRef<string | null>(null);

  const forgetCard = () => {
    forgetCardKey(cardRef.current);
    cardRef.current = null;
  };
  // The tab closes: the card's key goes with it.
  useEffect(() => () => forgetCard(), []);

  const wallet = unit.lanapays_payout_wallet || '';
  const expectation = (): PlanExpectation => ({
    unit_id: unit.unit_id,
    recipient: wallet,
    recipient_hex: unit.owner_hex,
    currency: price?.currency || unit.currency,
    invoice_cents: price?.invoice_cents || '',
    margin_percent: price?.margin_percent ?? -1,
    invoice_number: invoiceNumber.trim(),
    sale_id: saleId,
  });

  const reasonText = (code: string, frame?: 'resend') => {
    const { key, sentence } = directReasonKey(code);
    if (sentence) return t(key);
    return t(frame === 'resend' ? 'directLana.resendRefused' : 'directLana.refused', { reason: t(key) });
  };
  const codeOfError = (e: unknown) => (e instanceof DirectLanaError ? e.code : 'NETWORK');

  // The quote runs out: the key is zeroed, the card must be scanned again.
  useEffect(() => {
    if (step !== 'confirm' || !plan) return;
    const second = setInterval(() => setTick(n => n + 1), 1000);
    const end = setTimeout(() => {
      forgetCard();
      setPlan(null);
      setRefusal({ code: 'QUOTE_EXPIRED' });
      setStep('breakdown');
    }, Math.max(0, plan.expires * 1000 - Date.now()));
    return () => { clearInterval(second); clearTimeout(end); };
  }, [step, plan]);

  // While a payment may still change, ask about it (never sign a new one).
  useEffect(() => {
    if (step !== 'status' || !attempt || !mayStillChange(attempt)) return;
    const timer = setTimeout(async () => {
      try {
        const { status, data } = await fetchDirectSale(session, attempt.attempt_id);
        if (status === 200 && data?.success && isAttemptOf(data, attempt.attempt_id)) setAttempt(data);
      } catch { /* asked again next time */ }
      setTick(n => n + 1);
    }, pollMs);
    return () => clearTimeout(timer);
  }, [step, attempt, tick, session, pollMs]);

  const loadPrice = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const { status, data } = await fetchDirectPrice(session, unit.unit_id, amount.trim());
      if (status === 200 && data?.success) {
        setPrice(data);
        setSaleId(null);
        setStep('breakdown');
      } else {
        setRefusal({ code: answerCode(data) || 'GENERIC' });
      }
    } catch {
      setRefusal({ code: 'NETWORK' });
    } finally {
      setBusy(false);
    }
  };

  const quote = async (card: CardKey) => {
    if (!price) return;
    setStep('quoting');
    const askedAt = Date.now();
    try {
      const { status, data } = await requestDirectQuote(session, {
        unit_id: unit.unit_id,
        amount: price.invoice,
        currency: price.currency,
        public_key: card.publicKey,
        ...(invoiceNumber.trim() ? { invoice_number: invoiceNumber.trim() } : {}),
        ...(saleId ? { sale_id: saleId } : {}),
      });
      if (status !== 200 || !data?.success) {
        forgetCard();
        setRefusal({ code: answerCode(data) || 'GENERIC', pendingAttempt: data?.pending_attempt_id });
        setStep('breakdown');
        return;
      }
      const p = data.plan as DirectLanaPlan;
      // The plan must be what this till shows, from this card, to the shop's own wallet.
      if (price.recipient !== wallet) throw new DirectLanaError('PLAN_RECIPIENT_CHANGED');
      checkPlanForCard(p, card, { ...expectation(), sale_id: saleId }, Date.now(), askedAt);
      setPlan(p);
      setSaleId(p.sale_id);
      setStep('confirm');
    } catch (e) {
      forgetCard();
      setRefusal({ code: codeOfError(e) });
      setStep('breakdown');
    }
  };

  const onScan = (data: string) => {
    setRefusal(null);
    forgetCard();
    let card: CardKey;
    try {
      card = readCardKey(data);
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
    setStep('breakdown');
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
      setStep('breakdown');
      confirming.current = false;
      setBusy(false);
      return;
    }
    setStep('sending');
    // Not known to the till yet: as far as it knows, still the quote it signed.
    // The server says what it is (and calls it expired once it can no longer be sent).
    const pending: DirectAttempt = {
      attempt_id: plan.attempt_id, sale_id: plan.sale_id, status: 'quoted', sent: false, reason: null, txid: signed.txid,
      currency: plan.currency, invoice_cents: plan.invoice_cents, margin_percent: plan.margin_percent,
      pay_cents: plan.pay_cents, rate: plan.rate, amount_lanoshi: plan.amount, fee_lanoshi: plan.fee,
      invoice_number: plan.invoice_number, recipient_wallet: plan.recipient, recipient_name: plan.unit_name,
      record_published: false, created_at: plan.created_at,
    };
    try {
      const { status, data } = await submitDirectSale(session, { attempt_id: plan.attempt_id, raw: signed.raw, record: signed.record });
      if (isAttemptOf(data, plan.attempt_id)) {
        setAttempt(data);
        // A replacement refused before it left: the payment it was to replace
        // may still be mined. The seller is told, and can open it.
        if (data.status === 'refused' && !data.sent && typeof (data as any).pending_attempt_id === 'string') {
          setRefusal({ code: 'PREVIOUS_PAYMENT_PENDING', pendingAttempt: (data as any).pending_attempt_id });
        }
        setStep('status');
      } else if (status >= 400 && status < 500) {
        // Refused before anything was kept or sent.
        setRefusal({ code: answerCode(data) || 'GENERIC' });
        setPlan(null);
        setStep('breakdown');
      } else {
        lostSubmit.current = plan.attempt_id;
        setAttempt(pending);
        setStep('status');
      }
    } catch {
      // No answer: the payment may have gone out. Only asking can tell.
      lostSubmit.current = plan.attempt_id;
      setAttempt(pending);
      setStep('status');
    } finally {
      confirming.current = false;
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!attempt || busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      const { data } = await resendDirectSale(session, attempt.attempt_id);
      if (isAttemptOf(data, attempt.attempt_id)) setAttempt(data);
      // Not sent again, and why. The payment itself may still be mined: it is
      // never said as "LANA were not sent".
      if (data && data.success === false && answerCode(data)) setRefusal({ code: answerCode(data), frame: 'resend' });
      // Every server refused the same bytes again: say so; the status stays what the chain says.
      else if (data?.resend === 'refused') setRefusal({ code: 'RESEND_REFUSED_BY_NETWORK' });
    } catch {
      setRefusal({ code: 'NETWORK', frame: 'resend' });
    } finally {
      setBusy(false);
    }
  };

  /** A new payment for this sale with the same card: it spends the same coins. */
  const payAgain = () => {
    setRefusal(null);
    setPlan(null);
    setStep('breakdown');
    setScannerOpen(true);
  };

  /** Open an earlier attempt: its status, and its sale, so it can be paid again the safe way. */
  const showSale = async (attemptId: string) => {
    try {
      const { status, data } = await fetchDirectSale(session, attemptId);
      if (status === 200 && data?.success && isAttemptOf(data, attemptId)) {
        forgetCard();
        setConfirmingNew(false);
        setAttempt(data);
        setSaleId(data.sale_id);
        setPrice(priceOfAttempt(data));
        setInvoiceNumber(data.invoice_number || '');
        setPlan(null);
        setRefusal(null);
        setStep('status');
      }
    } catch { /* stays where it is */ }
  };

  const openList = async () => {
    setStep('list');
    setSales(null);
    try {
      const { status, data } = await fetchDirectSales(session, unit.unit_id);
      setSales(status === 200 && Array.isArray(data?.sales) ? data.sales : []);
    } catch {
      setSales([]);
    }
  };

  const newSale = () => {
    forgetCard();
    setAmount('');
    setInvoiceNumber('');
    setPrice(null);
    setPlan(null);
    setSaleId(null);
    setAttempt(null);
    setRefusal(null);
    setConfirmingNew(false);
    setStep('entry');
  };

  /** "New payment": asked first while the payment shown may still be mined (the customer could pay twice). */
  const askNewSale = () => {
    if (attempt && stillUnsettled(attempt)) {
      setConfirmingNew(true);
      return;
    }
    newSale();
  };

  /** Back from the list: to the payment that was shown, if one was. */
  const backFromList = () => {
    if (attempt) {
      setStep('status');
      return;
    }
    newSale();
  };

  // An amount the till cannot read is shown as a dash, never as a crash.
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

  const refusalBox = refusal && (
    <div data-testid="direct-refusal" className="rounded-2xl bg-destructive/10 border-2 border-destructive/40 p-4 space-y-3">
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
        <p className="text-base font-semibold text-destructive leading-snug">{reasonText(refusal.code, refusal.frame)}</p>
      </div>
      {refusal.pendingAttempt && (
        <Button variant="outline" className="w-full h-11 rounded-xl" onClick={() => showSale(refusal.pendingAttempt!)}>
          {t('directLana.showPending')}
        </Button>
      )}
    </div>
  );

  const header = (
    <div className="flex items-center gap-4">
      <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
        <img src={lanaIcon} alt="LANA" className="w-7 h-7 object-contain dark:invert" />
      </div>
      <div>
        <h2 className="font-display text-xl font-bold text-foreground">{t('directLana.title')}</h2>
        <p className="text-muted-foreground text-sm">{t('directLana.subtitle')}</p>
      </div>
    </div>
  );

  /** The breakdown: invoice, margin, total, LANA at the price, who pays the fee. */
  const breakdown = (b: { currency: string; invoice_cents: string; margin_percent: number; pay_cents: string; lanoshi: string; rate: string }) => (
    <div data-testid="direct-breakdown" className="glass-card rounded-2xl p-5 space-y-2">
      <div className="flex justify-between items-baseline gap-3">
        <span className="text-sm text-muted-foreground">{t('directLana.invoiceAmount')}</span>
        <span className="text-base font-semibold text-foreground">{money(b.invoice_cents, b.currency)}</span>
      </div>
      {b.margin_percent > 0 && (
        <div className="flex justify-between items-baseline gap-3">
          <span className="text-sm text-muted-foreground">{t('directLana.marginLine', { percent: b.margin_percent })}</span>
          <span className="text-base font-semibold text-foreground">+{money((BigInt(b.pay_cents) - BigInt(b.invoice_cents)).toString(), b.currency)}</span>
        </div>
      )}
      <div className="flex justify-between items-baseline gap-3 pt-2 border-t border-border">
        <span className="text-sm font-semibold text-foreground">{t('directLana.toPay')}</span>
        <span className="text-lg font-bold text-foreground">{money(b.pay_cents, b.currency)}</span>
      </div>
      <div className="flex items-center justify-center gap-2 py-2">
        <img src={lanaIcon} alt="" className="w-8 h-8 object-contain dark:invert" />
        <span data-testid="direct-lana-amount" className="text-4xl font-black text-primary tracking-tight">= {lana(b.lanoshi)}</span>
      </div>
      <p className="text-xs text-muted-foreground text-center">(1 LANA = {formatMoney(b.rate, b.currency, locale)})</p>
      <p className="text-xs text-muted-foreground text-center">{t('directLana.feeByCustomer')}</p>
    </div>
  );

  if (step === 'list') {
    return (
      <div className="flex flex-col gap-4 px-6 py-4">
        <h2 className="font-display text-xl font-bold text-foreground">{t('directLana.listTitle')}</h2>
        {sales === null ? (
          <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto" />
        ) : sales.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('directLana.listEmpty')}</p>
        ) : (
          <ul className="space-y-2">
            {sales.map(s => (
              <li key={s.attempt_id} data-testid="direct-sale-row">
                <button onClick={() => showSale(s.attempt_id)} className="w-full text-left rounded-xl border border-border p-3 hover:bg-accent">
                  <div className="flex justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">{money(s.pay_cents, s.currency)} · {lana(s.amount_lanoshi)}</span>
                    <span className="text-xs font-medium text-muted-foreground">{t(`directLana.status.${s.status}`)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(s.created_at * 1000).toLocaleString(locale)}{s.invoice_number ? ` · ${s.invoice_number}` : ''}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        <Button data-testid="direct-list-back" variant="outline" className="w-full h-12 rounded-2xl" onClick={backFromList}>{t('common.back')}</Button>
      </div>
    );
  }

  if (step === 'entry') {
    const symbol = CURRENCY_SYMBOL[unit.currency] || unit.currency;
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        {header}
        <div className="glass-card rounded-2xl p-5 space-y-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('directLana.amountLabel', { symbol })} <span className="text-destructive">*</span></Label>
            <Input
              data-testid="direct-amount"
              type="text"
              inputMode="decimal"
              value={amount}
              placeholder="0,00"
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))}
              className="h-12 rounded-xl bg-background border-input"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('directLana.invoiceNumberLabel')}</Label>
            <Input
              data-testid="direct-invoice"
              value={invoiceNumber}
              maxLength={64}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              className="h-12 rounded-xl bg-background border-input"
            />
            <p className="text-xs text-muted-foreground">{t('directLana.invoiceNumberHint')}</p>
          </div>
        </div>
        {refusalBox}
        <Button
          data-testid="direct-continue"
          onClick={loadPrice}
          disabled={busy || !/^\d{1,13}(?:[.,]\d{1,2})?$/.test(amount.trim()) || Number(amount.replace(',', '.')) <= 0}
          className="w-full h-14 rounded-2xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : t('directLana.continue')}
        </Button>
        <button onClick={openList} className="text-sm text-muted-foreground hover:text-foreground flex items-center justify-center gap-2">
          <ListChecks className="w-4 h-4" /> {t('directLana.showList')}
        </button>
      </div>
    );
  }

  if (step === 'breakdown' || step === 'quoting') {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        {header}
        {price && breakdown(price)}
        {refusalBox}
        {step === 'quoting' ? (
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t('directLana.preparing')}</p>
          </div>
        ) : (
          <>
            <Button
              data-testid="direct-scan"
              onClick={() => { setRefusal(null); setScannerOpen(true); }}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
            >
              <img src={lanaIcon} alt="" className="w-5 h-5 object-contain dark:invert" />
              {t('directLana.scanCard')}
            </Button>
            <Button variant="outline" className="w-full h-12 rounded-2xl" onClick={newSale}>{t('common.back')}</Button>
          </>
        )}
        <QRScanner
          isOpen={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onScan={onScan}
          title={t('directLana.scanTitle')}
          description={t('directLana.scanDescription')}
        >
          {price && (
            <div className="flex items-center justify-between rounded-xl bg-secondary p-3">
              <span className="text-sm text-muted-foreground">{money(price.pay_cents, price.currency)}</span>
              <span className="text-lg font-bold text-primary">{lana(price.lanoshi)}</span>
            </div>
          )}
        </QRScanner>
      </div>
    );
  }

  if (step === 'confirm' && plan) {
    const left = Math.max(0, plan.expires - Math.floor(Date.now() / 1000));
    void tick;
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <h2 className="font-display text-xl font-bold text-foreground text-center">{t('directLana.confirmTitle')}</h2>
        {breakdown({ currency: plan.currency, invoice_cents: plan.invoice_cents, margin_percent: plan.margin_percent, pay_cents: plan.pay_cents, lanoshi: plan.amount, rate: plan.rate })}
        {price && price.lanoshi !== plan.amount && (
          <div data-testid="direct-price-changed" className="rounded-2xl bg-amber-50 dark:bg-amber-500/5 border-2 border-amber-300 dark:border-amber-500/30 p-4">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">{t('directLana.priceChanged', { lana: formatDecimal(lanaText(BigInt(plan.amount)), locale) })}</p>
          </div>
        )}
        <div className="rounded-2xl bg-primary/5 border-2 border-primary/30 p-5">
          <p data-testid="direct-confirm-text" className="text-lg font-semibold text-foreground leading-snug">
            {t('directLana.confirmText', {
              lana: formatDecimal(lanaText(BigInt(plan.amount)), locale),
              fee: formatDecimal(lanaText(BigInt(plan.fee)), locale),
              name: plan.unit_name,
              wallet: shortAddress(plan.recipient),
            })}
          </p>
          <p className="text-xs text-muted-foreground mt-2">{t('directLana.expiresIn', { seconds: left })}</p>
        </div>
        <Button
          data-testid="direct-confirm"
          onClick={confirm}
          disabled={busy}
          className="w-full h-14 rounded-2xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : t('directLana.confirmButton')}
        </Button>
        <Button data-testid="direct-cancel" variant="outline" className="w-full h-12 rounded-2xl" onClick={cancel} disabled={busy}>
          {t('common.cancel')}
        </Button>
      </div>
    );
  }

  if (step === 'sending') {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-16">
        <Loader2 className="w-14 h-14 animate-spin text-primary" />
        <p className="text-lg font-semibold text-foreground">{t('directLana.sending')}</p>
      </div>
    );
  }

  // ── status ──
  const a = attempt;
  if (!a) return null;
  const txLink = a.txid && a.status !== 'refused' && a.status !== 'expired' ? (
    <a href={`https://chainz.cryptoid.info/lana/tx.dws?${a.txid}`} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-primary underline break-all">{a.txid}</a>
  ) : null;
  const amounts = (
    <p className="text-base text-foreground text-center">
      {money(a.pay_cents, a.currency)} · {lana(a.amount_lanoshi)}
    </p>
  );
  return (
    <div className="flex flex-col gap-5 px-6 py-4" data-testid={`direct-status-${a.status}`}>
      {(a.status === 'validating' || a.status === 'broadcasting') && (
        <div className="flex flex-col items-center gap-3 py-8">
          <Loader2 className="w-14 h-14 animate-spin text-primary" />
          <p className="text-lg font-semibold text-foreground">{t('directLana.sending')}</p>
        </div>
      )}
      {(a.status === 'sent' || a.status === 'paid') && (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <CheckCircle2 className="w-14 h-14 text-primary" />
          <h2 className="text-2xl font-bold text-foreground">{t(a.status === 'paid' ? 'directLana.paidTitle' : 'directLana.sentTitle')}</h2>
          {amounts}
          <p className="text-xs text-muted-foreground">{t(a.record_published ? 'directLana.recordPublished' : 'directLana.recordLater')}</p>
          {txLink}
        </div>
      )}
      {(a.status === 'unknown' || a.status === 'quoted') && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-blue-50 border-2 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800 p-6">
            <div className="flex flex-col items-center text-center gap-3">
              <Clock className="w-12 h-12 text-blue-500" />
              <p className="text-lg font-bold text-blue-700 dark:text-blue-400">{t('directLana.unknownTitle')}</p>
              <p className="text-base font-medium text-blue-700 dark:text-blue-300 leading-snug">{t('directLana.unknownText')}</p>
              <p className="text-sm font-medium text-blue-700 dark:text-blue-300 leading-snug">{t('directLana.unknownNoSecond')}</p>
            </div>
          </div>
          {amounts}
          {/* Only the server holds the signed bytes; a submit that never arrived has none to send again. */}
          {a.status === 'unknown' && (
            <>
              <Button data-testid="direct-resend" variant="outline" className="w-full h-12 rounded-2xl gap-2" onClick={resend} disabled={busy}>
                <Send className="w-4 h-4" /> {t('directLana.resend')}
              </Button>
              <p className="text-xs text-muted-foreground text-center">{t('directLana.resendHint')}</p>
            </>
          )}
          <Button data-testid="direct-pay-again" variant="outline" className="w-full h-12 rounded-2xl gap-2" onClick={payAgain} disabled={busy}>
            <RefreshCw className="w-4 h-4" /> {t('directLana.payAgain')}
          </Button>
          <p className="text-xs text-muted-foreground text-center">{t('directLana.payAgainHint')}</p>
        </div>
      )}
      {a.status === 'refused' && a.sent && (
        /* Every server refused it AFTER it was handed over: it may still be
           mined, so it is never said as "LANA were not sent". */
        <div className="space-y-4">
          <div data-testid="direct-refused-sent" className="rounded-2xl bg-amber-50 dark:bg-amber-500/5 border-2 border-amber-300 dark:border-amber-500/30 p-6 text-center">
            <AlertCircle className="w-12 h-12 text-amber-600 mx-auto" />
            <p className="text-base font-semibold text-amber-800 dark:text-amber-300 leading-snug mt-3">{t('directLana.refusedSentText')}</p>
          </div>
          {amounts}
          <Button data-testid="direct-resend" variant="outline" className="w-full h-12 rounded-2xl gap-2" onClick={resend} disabled={busy}>
            <Send className="w-4 h-4" /> {t('directLana.resend')}
          </Button>
          <p className="text-xs text-muted-foreground text-center">{t('directLana.resendHint')}</p>
          <Button data-testid="direct-pay-again" className="w-full h-12 rounded-2xl gap-2" onClick={payAgain} disabled={busy}>
            <RefreshCw className="w-4 h-4" /> {t('directLana.payAgain')}
          </Button>
          <p className="text-xs text-muted-foreground text-center">{t('directLana.payAgainHint')}</p>
        </div>
      )}
      {((a.status === 'refused' && !a.sent) || a.status === 'expired') && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-destructive/10 border-2 border-destructive/50 p-6 text-center">
            <AlertCircle className="w-12 h-12 text-destructive mx-auto" />
            <p className="text-base font-semibold text-destructive leading-snug mt-3">
              {reasonText(a.status === 'expired'
                ? (lostSubmit.current === a.attempt_id ? 'NOT_RECEIVED' : 'QUOTE_EXPIRED')
                : (a.reason || 'BROADCAST_REFUSED'))}
            </p>
          </div>
          <Button data-testid="direct-try-again" className="w-full h-12 rounded-2xl" onClick={payAgain}>{t('common.tryAgain')}</Button>
        </div>
      )}
      {a.status === 'failed' && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-destructive/10 border-2 border-destructive/50 p-6 text-center">
            <AlertCircle className="w-12 h-12 text-destructive mx-auto" />
            <p className="text-lg font-bold text-destructive mt-3">{t('directLana.failedTitle')}</p>
            <p className="text-sm text-destructive mt-1">{t('directLana.failedText')}</p>
          </div>
          <Button data-testid="direct-try-again" className="w-full h-12 rounded-2xl" onClick={payAgain}>{t('common.tryAgain')}</Button>
        </div>
      )}
      {a.status === 'superseded' && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-muted p-6 text-center">
            <RefreshCw className="w-10 h-10 text-muted-foreground mx-auto" />
            <p className="text-sm text-foreground mt-2">{t('directLana.supersededText')}</p>
          </div>
          {/* The payment that replaced it is where this sale goes on. */}
          {replacedBy(a) && (
            <Button data-testid="direct-show-replacement" variant="outline" className="w-full h-12 rounded-2xl" onClick={() => showSale(replacedBy(a)!)}>
              {t('directLana.showPending')}
            </Button>
          )}
        </div>
      )}
      {refusalBox}
      {confirmingNew ? (
        /* The payment shown may still be mined: a new one is for another purchase only. */
        <div data-testid="direct-new-sale-warning" className="rounded-2xl bg-amber-50 dark:bg-amber-500/5 border-2 border-amber-300 dark:border-amber-500/30 p-4 space-y-3">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300 leading-snug">
            {t('directLana.newSaleWarning', { amount: `${money(a.pay_cents, a.currency)} · ${lana(a.amount_lanoshi)}` })}
          </p>
          <Button data-testid="direct-new-sale-confirm" variant="outline" className="w-full h-11 rounded-xl" onClick={newSale}>{t('directLana.newSaleConfirm')}</Button>
          <Button data-testid="direct-new-sale-cancel" className="w-full h-11 rounded-xl" onClick={() => setConfirmingNew(false)}>{t('common.back')}</Button>
        </div>
      ) : (
        <Button data-testid="direct-new-sale" variant="outline" className="w-full h-12 rounded-2xl" onClick={askNewSale}>{t('common.newPayment')}</Button>
      )}
      <button onClick={openList} className="text-sm text-muted-foreground hover:text-foreground flex items-center justify-center gap-2">
        <ListChecks className="w-4 h-4" /> {t('directLana.showList')}
      </button>
    </div>
  );
};

export default DirectLanaTab;
