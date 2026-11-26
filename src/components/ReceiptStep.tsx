/**
 * The receipt step of LANA neposredno (Brilly, 26 Nov 2026: "the same
 * procedure as LANA: the receipt first, only the money goes to the shop's
 * wallet"). The same pipeline as the LANA and Lana-online tabs: a photo (camera
 * or gallery), uploaded (/api/receipt/upload answers where it is and the hash of
 * its bytes), read (/api/receipt/analyze: the amount, and what was sold), and
 * asked about (/api/brain/purchase/check-dedup, which asks the brain and this
 * app's own direct sales): a photo already paid hides "Continue". "No receipt"
 * goes on without one. No invoice NUMBER is read or asked for (Brilly, 26 Nov
 * 2026: a shop without a company has no invoices): what was sold is handed on
 * as the sale's optional description instead.
 *
 * Used by the till's "LANA direct" (DirectLanaTab) and by Lana-online of a shop
 * without a company (LanaOnlineTab). The LANA and Lana-online steps of the
 * brain keep their own copy, untouched.
 */
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Camera, CheckCircle, ImagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { compressImage } from '@/lib/compress-image';
import { withCallerHex, withCallerField } from '@/lib/callerIdentity';
import { freshReceiptFields, checkDedup, looksLikeOwnDedupError, type DedupHit } from '@/lib/receiptDedup';

/** What the step hands on: the photo (or none) and what was read from it. */
export interface ReceiptChoice {
  /** Where the photo is, as the upload answered; null: no receipt. */
  url: string | null;
  /** SHA-256 of the photo's bytes, as the upload answered. */
  hash: string | null;
  /** The amount read from the receipt ('' when none). */
  amount: string;
  /** What was sold, as the reader saw it on the photo (null when it saw nothing it could name). */
  description: string | null;
}

export const NO_RECEIPT: ReceiptChoice = { url: null, hash: null, amount: '', description: null };

