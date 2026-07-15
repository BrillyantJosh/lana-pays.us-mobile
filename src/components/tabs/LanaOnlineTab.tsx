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
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Loader2, Camera, CheckCircle, CheckCircle2, ImagePlus, Globe,
  Copy, Check, Share2, History, ChevronRight,
} from 'lucide-react';
import QRCode from 'react-qr-code';
import { compressImage } from '@/lib/compress-image';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/AuthContext';
import { currencySymbol as symbolFor } from '@/lib/format';
import { PaymentRequestList, payUrlFor, type PaymentRequestRow } from '@/components/PaymentRequestList';
import lanaIcon from '@/assets/lana-icon.png';

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
}

type Step = 'receipt' | 'entry' | 'created';

const LanaOnlineTab = ({ unitCurrency, unitId, merchantHex }: LanaOnlineTabProps) => {
  const { t, i18n } = useTranslation();
  const { session } = useAuth();
  const currency = unitCurrency || session?.currency || 'GBP';
  const sym = symbolFor(currency);
  const hex = merchantHex || session?.nostrHexId || '';

  const unitIdRef = useRef(unitId);
  unitIdRef.current = unitId;

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
  const [dedupHit, setDedupHit] = useState<{ by: 'receipt_image' | 'invoice'; date: string } | null>(null);

  // Entry step state
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Created step state
  const [createdRequest, setCreatedRequest] = useState<PaymentRequestRow | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  // Requests list (last 10, 15s poll while the tab is open)
  const [requests, setRequests] = useState<PaymentRequestRow[]>([]);
  const [listLoading, setListLoading] = useState(true);

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

  useEffect(() => {
    fetchRequests();
    const interval = setInterval(fetchRequests, 15_000);
    return () => clearInterval(interval);
  }, [fetchRequests, unitId]);

  // ── Receipt upload/analyze/dedup — same pipeline as LanaTab ──────────────
  const handleReceiptFile = async (rawFile: File) => {
    if (rawFile.size > 30 * 1024 * 1024) {
      setUploadError(t('cash.fileTooLarge', { size: (rawFile.size / 1024 / 1024).toFixed(1) }));
      return;
    }
    setUploadError(null);
    setDedupHit(null);
    setReceiptHash(null);

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
      const res = await fetch('/api/receipt/upload', { method: 'POST', body: formData });
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
      const analyzeRes = await fetch('/api/receipt/analyze', { method: 'POST', body: analyzeForm });
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
    const unit = unitIdRef.current;
    if (unit && (localHash || localInvoiceNumber)) {
      try {
        const dedupRes = await fetch('/api/brain/purchase/check-dedup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            unit_id: unit,
            receipt_hash: localHash || undefined,
            invoice_number: localInvoiceNumber || undefined,
          }),
        });
        const dedupData = await dedupRes.json();
        if (dedupData?.duplicate && (dedupData.by === 'receipt_image' || dedupData.by === 'invoice')) {
          const date = dedupData.original_created_at
            ? new Date(dedupData.original_created_at + 'Z').toLocaleString()
            : '';
          setDedupHit({ by: dedupData.by, date });
        }
      } catch { /* soft-fail */ }
    }
  };

  // ── Create the payment request ────────────────────────────────────────────
  const handleCreate = async () => {
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
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        if (res.status === 409 && json?.error === 'DUPLICATE_INVOICE') {
          setCreateError(t('cash.duplicateInvoice', { date: '' }));
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
    setCreateError(null);
    setCreatedRequest(null);
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
  const RecentBlock = () => (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <History className="w-4 h-4 text-muted-foreground" />
          {t('lanaOnline.recentRequests')}
        </h3>
        <Link to="/lana-online/history"
          className="text-xs text-primary font-medium flex items-center gap-0.5 hover:underline">
          {t('lanaOnline.fullHistory')}
          <ChevronRight className="w-3.5 h-3.5" />
        </Link>
      </div>
      {listLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
      ) : (
        <PaymentRequestList rows={requests} merchantHex={hex} onCancelled={fetchRequests} />
      )}
    </div>
  );

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
