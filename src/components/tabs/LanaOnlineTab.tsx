/**
 * LanaOnlineTab — merchant side of Lana-online remote payments.
 *
 * Same receipt → entry preamble as LanaTab (photo → upload+hash → Claude
 * auto-fill → dedup pre-flight), but instead of scanning the customer's WIF
 * on the spot, it creates a PAYMENT REQUEST (stored in FIAT on the server)
 * and hands the merchant a public link /pay/<token> to send to the remote
 * customer (copy / native share / QR).
 *
 * Below the flow: the unit's last 10 requests with live status
 * (pending/paid/cancelled/expired, 15s poll while the tab is open) and a
 * link to the full history page (/lana-online/history).
 *
 * A SHOP WITHOUT A COMPANY AND WITHOUT A BANK ACCOUNT (KIND 30901
 * payout_account "none", Brilly 26 Nov 2026): the brain pays a shop's invoice
 * to a bank account, which this shop does not have, so the brain's request is
 * never made for it. Its online payment request is a LANA neposredno payment
 * link instead, made by the same signed call as the till's "Send a payment
 * link" (POST /api/direct-lana/links): the customer pays it from home, from
 * their own card, straight into the shop's Main Wallet, with the shop's margin
 * (lib/onlineRequestRail.ts). No receipt photo is taken (a direct link carries
 * none), and the list shows the shop's payment links. When LANA neposredno is
 * not on for the shop, the tab says so, and that the administrator switches it
 * on; it never says "no bank account".
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { withCallerHex, withCallerField } from '@/lib/callerIdentity';
import { Link } from 'react-router-dom';
import {
  Loader2, Camera, CheckCircle, CheckCircle2, ImagePlus, Globe,
  Copy, Check, Share2, History, ChevronRight, Info, Receipt,
} from 'lucide-react';
import QRCode from 'react-qr-code';
import { compressImage } from '@/lib/compress-image';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/AuthContext';
import { currencySymbol as symbolFor } from '@/lib/format';
import { payoutRefusalKey, isUnitNoPayoutAccount } from '@/lib/payoutAccount';
import { PaymentRequestList, payUrlFor, type PaymentRequestRow } from '@/components/PaymentRequestList';
import { DirectLinkRequestList, linkMoney } from '@/components/DirectLinkRequestList';
import { freshReceiptFields, checkDedup, canContinueAfterHit, type DedupHit } from '@/lib/receiptDedup';
import { DuplicateNumberFix } from '@/components/DuplicateNumberFix';
import { RequestNoteField } from '@/components/RequestNoteField';
import { ReceiptStep, amountFromReceipt, type ReceiptChoice } from '@/components/ReceiptStep';
import { noteToSend } from '@/lib/requestNote';
import { createDirectLink, fetchDirectLinks, markDirectLinksSeen, directLinkUrl, directReasonKey, answerCode } from '@/lib/directLanaApi';
import { onlineRequestRail, closedReasonKey, isDirectAmount, type DirectLanaView } from '@/lib/onlineRequestRail';
import type { DirectLink } from '@/components/tabs/DirectLanaTab';
import lanaIcon from '@/assets/lana-icon.png';

/** A payment link as the seller's routes answer (server lib/directLanaLinks.ts sellerLinkView). */
type SellerLink = DirectLink & { seen?: boolean; unit_name?: string };


/** Same own-dedup-screenshot heuristic as LanaTab/CashTab. */
const OWN_DEDUP_PHRASES = [
  'each invoice can only be funded', 'invoice number already used',
  'invoice already used for this shop', 'this description was already used',
  'every purchase is a new moment', 'the same photo cannot be used twice',
  'this receipt photo has already been uploaded',
  'vsak račun je mogoče financirati', 'številka računa je za to trgovino že uporabljena',
  'ta opis je bil že uporabljen', 'vsak nakup je nov trenutek',
  'ta slika računa je bila že naložena', 'iste slike ni mogoče uporabiti', 'bodi prisoten',
];
function looksLikePriorDedupError(text: string | null | undefined): boolean {
  if (!text) return false;
  const lowered = text.toLowerCase();
  return OWN_DEDUP_PHRASES.some(p => lowered.includes(p));
}