/** An amount read from a receipt, as the amount fields take it ('' when it does not read as one). */
export const amountFromReceipt = (text: string): string => {
  const n = Number(String(text || '').trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n < 1e13 ? n.toFixed(2) : '';
};

export function ReceiptStep({ header, currency, unitId, onDone, footer }: {
  /** The tab's own title block. */
  header: ReactNode;
  currency: string;
  unitId: string;
  onDone: (choice: ReceiptChoice) => void;
  footer?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [preview, setPreview] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [kind, setKind] = useState<'receipt' | 'photo'>('receipt');
  // What the reader says (also when it could not read: "overloaded"), and what it saw that was sold.
  const [description, setDescription] = useState<string | null>(null);
  const [sold, setSold] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [hit, setHit] = useState<DedupHit | null>(null);
  // The photo being read now: an answer about an older photo is dropped.
  const current = useRef(0);

  const handleFile = async (rawFile: File) => {
    if (rawFile.size > 30 * 1024 * 1024) {
      setUploadError(t('cash.fileTooLarge', { size: (rawFile.size / 1024 / 1024).toFixed(1) }));
      return;
    }
    const mine = ++current.current;
    const stale = () => current.current !== mine;
    // A new photo starts from empty fields: nothing of the previous one (lib/receiptDedup).
    const fresh = freshReceiptFields();
    setUploadError(null);
    setHit(null);
    setHash(null);
    setUrl(null);
    setAmount(fresh.amount);
    setKind('receipt');
    setDescription(null);
    setSold(null);

    const reader = new FileReader();
    reader.onload = (e) => { if (!stale()) setPreview(e.target?.result as string); };
    reader.readAsDataURL(rawFile);

    setUploading(true);
    const { file } = await compressImage(rawFile);
    let localHash: string | null = null;
    try {
      const form = new FormData();
      form.append('receipt', file, file.name);
      const res = await fetch('/api/receipt/upload', { method: 'POST', body: withCallerField(form) });
      const data = await res.json();
      if (stale()) return;
      if (data.success && data.url) {
        setUrl(data.url);
        if (typeof data.hash === 'string') { setHash(data.hash); localHash = data.hash; }
      } else setUploadError(t('cash.uploadFailed'));
    } catch {
      if (!stale()) setUploadError(t('cash.networkErrorRetry'));
    } finally {
      if (!stale()) setUploading(false);
    }

    setAnalyzing(true);
    try {
      const form = new FormData();
      form.append('receipt', file, file.name);
      form.append('currency', currency);
      form.append('lang', i18n.language || 'en');
      const res = await fetch('/api/receipt/analyze', { method: 'POST', body: withCallerField(form) });
      const analysis = await res.json();
      if (stale()) return;
      if (analysis.isReceipt) {
        setKind('receipt');
        if (analysis.amount) setAmount(String(analysis.amount));
        if (analysis.items) { setDescription(analysis.items); setSold(String(analysis.items)); }
        if (looksLikeOwnDedupError(analysis.items)) setHit({ by: 'receipt_image', date: '' });
      } else if (analysis.analysisError) {
        setKind('photo');
        setDescription(analysis.analysisError === 'overloaded' ? t('cash.aiOverloaded') : t('cash.aiFailed'));
      } else {
        setKind('photo');
        setDescription(analysis.description || t('cash.photoCaptured'));
        if (analysis.description) setSold(String(analysis.description));
        if (looksLikeOwnDedupError(analysis.description)) setHit({ by: 'receipt_image', date: '' });
      }
    } catch { /* the seller can still go on and type the amount */ }
    finally { if (!stale()) setAnalyzing(false); }

    // Asked early whether this PHOTO was paid already (the brain and this app's direct sales); the server refuses
    // again at payment. No number is asked about: there is none.
    const found = localHash ? await checkDedup(unitId, { receiptHash: localHash }, withCallerHex({ 'Content-Type': 'application/json' })) : null;
    if (found && !stale()) setHit(found);
  };

  const pick = (capture: boolean, big: boolean) => (
    <label className="cursor-pointer">
      <input
        data-testid={capture ? 'receipt-camera' : 'receipt-gallery'}
        type="file"
        accept="image/*"
        {...(capture ? { capture: 'environment' as const } : {})}
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void handleFile(f); }}
      />
      {big ? (
        capture
          ? <div className="h-14 rounded-2xl text-sm font-semibold gap-2 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 flex items-center justify-center"><Camera className="w-5 h-5" /> {t('cash.takePhotoLabel')}</div>
          : <div className="h-14 rounded-2xl text-sm font-semibold gap-2 border-2 border-primary text-primary bg-primary/5 hover:bg-primary/10 flex items-center justify-center"><ImagePlus className="w-5 h-5" /> {t('cash.uploadFromGallery')}</div>
      ) : (
        <div className="h-12 rounded-2xl text-sm font-medium gap-2 border border-input hover:bg-accent flex items-center justify-center">
          {capture ? <><Camera className="w-4 h-4" /> {t('cash.retakePhoto')}</> : <><ImagePlus className="w-4 h-4" /> {t('cash.uploadFromGallery')}</>}
        </div>
      )}
    </label>
  );

  return (
    <div data-testid="receipt-step" className="flex flex-col gap-5 px-6 py-4">
      {header}
      <p className="text-sm text-muted-foreground">{t('cash.receiptInstruction')}</p>

      {preview ? (
        <div className="relative rounded-2xl overflow-hidden border bg-muted">
          <img src={preview} alt="Receipt" className="w-full max-h-64 object-contain" />
          {uploading && <div className="absolute inset-0 bg-background/50 flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>}
          {url && !uploading && <div className="absolute top-3 right-3"><CheckCircle className="w-6 h-6 text-emerald-500 bg-white rounded-full" /></div>}
        </div>
      ) : null}
      {uploadError && <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-3"><p className="text-sm text-destructive text-center">{uploadError}</p></div>}
      {analyzing && (
        <div className="rounded-2xl bg-primary/5 border border-primary/10 p-3 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <p className="text-xs text-primary">{t('cash.analyzingImage')}</p>
        </div>
      )}
      {!analyzing && description && preview && (
        <div className={`rounded-2xl p-4 border ${kind === 'receipt' ? 'bg-emerald-50 dark:bg-emerald-500/5 border-emerald-200 dark:border-emerald-500/10' : 'bg-amber-50 dark:bg-amber-500/5 border-amber-200 dark:border-amber-500/10'}`}>
          <p className={`text-xl font-semibold ${kind === 'receipt' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
            {kind === 'receipt' ? t('cash.receiptDetected') : t('cash.photoNotReceipt')}
          </p>
          <p className="text-xl text-foreground/85 mt-1.5 leading-relaxed whitespace-pre-wrap break-words">{description}</p>
        </div>
      )}
      {/* A hit on the photo hides Continue: a new photo is needed. */}
      {hit && (
        <div data-testid="receipt-dedup" className="rounded-2xl p-4 border bg-destructive/10 border-destructive/20">
          <p className="text-xl text-destructive text-center leading-relaxed">
            {t(hit.by === 'receipt_image' ? 'cash.duplicateReceiptImage' : 'cash.duplicateInvoice', { date: hit.date })}
          </p>
        </div>
      )}
      {!preview ? (
        <div className="grid grid-cols-2 gap-2">
          {pick(true, true)}
          {pick(false, true)}
        </div>
      ) : (
        <>
          {!analyzing && !hit && (
            <Button
              data-testid="receipt-continue"
              onClick={() => onDone({ url, hash, amount, description: sold })}
              className="w-full h-14 rounded-2xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
              disabled={uploading}
            >
              {t('cash.continueToInvoice')}
            </Button>
          )}
          <div className="grid grid-cols-2 gap-2">
            {pick(true, false)}
            {pick(false, false)}
          </div>
        </>
      )}
      {!hit && (
        <button data-testid="receipt-skip" onClick={() => onDone(NO_RECEIPT)} className="text-xs text-muted-foreground text-center hover:text-foreground transition-colors mt-1">
          {t('cash.skipNoReceipt')}
        </button>
      )}
      {footer}
    </div>
  );
}
