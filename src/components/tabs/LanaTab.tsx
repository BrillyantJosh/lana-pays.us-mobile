import { useState, useEffect, useRef } from "react";
import { useTranslation } from 'react-i18next';
import { Loader2, CheckCircle2, AlertCircle, Snowflake, ExternalLink, Camera, CheckCircle, ImagePlus } from "lucide-react";
import { compressImage } from "@/lib/compress-image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QRScanner } from "@/components/QRScanner";
import { convertWifToIds } from "@/lib/crypto";
import { signCustomerLanaTx } from "@/lib/transaction";
import { useAuth } from "@/contexts/AuthContext";
import lanaIcon from "@/assets/lana-icon.png";

const CURRENCY_SYMBOL: Record<string, string> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
};

/** Format LANA amount: show up to 8 decimals, only significant digits */
function formatLana(amount: number): string {
  if (Number.isInteger(amount)) return amount.toLocaleString();
  return parseFloat(amount.toFixed(8)).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

interface LanaTabProps {
  paymentRequest?: { walletAddress: string; invoiceNumber?: string; amount?: number } | null;
  onClearRequest?: () => void;
  unitCurrency?: string;
  unitId?: string;
}

type Step = "receipt" | "entry" | "display" | "processing" | "paid";

const LanaTab = ({ paymentRequest, onClearRequest, unitCurrency, unitId }: LanaTabProps) => {
  const { t } = useTranslation();
  const { session } = useAuth();
  const currency = unitCurrency || session?.currency || 'GBP';
  const currencySymbol = CURRENCY_SYMBOL[currency] || '£';

  // Keep props fresh via refs (avoid stale closures in async callbacks)
  const unitIdRef = useRef(unitId);
  unitIdRef.current = unitId;

  const [step, setStep] = useState<Step>("receipt");
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [receiptHash, setReceiptHash] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [receiptType, setReceiptType] = useState<'receipt' | 'photo'>('receipt');
  const [analysisDescription, setAnalysisDescription] = useState<string | null>(null);
  // Pre-flight dedup result — populated after upload+analyse if Brain already
  // has a persisted purchase with this receipt hash or invoice number. Hides
  // the "Continue" button until the seller retakes the photo.
  const [dedupHit, setDedupHit] = useState<{ by: 'receipt_image' | 'invoice'; date: string } | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [lanaAmount, setLanaAmount] = useState<number>(0);
  const [exchangeRate, setExchangeRate] = useState<number>(0);
  const [rateError, setRateError] = useState<string | null>(null);
  const [isLoadingRate, setIsLoadingRate] = useState(false);

  // Display step state
  const [wifScannerOpen, setWifScannerOpen] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [isCheckingBalance, setIsCheckingBalance] = useState(false);
  const [customerWalletId, setCustomerWalletId] = useState<string | null>(null);
  const [customerBalance, setCustomerBalance] = useState<number | null>(null);
  const [isFrozen, setIsFrozen] = useState(false);

  // Processing/paid state
  const [txHash, setTxHash] = useState<string | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  // Cross-tab entry
  useEffect(() => {
    if (paymentRequest?.walletAddress) {
      setCustomerWalletId(paymentRequest.walletAddress);
      if (paymentRequest.invoiceNumber) setInvoiceNumber(paymentRequest.invoiceNumber);
      if (paymentRequest.amount) {
        setAmount(String(paymentRequest.amount));
        // Auto-advance to display if we have all data
        fetchRateAndAdvance(paymentRequest.amount);
      }
    }
  }, [paymentRequest]);

  const fetchRateAndAdvance = async (fiatAmount: number) => {
    setIsLoadingRate(true);
    setRateError(null);
    try {
      const res = await fetch('/api/system-params');
      const json = await res.json();
      const rates = json.data?.exchangeRates;
      const rate = rates?.[currency] || 0;
      if (!rate || rate <= 0) {
        setRateError(t('lana.rateNotAvailable'));
        setIsLoadingRate(false);
        return;
      }
      setExchangeRate(rate);
      const lana = parseFloat((fiatAmount / rate).toFixed(8));
      setLanaAmount(lana);
      setStep("display");
      setWifScannerOpen(true);
    } catch {
      setRateError(t('lana.rateFetchFailed'));
    } finally {
      setIsLoadingRate(false);
    }
  };

  const handleContinue = () => {
    const fiat = parseFloat(amount.replace(',', '.'));
    if (!invoiceNumber.trim() || isNaN(fiat) || fiat <= 0) return;
    fetchRateAndAdvance(fiat);
  };

  const handleWifScan = async (data: string) => {
    const trimmed = data.trim();

    // Reject wallet addresses
    if (trimmed.startsWith('L') && trimmed.length >= 26 && trimmed.length <= 35) {
      setScanError(t('lana.walletAddressNotWif'));
      return;
    }

    // Reject Nostr keys
    if (trimmed.startsWith('npub') || trimmed.startsWith('nsec')) {
      setScanError(t('lana.nostrKeyNotWif'));
      return;
    }

    setScanError(null);
    setIsCheckingBalance(true);
    setIsFrozen(false);

    try {
      const ids = await convertWifToIds(trimmed);
      setCustomerWalletId(ids.walletId);

      // Check if wallet is frozen or not registered
      try {
        const checkRes = await fetch('/api/check-wallet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_id: ids.walletId }),
        });
        const checkJson = await checkRes.json();
        if (checkJson.success && checkJson.wallet?.frozen) {
          setIsFrozen(true);
          setIsCheckingBalance(false);
          return;
        }
        // If wallet is not registered, check balance first
        if (checkJson.success && !checkJson.registered) {
          const balRes = await fetch(`/api/balance/${encodeURIComponent(ids.walletId)}?currency=${currency}`);
          const balData = await balRes.json();
          const walletLana = balData.lana || 0;
          if (walletLana > 0) {
            setScanError(t('lana.walletNotVirgin', { balance: walletLana.toLocaleString() }));
            setIsCheckingBalance(false);
            return;
          }
          // Virgin wallet — try to auto-register
          try {
            await fetch('/api/register/wallet', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ wallet_id: ids.walletId, nostr_id_hex: ids.nostrHexId }),
            });
          } catch {} // best effort
        }
      } catch {
        // If check fails, continue anyway — balance check is more important
      }

      // Check balance
      const res = await fetch(`/api/balance/${encodeURIComponent(ids.walletId)}?currency=${currency}`);
      const balanceData = await res.json();

      if (!res.ok) {
        throw new Error(balanceData.error || 'Failed to check balance');
      }

      const walletLana = balanceData.lana || 0;
      setCustomerBalance(walletLana);

      if (walletLana < lanaAmount) {
        setScanError(t('lana.insufficientBalance', { balance: walletLana.toLocaleString(), required: formatLana(lanaAmount) }));
        setIsCheckingBalance(false);
        return;
      }

      // Sufficient balance — proceed to processing
      setIsCheckingBalance(false);
      setStep("processing");
      setPurchaseError(null);

      // Input validation
      const parsedAmount = parseFloat(amount.replace(',', '.'));
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        setPurchaseError(t('cash.invalidAmount'));
        return;
      }
      const maxTx = (window as any).__maxTransactionAmount;
      if (maxTx && parsedAmount > maxTx) {
        setPurchaseError(t('lana.exceedsMaxLimit', { amount: maxTx }));
        return;
      }

      // Best-effort customer name lookup so brain can snapshot it on the
      // transaction (survives relay event loss). Non-blocking — empty string
      // is fine, brain falls back to live KIND 0 cache.
      let customerName = '';
      try {
        const lookup = await fetch(`/api/users/by-wallet/${encodeURIComponent(ids.walletId)}`);
        if (lookup.ok) {
          const j = await lookup.json();
          customerName = j?.user?.display_name || '';
        }
      } catch { /* ignore — purchase proceeds without name */ }

      // Purchase body — ALWAYS uses signed_tx_hex (client-side signing).
      // The customer's WIF never leaves the device. There is NO fallback to
      // server-side WIF signing: if local signing fails, the purchase fails
      // with an error and the customer must retry. This is by design — the
      // security guarantee "WIF never leaves the device" must be absolute.
      const basePurchaseBody = {
        unit_id: unitIdRef.current || '',
        payment_type: 'lana' as const,
        customer_hex: ids.nostrHexId,
        customer_wallet: ids.walletId,
        customer_name: customerName,
        amount: parsedAmount,
        currency,
        invoice_number: invoiceNumber.trim(),
        receipt_url: receiptUrl || undefined,
        receipt_hash: receiptHash || undefined,
        receipt_type: receiptType || 'receipt',
        receipt_description: analysisDescription || undefined,
      };

      try {
        // ── Client-side signing (the ONLY path) ──────────────────
        // 1) Ask Brain for the recipient list (read-only, no DB writes)
        // 2) Sign the LANA TX locally with the WIF (WIF stays in browser)
        // 3) Submit signed_tx_hex to Brain → Lana.Discount broadcasts

        const previewRes = await fetch('/api/brain/purchase/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            unit_id: basePurchaseBody.unit_id,
            customer_hex: basePurchaseBody.customer_hex,
            customer_wallet: basePurchaseBody.customer_wallet,
            amount: basePurchaseBody.amount,
            currency: basePurchaseBody.currency,
          }),
        });
        const previewData = await previewRes.json();
        if (!previewRes.ok || !previewData.success) {
          setPurchaseError(previewData.error || t('lana.purchaseFailed'));
          setStep("display");
          return;
        }
        const recipients = previewData.data.recipients || [];
        if (!Array.isArray(recipients) || recipients.length === 0) {
          setPurchaseError(t('lana.purchaseFailed'));
          setStep("display");
          return;
        }

        // Sign locally — WIF never leaves the device
        console.log(`[mobile] Signing LANA TX locally for ${recipients.length} recipient(s)`);
        let signedTxHex: string;
        try {
          const signed = await signCustomerLanaTx({
            wif: trimmed,
            recipients: recipients.map((r: any) => ({
              address: r.address,
              amount: r.amount_lanoshis,
            })),
          });
          signedTxHex = signed.signedTxHex;
          console.log(`[mobile] Signed locally: ${signedTxHex.length / 2} bytes, fee=${signed.fee}`);
        } catch (signErr: any) {
          // NO fallback to server-side WIF signing — security guarantee is absolute.
          console.error('[mobile] Client-side signing failed:', signErr.message);
          setPurchaseError(signErr.message || t('lana.purchaseFailed'));
          setStep("display");
          return;
        }

        const purchaseBody = { ...basePurchaseBody, signed_tx_hex: signedTxHex };

        const purchaseRes = await fetch('/api/brain/purchase', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(purchaseBody),
        });

        const brainData = await purchaseRes.json();

        if (!purchaseRes.ok || !brainData.success) {
          // Brain returns 409 with a structured body when this receipt was
          // already used for a prior purchase. Surface a clear localized
          // message naming the date of the original transaction.
          if (purchaseRes.status === 409 && (brainData?.error === 'DUPLICATE_RECEIPT_IMAGE' || brainData?.error === 'DUPLICATE_INVOICE')) {
            const date = brainData?.original_created_at
              ? new Date(brainData.original_created_at + 'Z').toLocaleString()
              : '';
            const key = brainData.error === 'DUPLICATE_RECEIPT_IMAGE'
              ? 'cash.duplicateReceiptImage'
              : 'cash.duplicateInvoice';
            setPurchaseError(t(key, { date }));
          } else {
            setPurchaseError(brainData.error || t('lana.purchaseFailed'));
          }
          setStep("display");
          return;
        }

        setTxHash(brainData.data.tx_hash || brainData.data.transaction_id);
        setStep("paid");
      } catch (err: any) {
        setPurchaseError(t('lana.networkError'));
        setStep("display");
      }

    } catch (err) {
      setScanError(err instanceof Error ? err.message : t('lana.invalidWifKey'));
      setIsCheckingBalance(false);
    }
  };

  const resetAll = () => {
    setStep("entry");
    setInvoiceNumber("");
    setAmount("");
    setLanaAmount(0);
    setExchangeRate(0);
    setRateError(null);
    setScanError(null);
    setIsCheckingBalance(false);
    setCustomerWalletId(null);
    setCustomerBalance(null);
    setIsFrozen(false);
    setTxHash(null);
    setPurchaseError(null);
    onClearRequest?.();
  };

  // Receipt upload handler
  const handleReceiptFile = async (rawFile: File) => {
    if (rawFile.size > 30 * 1024 * 1024) {
      setUploadError(t('cash.fileTooLarge', { size: (rawFile.size / 1024 / 1024).toFixed(1) }));
      return;
    }

    setUploadError(null);
    setDedupHit(null);
    setReceiptHash(null);

    // Show preview from the ORIGINAL so the seller sees what they captured
    const reader = new FileReader();
    reader.onload = (e) => setReceiptPreview(e.target?.result as string);
    reader.readAsDataURL(rawFile);

    setIsUploading(true);

    // Silently compress on-device — typical 8 MB phone photo → ~400 KB
    const { file } = await compressImage(rawFile);

    // Local mirrors so the dedup pre-flight at the end can read the values
    // we just computed without waiting for React state to flush.
    let localHash: string | null = null;
    let localInvoiceNumber: string | null = null;

    try {
      const formData = new FormData();
      formData.append('receipt', file, file.name);
      const res = await fetch('/api/receipt/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success && data.url) {
        setReceiptUrl(data.url);
        if (typeof data.hash === 'string') {
          setReceiptHash(data.hash);
          localHash = data.hash;
        }
      }
      else setUploadError(t('cash.uploadFailed'));
    } catch {
      setUploadError(t('cash.networkErrorRetry'));
    } finally {
      setIsUploading(false);
    }

    // Analyze with Claude Vision
    setIsAnalyzing(true);
    try {
      const analyzeForm = new FormData();
      analyzeForm.append('receipt', file, file.name);
      analyzeForm.append('currency', currency);
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
      } else if (analysis.analysisError) {
        // Anthropic overloaded / failed — let the user know they can still continue manually
        setReceiptType('photo');
        setAnalysisDescription(
          analysis.analysisError === 'overloaded'
            ? t('cash.aiOverloaded')
            : t('cash.aiFailed')
        );
      } else {
        setReceiptType('photo');
        setAnalysisDescription(analysis.description || t('cash.photoCaptured'));
      }
    } catch {}
    finally { setIsAnalyzing(false); }

    // ── Pre-flight dedup check ─────────────────────────────────────────
    // Ask Brain if this receipt was already used (by image hash or by the
    // invoice number Claude just extracted). On hit, dedupHit hides the
    // "Continue" button until the seller retakes a fresh photo. Brain
    // still enforces dedup at submit, so a soft fail here is acceptable.
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
      } catch {
        // Soft-fail: Brain re-enforces on submit anyway.
      }
    }
  };

  // ─── STEP: Receipt ─────────────────────────────
  if (step === "receipt") {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <img src={lanaIcon} alt="LANA" className="w-7 h-7" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">{t('lana.title')}</h2>
            <p className="text-muted-foreground text-sm">{t('lana.receiptSubtitle')}</p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('cash.receiptInstruction')}
        </p>
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
            <p className={`text-sm font-semibold ${receiptType === 'receipt' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
              {receiptType === 'receipt' ? t('cash.receiptDetected') : t('cash.photoNotReceipt')}
            </p>
            <p className="text-sm text-foreground/85 mt-1.5 leading-relaxed whitespace-pre-wrap break-words">{analysisDescription}</p>
          </div>
        )}
        {/* Pre-flight dedup banner — hides Continue while shown */}
        {dedupHit && (
          <div className="rounded-2xl p-4 border bg-destructive/10 border-destructive/20">
            <p className="text-sm text-destructive text-center leading-relaxed">
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
              <Button onClick={() => setStep("entry")} className="w-full h-14 rounded-2xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20" disabled={isUploading}>{t('cash.continueToInvoice')}</Button>
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
          <button onClick={() => setStep("entry")} className="text-xs text-muted-foreground text-center hover:text-foreground transition-colors mt-1">{t('cash.skipNoReceipt')}</button>
        )}
      </div>
    );
  }

  // ─── STEP: Entry ─────────────────────────────
  if (step === "entry") {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <img src={lanaIcon} alt="Lana" className="w-7 h-7 object-contain dark:invert" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">{t('lana.entryTitle')}</h2>
            <p className="text-muted-foreground text-sm">{t('lana.entrySubtitle')}</p>
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
              {t('cash.amount', { symbol: currencySymbol })} <span className="text-destructive">*</span>
            </Label>
            <Input
              type="text"
              inputMode="decimal"
              placeholder={t('cash.amountPlaceholder')}
              value={amount}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.,]/g, '');
                setAmount(v);
              }}
              className="h-12 rounded-xl bg-background border-input"
            />
            {(() => {
              const maxTx = (window as any).__maxTransactionAmount;
              const parsed = parseFloat(amount.replace(',', '.'));
              if (maxTx !== null && maxTx !== undefined && maxTx <= 0) {
                return <p className="text-xs text-destructive mt-1">{t('cash.noFunds')}</p>;
              }
              if (maxTx !== null && maxTx !== undefined && !isNaN(parsed) && parsed > maxTx) {
                return (
                  <p className="text-xs text-destructive mt-1">
                    {t('cash.exceedsMax', { symbol: currencySymbol, amount: maxTx.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}
                  </p>
                );
              }
              // Pre-flight quota check
              const u = (window as any).__selectedUnit;
              if (u && u.quota_volume_limit > 0 && !isNaN(parsed)) {
                const remainingVolume = Math.max(0, u.quota_volume_limit - (u.quota_volume_used || 0));
                const remainingTx = Math.max(0, (u.quota_tx_limit || 0) - (u.quota_tx_used || 0));
                const sameCurrency = (u.quota_currency || 'EUR') === currency;
                if (remainingTx <= 0) {
                  return <p className="text-xs text-destructive mt-1">Monthly transaction limit reached. Resets next month.</p>;
                }
                if (sameCurrency && parsed > remainingVolume) {
                  return <p className="text-xs text-destructive mt-1">This payment would exceed the monthly quota. Available: {remainingVolume.toFixed(2)} {currency}</p>;
                }
              }
              return null;
            })()}
          </div>
        </div>

        {rateError && (
          <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4">
            <p className="text-sm text-destructive text-center">{rateError}</p>
          </div>
        )}

        <Button
          onClick={handleContinue}
          disabled={!invoiceNumber.trim() || !amount.trim() || parseFloat(amount.replace(',', '.')) <= 0 || isLoadingRate || (() => {
            const maxTx = (window as any).__maxTransactionAmount;
            if (maxTx !== null && maxTx !== undefined && maxTx <= 0) return true;
            const parsed = parseFloat(amount.replace(',', '.'));
            if (maxTx !== null && maxTx !== undefined && !isNaN(parsed) && parsed > maxTx) return true;
            // Pre-flight quota check
            const u = (window as any).__selectedUnit;
            if (u && u.quota_volume_limit > 0 && !isNaN(parsed)) {
              const remainingVolume = Math.max(0, u.quota_volume_limit - (u.quota_volume_used || 0));
              const remainingTx = Math.max(0, (u.quota_tx_limit || 0) - (u.quota_tx_used || 0));
              if (remainingTx <= 0) return true;
              if ((u.quota_currency || 'EUR') === currency && parsed > remainingVolume) return true;
            }
            return false;
          })()}
          className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 disabled:opacity-50"
        >
          {isLoadingRate ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              {t('lana.loadingRate')}
            </>
          ) : (
            t('lana.continueToPayment')
          )}
        </Button>
      </div>
    );
  }

  // ─── STEP: Display (customer-facing) ─────────
  if (step === "display") {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        {/* Payment amounts — designed for customer to read */}
        <div className="flex flex-col items-center gap-2 py-4">
          <p className="text-sm text-muted-foreground">{t('cash.invoiceLabel', { number: invoiceNumber })}</p>

          <p className="text-2xl font-semibold text-foreground">
            {currencySymbol}{parseFloat(amount.replace(',', '.')).toFixed(2)}
          </p>

          <div className="flex items-center gap-3 py-3">
            <img src={lanaIcon} alt="Lana" className="w-10 h-10 object-contain dark:invert" />
            <span className="text-5xl font-black text-primary tracking-tight">
              {formatLana(lanaAmount)}
            </span>
            <span className="text-2xl font-bold text-primary/70">LANA</span>
          </div>

          <p className="text-xs text-muted-foreground">
            {t('lana.rateDisplay', { symbol: currencySymbol, rate: parseFloat(exchangeRate.toFixed(8)) })}
          </p>
        </div>

        {/* Balance check loading */}
        {isCheckingBalance && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t('lana.checkingBalance')}</p>
          </div>
        )}

        {/* Frozen wallet */}
        {isFrozen && !isCheckingBalance && (
          <div className="space-y-4">
            <div className="rounded-2xl bg-blue-50 border border-blue-200 p-4 space-y-3 dark:bg-blue-950/30 dark:border-blue-800">
              <div className="flex items-center gap-3">
                <Snowflake className="w-5 h-5 text-blue-500 flex-shrink-0" />
                <p className="text-sm font-medium text-blue-700 dark:text-blue-400">{t('lana.walletFrozen')}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('lana.frozenDescription')}
              </p>
              <a
                href="https://unfreeze.lanapays.us"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full h-11 rounded-xl bg-blue-100 text-blue-700 text-sm font-semibold hover:bg-blue-200 transition-colors dark:bg-blue-900/40 dark:text-blue-400 dark:hover:bg-blue-900/60"
              >
                <ExternalLink className="w-4 h-4" />
                {t('lana.goToUnfreeze')}
              </a>
            </div>
            <Button
              onClick={() => { setIsFrozen(false); setWifScannerOpen(true); }}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {t('lana.scanAnotherWif')}
            </Button>
          </div>
        )}

        {/* Purchase error from Brain */}
        {purchaseError && !isCheckingBalance && !isFrozen && !scanError && (
          <div className="space-y-4">
            <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                <p className="text-sm text-destructive">{purchaseError}</p>
              </div>
            </div>
            <Button
              onClick={() => { setPurchaseError(null); setWifScannerOpen(true); }}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {t('common.tryAgain')}
            </Button>
          </div>
        )}

        {/* Scan error / insufficient balance */}
        {scanError && !isCheckingBalance && !isFrozen && (
          <div className="space-y-4">
            <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                <p className="text-sm text-destructive">{scanError}</p>
              </div>
            </div>
            <Button
              onClick={() => { setScanError(null); setWifScannerOpen(true); }}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {t('common.scanAgain')}
            </Button>
          </div>
        )}

        {/* Prompt to scan — when idle */}
        {!scanError && !purchaseError && !isCheckingBalance && !isFrozen && (
          <div className="flex flex-col items-center gap-4">
            <p className="text-sm text-muted-foreground text-center">
              {t('lana.askCustomerWif')}
            </p>
            <Button
              onClick={() => setWifScannerOpen(true)}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
            >
              <img src={lanaIcon} alt="Lana" className="w-5 h-5 object-contain dark:invert" />
              {t('lana.scanCustomerWif')}
            </Button>
          </div>
        )}

        <QRScanner
          isOpen={wifScannerOpen}
          onClose={() => setWifScannerOpen(false)}
          onScan={handleWifScan}
          title={t('lana.scanWifTitle')}
          description={t('lana.scanWifDescription')}
        >
          <div className="flex items-center justify-between rounded-xl bg-secondary p-3">
            <span className="text-sm text-muted-foreground">
              {currencySymbol}{parseFloat(amount.replace(',', '.')).toFixed(2)}
            </span>
            <div className="flex items-center gap-1.5">
              <img src={lanaIcon} alt="Lana" className="w-5 h-5 object-contain dark:invert" />
              <span className="text-lg font-bold text-primary">
                {formatLana(lanaAmount)} LANA
              </span>
            </div>
          </div>
        </QRScanner>
      </div>
    );
  }

  // ─── STEP: Processing ────────────────────────
  if (step === "processing") {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-16">
        <Loader2 className="w-14 h-14 animate-spin text-primary" />
        <h2 className="text-xl font-bold text-foreground">{t('lana.processingTitle')}</h2>
        <p className="text-sm text-muted-foreground text-center">
          {t('lana.sendingLana', { amount: formatLana(lanaAmount) })}
        </p>
      </div>
    );
  }

  // ─── STEP: Paid ──────────────────────────────
  return (
    <div className="flex flex-col gap-5 px-6 py-4">
      <div className="flex flex-col items-center gap-3 py-8">
        <CheckCircle2 className="w-14 h-14 text-primary" />
        <h2 className="text-2xl font-bold text-foreground">{t('lana.paidTitle')}</h2>
        <p className="text-lg text-muted-foreground">
          {t('cash.invoiceLabel', { number: invoiceNumber })}
        </p>
      </div>

      <div className="glass-card rounded-2xl p-5 space-y-3">
        <div className="flex justify-between items-baseline">
          <span className="text-sm text-muted-foreground">{t('lana.amountLabel')}</span>
          <span className="text-base font-semibold text-foreground">
            {currencySymbol}{parseFloat(amount.replace(',', '.')).toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between items-baseline">
          <span className="text-sm text-muted-foreground">LANA</span>
          <span className="text-base font-bold text-primary">
            {formatLana(lanaAmount)} LANA
          </span>
        </div>
        <div className="flex justify-between items-baseline">
          <span className="text-sm text-muted-foreground">{t('lana.rateLabel')}</span>
          <span className="text-sm text-foreground">
            {t('lana.rateDisplay', { symbol: currencySymbol, rate: parseFloat(exchangeRate.toFixed(8)) })}
          </span>
        </div>
        <div className="pt-2 border-t border-border space-y-1">
          <p className="text-xs text-muted-foreground">{t('lana.customerWallet')}</p>
          <p className="text-xs font-mono text-foreground break-all">{customerWalletId}</p>
        </div>
        {txHash && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t('lana.blockchainTx')}</p>
            {txHash.length === 64 ? (
              <a
                href={`https://chainz.cryptoid.info/lana/tx.dws?${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-mono text-primary underline break-all"
              >
                {txHash}
              </a>
            ) : (
              <p className="text-xs font-mono text-foreground break-all">{txHash}</p>
            )}
          </div>
        )}
      </div>

      <Button
        onClick={() => window.location.href = '/'}
        className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
      >
        {t('common.newPayment')}
      </Button>
    </div>
  );
};

export default LanaTab;