interface LanaOnlineTabProps {
  unitCurrency?: string;
  unitId?: string;
  merchantHex?: string;
  /** A shop without a company and without a bank account: its request is a LANA neposredno link. */
  noCompany?: boolean;
  /** Such a shop's LANA neposredno, as GET /api/business-units has it (absent: the server decides). */
  directLana?: DirectLanaView | null;
  /** The shop's name, for the text a shared link goes with. */
  unitName?: string;
  /** The shop's paid links were shown here: the home screen's notice of them goes. */
  onLinksSeen?: (unitId: string) => void;
}

type Step = 'receipt' | 'entry' | 'created';

const LanaOnlineTab = ({ unitCurrency, unitId, merchantHex, noCompany, directLana, unitName, onLinksSeen }: LanaOnlineTabProps) => {
  const { t, i18n } = useTranslation();
  const { session } = useAuth();
  const currency = unitCurrency || session?.currency || 'GBP';
  const sym = symbolFor(currency);
  const hex = merchantHex || session?.nostrHexId || '';
  const locale = i18n.language || 'en';

  const unitIdRef = useRef(unitId);
  unitIdRef.current = unitId;

  // ── Which rail (lib/onlineRequestRail.ts) ────────────────────────────────
  // The server already had this shop as one without a bank account when the
  // till did not yet (a switch on shop.lanapays.us reaches the till with its
  // next poll): from that answer on, this tab makes LANA neposredno links.
  const [directByServer, setDirectByServer] = useState(false);
  const rail = onlineRequestRail(noCompany === true || directByServer, noCompany === true ? directLana : undefined);
  const direct = rail.rail !== 'brain';
  const closedReason = rail.rail === 'closed' ? rail.reason : null;
  useEffect(() => { setDirectByServer(false); }, [unitId, noCompany]);

  const [step, setStep] = useState<Step>('receipt');

  // Receipt step state (mirrors LanaTab)
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [receiptHash, setReceiptHash] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [receiptType, setReceiptType] = useState<'receipt' | 'photo'>('receipt');
  const [analysisDescription, setAnalysisDescription] = useState<string | null>(null);
  // A hit on the photo needs a new photo; a hit on the number can be
  // corrected in place (lib/receiptDedup).
  const [dedupHit, setDedupHit] = useState<DedupHit | null>(null);
  const [recheckingNumber, setRecheckingNumber] = useState(false);

  // Entry step state
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [amount, setAmount] = useState('');
  /** Optional: what the payment is for / who it is for (shown back, never sent to the brain). */
  const [note, setNote] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Created step state
  const [createdRequest, setCreatedRequest] = useState<PaymentRequestRow | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  // A shop without a company: the LANA neposredno link just made.
  const [createdLink, setCreatedLink] = useState<SellerLink | null>(null);

  // Requests list (last 10, 15s poll while the tab is open)
  const [requests, setRequests] = useState<PaymentRequestRow[]>([]);
  const [listLoading, setListLoading] = useState(true);
  // A shop without a company: its payment links instead (signed, newest first).
  const [links, setLinks] = useState<SellerLink[]>([]);
  const linksSeenSent = useRef<string | null>(null);

  const fetchRequests = useCallback(async () => {
    const unit = unitIdRef.current;
    if (!unit || !hex) { setRequests([]); setListLoading(false); return; }
    try {
      const res = await fetch(`/api/payment-requests?unit_id=${encodeURIComponent(unit)}&hex=${encodeURIComponent(hex)}&limit=10`);
      const json = await res.json();
      if (json.success) setRequests(json.requests || []);
    } catch { /* keep previous list */ }
    setListLoading(false);
  }, [hex]);

  // Read through refs: the list's poll must not restart (and read again) on
  // every render that hands over a new session object or callback.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const onLinksSeenRef = useRef(onLinksSeen);
  onLinksSeenRef.current = onLinksSeen;

  const fetchLinks = useCallback(async () => {
    const unit = unitIdRef.current;
    if (!unit) { setLinks([]); setListLoading(false); return; }
    try {
      const { status, data } = await fetchDirectLinks(sessionRef.current, unit);
      if (status === 200 && Array.isArray(data?.links)) {
        const fresh = data.links as SellerLink[];
        setLinks(fresh);
        // The link on the screen follows its payment.
        setCreatedLink(prev => (prev ? fresh.find(l => l.id === prev.id) ?? prev : prev));
        // Paid links shown here are seen, once per shop while the tab is open
        // (as when the "LANA direct" tab lists them).
        if (linksSeenSent.current !== unit && fresh.some(l => l.status === 'paid' && l.seen === false)) {
          linksSeenSent.current = unit;
          void markDirectLinksSeen(sessionRef.current, unit).then(() => onLinksSeenRef.current?.(unit)).catch(() => {});
        }
      }
    } catch { /* keep previous list */ }
    setListLoading(false);
  }, []);

  useEffect(() => {
    const read = direct ? fetchLinks : fetchRequests;
    read();
    const interval = setInterval(read, 15_000);
    return () => clearInterval(interval);
  }, [fetchRequests, fetchLinks, direct, unitId]);

  // ── Receipt upload/analyze/dedup — same pipeline as LanaTab ──────────────
  const handleReceiptFile = async (rawFile: File) => {
    if (rawFile.size > 30 * 1024 * 1024) {
      setUploadError(t('cash.fileTooLarge', { size: (rawFile.size / 1024 / 1024).toFixed(1) }));
      return;
    }
    setUploadError(null);
    setDedupHit(null);
    setReceiptHash(null);
    setReceiptUrl(null);
    // A new photo starts from empty fields — nothing carried over from the
    // previous photo (16 Oct 2026, Alaja; see lib/receiptDedup).
    const fresh = freshReceiptFields();
    setInvoiceNumber(fresh.invoiceNumber);
    setAmount(fresh.amount);
    setNote('');
    setReceiptType('receipt');
    setAnalysisDescription(null);
    setCreateError(null);

    const reader = new FileReader();
    reader.onload = (e) => setReceiptPreview(e.target?.result as string);
    reader.readAsDataURL(rawFile);

    setIsUploading(true);
    const { file } = await compressImage(rawFile);

    let localHash: string | null = null;
    let localInvoiceNumber: string | null = null;

    try {
      const formData = new FormData();
      formData.append('receipt', file, file.name);
      const res = await fetch('/api/receipt/upload', { method: 'POST', body: withCallerField(formData) });
      const data = await res.json();
      if (data.success && data.url) {
        setReceiptUrl(data.url);
        if (typeof data.hash === 'string') { setReceiptHash(data.hash); localHash = data.hash; }
      } else setUploadError(t('cash.uploadFailed'));
    } catch {
      setUploadError(t('cash.networkErrorRetry'));
    } finally {
      setIsUploading(false);
    }

    setIsAnalyzing(true);
    try {
      const analyzeForm = new FormData();
      analyzeForm.append('receipt', file, file.name);
      analyzeForm.append('currency', currency);
      analyzeForm.append('lang', i18n.language || 'en');
      const analyzeRes = await fetch('/api/receipt/analyze', { method: 'POST', body: withCallerField(analyzeForm) });
      const analysis = await analyzeRes.json();
      if (analysis.isReceipt) {
        setReceiptType('receipt');
        if (analysis.amount) setAmount(String(analysis.amount));
        if (analysis.invoiceNumber) {
          setInvoiceNumber(analysis.invoiceNumber);
          localInvoiceNumber = String(analysis.invoiceNumber);
        }
        if (analysis.items) setAnalysisDescription(analysis.items);
        if (looksLikePriorDedupError(analysis.items)) setDedupHit({ by: 'receipt_image', date: '' });
      } else if (analysis.analysisError) {
        setReceiptType('photo');
        setAnalysisDescription(analysis.analysisError === 'overloaded' ? t('cash.aiOverloaded') : t('cash.aiFailed'));
      } else {
        setReceiptType('photo');
        setAnalysisDescription(analysis.description || t('cash.photoCaptured'));
        if (looksLikePriorDedupError(analysis.description)) setDedupHit({ by: 'receipt_image', date: '' });
      }
    } catch {}
    finally { setIsAnalyzing(false); }

    // Pre-flight dedup against brain (soft-fail — brain re-enforces at pay time).
    const hit = await checkDedup(unitIdRef.current || '', { receiptHash: localHash, invoiceNumber: localInvoiceNumber }, withCallerHex({ 'Content-Type': 'application/json' }));
    if (hit) setDedupHit(hit);
  };

  /** After a hit on the number: the seller typed the number printed on the
   *  receipt. Ask again for THAT number, then go on. */
  const continueAfterNumberFix = async () => {
    if (!dedupHit || !canContinueAfterHit(dedupHit, invoiceNumber)) return;
    setRecheckingNumber(true);
    const again = await checkDedup(unitIdRef.current || '', { invoiceNumber }, withCallerHex({ 'Content-Type': 'application/json' }));
    setRecheckingNumber(false);
    if (again) { setDedupHit(again); return; }
    setDedupHit(null);
    setStep('entry');
  };

  // ── A shop without a company: the LANA neposredno payment link ───────────
  /** "The link could not be created: …", or a whole sentence this app already has. */
  const linkRefusedText = (code: string) => {
    const { key, sentence } = directReasonKey(code);
    return sentence ? t(key) : t('directLana.linkRefused', { reason: t(key) });
  };

  /**
   * The till's own link call (POST /api/direct-lana/links, signed): the invoice
   * amount, the invoice number if there is one, the note. The server fixes the
   * shop's margin of now and refuses what the till's "LANA direct" would refuse.
   */
  const createDirect = async () => {
    const text = amount.trim();
    if (!isDirectAmount(text)) {
      setCreateError(linkRefusedText('AMOUNT_INVALID'));
      return;
    }
    const invoice = invoiceNumber.trim();
    const noteText = noteToSend(note);
    try {
      const { status, data } = await createDirectLink(session, {
        unit_id: unitIdRef.current || '',
        amount: text.replace(',', '.'),
        currency,
        ...(invoice ? { invoice_number: invoice } : {}),
        ...(noteText ? { note: noteText } : {}),
        // The receipt photographed first, as for every request (26 Nov 2026): the customer's page shows it.
        ...(receiptUrl ? { receipt_url: receiptUrl, ...(receiptHash ? { receipt_hash: receiptHash } : {}) } : {}),
      });
      if (status === 201 && data?.success && data.link) {
        setCreatedLink(data.link);
        setLinkCopied(false);
        setStep('created');
        fetchLinks();
        return;
      }
      setCreateError(linkRefusedText(answerCode(data) || 'GENERIC'));
    } catch {
      setCreateError(linkRefusedText('NETWORK'));
    }
  };

  // A second tap before the button greys out must not make a second link: a
  // link without an invoice number has nothing the server could refuse it by.
  const creatingDirect = useRef(false);

  // ── Create the payment request ────────────────────────────────────────────
  const handleCreate = async () => {
    if (direct) {
      if (creatingDirect.current) return;
      creatingDirect.current = true;
      setIsCreating(true);
      setCreateError(null);
      try {
        await createDirect();
      } finally {
        creatingDirect.current = false;
        setIsCreating(false);
      }
      return;
    }
    const fiat = parseFloat(amount.replace(',', '.'));
    if (!invoiceNumber.trim() || isNaN(fiat) || fiat <= 0) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/payment-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unit_id: unitIdRef.current || '',
          merchant_hex: hex,
          amount: fiat,
          currency,
          invoice_number: invoiceNumber.trim(),
          receipt_url: receiptUrl || undefined,
          receipt_hash: receiptHash || undefined,
          receipt_type: receiptType || 'receipt',
          receipt_description: analysisDescription || undefined,
          note: noteToSend(note),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        if (res.status === 409 && json?.error === 'DUPLICATE_INVOICE') {
          setCreateError(t('cash.duplicateInvoice', { date: '' }));
        } else if (isUnitNoPayoutAccount(json)) {
          // The server has this shop as one without a bank account already; the
          // till has not heard yet. Nothing was stored for this request: the
          // shop's online payment is a LANA neposredno link, made now instead.
          setDirectByServer(true);
          await createDirect();
        } else if (payoutRefusalKey(json)) {
          // Another refusal about the shop's payout settings, in the seller's words.
          setCreateError(t(payoutRefusalKey(json)!));
        } else {
          setCreateError(json?.error || t('lana.purchaseFailed'));
        }
        setIsCreating(false);
        return;
      }
      setCreatedRequest(json.request);
      setStep('created');
      fetchRequests();
    } catch {
      setCreateError(t('lana.networkError'));
    }
    setIsCreating(false);
  };

  /** A shop without a company: the receipt step is done (its photo, or none), on to the link's form. */
  const takeDirectReceipt = (c: ReceiptChoice) => {
    setReceiptUrl(c.url);
    setReceiptHash(c.hash);
    setAmount(amountFromReceipt(c.amount));
    // No invoice number for a shop without a company (26 Nov 2026): what was sold goes in the note the customer sees.
    setInvoiceNumber('');
    setNote((c.description || '').replace(/\s+/g, ' ').trim().slice(0, 200));
    setCreateError(null);
    setStep('entry');
  };

  const resetForNew = () => {
    setStep('receipt');
    setReceiptPreview(null);
    setReceiptUrl(null);
    setReceiptHash(null);
    setUploadError(null);
    setReceiptType('receipt');
    setAnalysisDescription(null);
    setDedupHit(null);
    setInvoiceNumber('');
    setAmount('');
    setNote('');
    setCreateError(null);
    setCreatedRequest(null);
    setCreatedLink(null);
    setLinkCopied(false);
  };

  const copyCreatedLink = async () => {
    if (!createdRequest) return;
    try {
      await navigator.clipboard.writeText(payUrlFor(createdRequest));
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const copyDirectLink = async () => {
    if (!createdLink) return;
    try {
      await navigator.clipboard.writeText(directLinkUrl(createdLink));
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const shareDirectLink = async () => {
    if (!createdLink) return;
    try {
      await navigator.share({
        title: t('directLana.linkShareTitle'),
        text: t('directLana.linkShareText', {
          amount: linkMoney(createdLink.pay_cents, createdLink.currency, locale),
          unit: createdLink.unit_name || unitName || '',
        }),
        url: directLinkUrl(createdLink),
      });
    } catch { /* user cancelled / unsupported */ }
  };

  const shareCreatedLink = async () => {
    if (!createdRequest) return;
    const url = payUrlFor(createdRequest);
    try {
      await navigator.share({
        title: t('pay.title'),
        text: t('lanaOnline.shareText', {
          amount: `${sym}${createdRequest.amount_fiat.toFixed(2)}`,
          unit: createdRequest.unit_name,
        }),
        url,
      });
    } catch { /* user cancelled / unsupported */ }
  };

  // ── The recent-requests block (rendered under receipt/entry steps) ────────
  // A shop without a company: its payment links (the history page lists the
  // brain's requests only, so it is not offered).
  const RecentBlock = () => (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <History className="w-4 h-4 text-muted-foreground" />
          {direct ? t('directLana.linksTitle') : t('lanaOnline.recentRequests')}
        </h3>
        {!direct && (
          <Link to="/lana-online/history"
            className="text-xs text-primary font-medium flex items-center gap-0.5 hover:underline">
            {t('lanaOnline.fullHistory')}
            <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        )}
      </div>
      {listLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
      ) : direct ? (
        <DirectLinkRequestList links={links.slice(0, 10)} onChanged={fetchLinks} />
      ) : (
        <PaymentRequestList rows={requests} merchantHex={hex} onCancelled={fetchRequests} />
      )}
    </div>
  );

  // ─── A shop without a company: the LANA neposredno link ──────────────────
  const directHeader = (
    <div className="flex items-center gap-4">
      <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
        <Globe className="w-7 h-7 text-primary" />
      </div>
      <div>
        <h2 className="font-display text-xl font-bold text-foreground">{t('lanaOnline.title')}</h2>
        <p className="text-muted-foreground text-sm">{t('directLana.sendLinkHint')}</p>
      </div>
    </div>
  );

  /** The margin of a link, as the server's two exact amounts give it; a dash when they do not read. */
  const marginMoney = (l: SellerLink) => {
    try {
      return linkMoney((BigInt(l.pay_cents) - BigInt(l.invoice_cents)).toString(), l.currency, locale);
    } catch {
      return '–';
    }
  };

  if (direct && step === 'created' && createdLink) {
    const l = createdLink;
    const url = directLinkUrl(l);
    const live = l.status === 'open' || l.status === 'paying';
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex flex-col items-center gap-3 py-4">
          <CheckCircle2 className="w-12 h-12 text-primary" />
          <h2 className="font-display text-xl font-bold text-foreground">{t('directLana.linkCreated')}</h2>
          <p data-testid="online-direct-total" className="text-2xl font-bold text-foreground">{linkMoney(l.pay_cents, l.currency, locale)}</p>
          {l.margin_percent > 0 && (
            <p data-testid="online-direct-margin" className="text-xs text-muted-foreground text-center">
              {t('directLana.invoiceAmount')} {linkMoney(l.invoice_cents, l.currency, locale)}
              {' · '}{t('directLana.marginLine', { percent: l.margin_percent })} +{marginMoney(l)}
            </p>
          )}
          {l.invoice_number && <p className="text-sm text-muted-foreground">{t('cash.invoiceLabel', { number: l.invoice_number })}</p>}
          {l.note && (
            <p className="text-sm text-foreground/85 text-center break-words max-w-full" data-testid="created-note">
              <span className="text-muted-foreground">{t('lanaOnline.noteLabel')}: </span>{l.note}
            </p>
          )}
          <p data-testid="online-direct-status" className="text-sm font-semibold text-primary">{t(`directLana.linkStatus.${l.status}`)}</p>
        </div>

        {live && (
          <div className="glass-card rounded-2xl border p-5 space-y-4">
            <p className="text-xs text-muted-foreground">{t('lanaOnline.linkLabel')}</p>
            <p data-testid="online-direct-url" className="text-sm font-mono text-foreground break-all bg-secondary rounded-xl p-3">{url}</p>
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={copyDirectLink} variant="outline" className="h-12 rounded-xl gap-2">
                {linkCopied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                {linkCopied ? t('lanaOnline.linkCopied') : t('lanaOnline.copyLink')}
              </Button>
              {typeof navigator.share === 'function' ? (
                <Button onClick={shareDirectLink} className="h-12 rounded-xl gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
                  <Share2 className="w-4 h-4" />
                  {t('lanaOnline.shareLink')}
                </Button>
              ) : (
                <Button onClick={copyDirectLink} className="h-12 rounded-xl gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
                  <Copy className="w-4 h-4" />
                  {t('lanaOnline.copyLink')}
                </Button>
              )}
            </div>
            <div className="flex flex-col items-center gap-2 pt-2">
              <div className="bg-white p-3 rounded-xl">
                <QRCode value={url} size={168} />
              </div>
              <p className="text-xs text-muted-foreground text-center">{t('lanaOnline.qrHint')}</p>
            </div>
            {l.expires_at && (
              <p className="text-xs text-muted-foreground text-center">
                {t('lanaOnline.expiresNote', { date: new Date(l.expires_at * 1000).toLocaleString(locale) })}
              </p>
            )}
          </div>
        )}

        <Button onClick={resetForNew} variant="outline" className="w-full h-12 rounded-2xl text-sm font-semibold">
          {t('lanaOnline.newRequest')}
        </Button>

        <RecentBlock />
      </div>
    );
  }

  if (direct && step !== 'created') {
    // The receipt photo first, as for every request (Brilly, 26 Nov 2026), then
    // the link's form; or why no link can be made for this shop now.
    if (!closedReason && step === 'receipt') {
      return <ReceiptStep header={directHeader} currency={currency} unitId={unitIdRef.current || ''} onDone={takeDirectReceipt} footer={<RecentBlock />} />;
    }
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        {directHeader}
        {!closedReason && receiptUrl && (
          <div data-testid="online-direct-receipt" className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-200 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/5 px-4 py-3">
            <a href={receiptUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400 underline">
              <Receipt className="w-4 h-4" /> {t('pay.viewReceipt')}
            </a>
            <button onClick={resetForNew} className="text-xs text-muted-foreground hover:text-foreground">{t('cash.retakePhoto')}</button>
          </div>
        )}

        {closedReason ? (
          <div data-testid="online-direct-closed" className="rounded-2xl bg-amber-500/10 border border-amber-500/30 p-5 flex items-start gap-3">
            <Info className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <p className="text-base font-medium text-foreground leading-relaxed">{t(closedReasonKey(closedReason))}</p>
          </div>
        ) : (
          <>
            <div className="glass-card rounded-2xl p-5 space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium text-foreground">
                  {t('directLana.amountLabel', { symbol: sym })} <span className="text-destructive">*</span>
                </Label>
                <Input
                  data-testid="online-direct-amount"
                  type="text"
                  inputMode="decimal"
                  placeholder={t('cash.amountPlaceholder')}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))}
                  className="h-12 rounded-xl bg-background border-input"
                />
              </div>
              <RequestNoteField value={note} onChange={setNote} />
              <p className="text-xs text-muted-foreground">{t('directLana.linkPriceNote')}</p>
            </div>

            {createError && (
              <div data-testid="online-direct-error" className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4">
                <p className="text-sm text-destructive text-center">{createError}</p>
              </div>
            )}

            <Button
              data-testid="online-direct-create"
              onClick={handleCreate}
              disabled={!isDirectAmount(amount) || isCreating}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 disabled:opacity-50"
            >
              {isCreating ? (
                <><Loader2 className="w-5 h-5 animate-spin" />{t('lanaOnline.creating')}</>
              ) : (
                t('lanaOnline.createRequest')
              )}
            </Button>
          </>
        )}

        <RecentBlock />
      </div>
    );
  }

  // ─── STEP: Created — the link to send ─────────────────────────────────────
  if (step === 'created' && createdRequest) {
    const url = payUrlFor(createdRequest);
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex flex-col items-center gap-3 py-4">
          <CheckCircle2 className="w-12 h-12 text-primary" />
          <h2 className="font-display text-xl font-bold text-foreground">{t('lanaOnline.requestCreated')}</h2>
          <p className="text-2xl font-bold text-foreground">{sym}{createdRequest.amount_fiat.toFixed(2)}</p>
          <p className="text-sm text-muted-foreground">{t('cash.invoiceLabel', { number: createdRequest.invoice_number })}</p>
          {createdRequest.note && (
            <p className="text-sm text-foreground/85 text-center break-words max-w-full" data-testid="created-note">
              <span className="text-muted-foreground">{t('lanaOnline.noteLabel')}: </span>{createdRequest.note}
            </p>
          )}
        </div>

        <div className="glass-card rounded-2xl border p-5 space-y-4">
          <p className="text-xs text-muted-foreground">{t('lanaOnline.linkLabel')}</p>
          <p className="text-sm font-mono text-foreground break-all bg-secondary rounded-xl p-3">{url}</p>
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={copyCreatedLink} variant="outline" className="h-12 rounded-xl gap-2">
              {linkCopied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
              {linkCopied ? t('lanaOnline.linkCopied') : t('lanaOnline.copyLink')}
            </Button>
            {typeof navigator.share === 'function' ? (
              <Button onClick={shareCreatedLink} className="h-12 rounded-xl gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
                <Share2 className="w-4 h-4" />
                {t('lanaOnline.shareLink')}
              </Button>
            ) : (
              <Button onClick={copyCreatedLink} className="h-12 rounded-xl gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
                <Copy className="w-4 h-4" />
                {t('lanaOnline.copyLink')}
              </Button>
            )}
          </div>
          <div className="flex flex-col items-center gap-2 pt-2">
            <div className="bg-white p-3 rounded-xl">
              <QRCode value={url} size={168} />
            </div>
            <p className="text-xs text-muted-foreground text-center">{t('lanaOnline.qrHint')}</p>
          </div>
          {createdRequest.expires_at && (
            <p className="text-xs text-muted-foreground text-center">
              {t('lanaOnline.expiresNote', { date: new Date(createdRequest.expires_at.replace(' ', 'T') + 'Z').toLocaleString() })}
            </p>
          )}
        </div>

        <Button onClick={resetForNew} variant="outline" className="w-full h-12 rounded-2xl text-sm font-semibold">
          {t('lanaOnline.newRequest')}
        </Button>

        <RecentBlock />
      </div>
    );
  }

  // ─── STEP: Entry ───────────────────────────────────────────────────────────
  if (step === 'entry') {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <Globe className="w-7 h-7 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">{t('lanaOnline.title')}</h2>
            <p className="text-muted-foreground text-sm">{t('lanaOnline.entrySubtitle')}</p>
          </div>
        </div>

        <div className="glass-card rounded-2xl p-5 space-y-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">
              {receiptType === 'receipt' ? t('cash.invoiceNumber') : t('cash.transactionDescription')} <span className="text-destructive">*</span>
            </Label>
            <Input
              placeholder={receiptType === 'receipt' ? t('cash.invoicePlaceholder') : t('cash.descriptionPlaceholder')}
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              className="h-12 rounded-xl bg-background border-input"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">
              {t('cash.amount', { symbol: sym })} <span className="text-destructive">*</span>
            </Label>
            <Input
              type="text"
              inputMode="decimal"
              placeholder={t('cash.amountPlaceholder')}
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))}
              className="h-12 rounded-xl bg-background border-input"
            />
          </div>
          <RequestNoteField value={note} onChange={setNote} />
        </div>

        {createError && (
          <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4">
            <p className="text-sm text-destructive text-center">{createError}</p>
          </div>
        )}

        <Button
          onClick={handleCreate}
          disabled={!invoiceNumber.trim() || !amount.trim() || parseFloat(amount.replace(',', '.')) <= 0 || isCreating}
          className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 disabled:opacity-50"
        >
          {isCreating ? (
            <><Loader2 className="w-5 h-5 animate-spin" />{t('lanaOnline.creating')}</>
          ) : (
            t('lanaOnline.createRequest')
          )}
        </Button>

        <RecentBlock />
      </div>
    );
  }

  // ─── STEP: Receipt (default) ────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-5 px-6 py-4">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
          <Globe className="w-7 h-7 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-xl font-bold text-foreground">{t('lanaOnline.title')}</h2>
          <p className="text-muted-foreground text-sm">{t('lanaOnline.subtitle')}</p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{t('cash.receiptInstruction')}</p>

      {receiptPreview ? (
        <div className="relative rounded-2xl overflow-hidden border bg-muted">
          <img src={receiptPreview} alt="Receipt" className="w-full max-h-64 object-contain" />
          {isUploading && <div className="absolute inset-0 bg-background/50 flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>}
          {receiptUrl && !isUploading && <div className="absolute top-3 right-3"><CheckCircle className="w-6 h-6 text-emerald-500 bg-white rounded-full" /></div>}
        </div>
      ) : null}
      {uploadError && <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-3"><p className="text-sm text-destructive text-center">{uploadError}</p></div>}
      {isAnalyzing && (
        <div className="rounded-2xl bg-primary/5 border border-primary/10 p-3 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <p className="text-xs text-primary">{t('cash.analyzingImage')}</p>
        </div>
      )}
      {!isAnalyzing && analysisDescription && receiptPreview && (
        <div className={`rounded-2xl p-4 border ${receiptType === 'receipt' ? 'bg-emerald-50 dark:bg-emerald-500/5 border-emerald-200 dark:border-emerald-500/10' : 'bg-amber-50 dark:bg-amber-500/5 border-amber-200 dark:border-amber-500/10'}`}>
          <p className={`text-xl font-semibold ${receiptType === 'receipt' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
            {receiptType === 'receipt' ? t('cash.receiptDetected') : t('cash.photoNotReceipt')}
          </p>
          <p className="text-xl text-foreground/85 mt-1.5 leading-relaxed whitespace-pre-wrap break-words">{analysisDescription}</p>
        </div>
      )}
      {dedupHit && (
        <div className="rounded-2xl p-4 border bg-destructive/10 border-destructive/20">
          <p className="text-xl text-destructive text-center leading-relaxed">
            {t(dedupHit.by === 'receipt_image' ? 'cash.duplicateReceiptImage' : 'cash.duplicateInvoice', { date: dedupHit.date })}
          </p>
        </div>
      )}
      {dedupHit?.by === 'invoice' && !isAnalyzing && (
        <DuplicateNumberFix
          hit={dedupHit}
          value={invoiceNumber}
          onChange={setInvoiceNumber}
          onContinue={continueAfterNumberFix}
          checking={recheckingNumber}
          disabled={isUploading}
        />
      )}
      {!receiptPreview ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="cursor-pointer">
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => e.target.files?.[0] && handleReceiptFile(e.target.files[0])} />
            <div className="h-14 rounded-2xl text-sm font-semibold gap-2 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 flex items-center justify-center"><Camera className="w-5 h-5" /> {t('cash.takePhotoLabel')}</div>
          </label>
          <label className="cursor-pointer">
            <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && handleReceiptFile(e.target.files[0])} />
            <div className="h-14 rounded-2xl text-sm font-semibold gap-2 border-2 border-primary text-primary bg-primary/5 hover:bg-primary/10 flex items-center justify-center"><ImagePlus className="w-5 h-5" /> {t('cash.uploadFromGallery')}</div>
          </label>
        </div>
      ) : (
        <>
          {!isAnalyzing && !dedupHit && (
            <Button onClick={() => setStep('entry')} className="w-full h-14 rounded-2xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20" disabled={isUploading}>{t('cash.continueToInvoice')}</Button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <label className="cursor-pointer">
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => e.target.files?.[0] && handleReceiptFile(e.target.files[0])} />
              <div className="h-12 rounded-2xl text-sm font-medium gap-2 border border-input hover:bg-accent flex items-center justify-center"><Camera className="w-4 h-4" /> {t('cash.retakePhoto')}</div>
            </label>
            <label className="cursor-pointer">
              <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && handleReceiptFile(e.target.files[0])} />
              <div className="h-12 rounded-2xl text-sm font-medium gap-2 border border-input hover:bg-accent flex items-center justify-center"><ImagePlus className="w-4 h-4" /> {t('cash.uploadFromGallery')}</div>
            </label>
          </div>
        </>
      )}
      {!dedupHit && (
        <button onClick={() => setStep('entry')} className="text-xs text-muted-foreground text-center hover:text-foreground transition-colors mt-1">{t('cash.skipNoReceipt')}</button>
      )}

      <RecentBlock />
    </div>
  );
};

export default LanaOnlineTab;
