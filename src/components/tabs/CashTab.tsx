import { useState, useEffect, useRef } from "react";
import { Camera, PoundSterling, DollarSign, Euro, Loader2, CheckCircle2, UserPlus, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QRScanner } from "@/components/QRScanner";
import { convertWifToIds } from "@/lib/crypto";
import { useAuth } from "@/contexts/AuthContext";

const currencyIcons: Record<string, typeof PoundSterling> = {
  GBP: PoundSterling, USD: DollarSign, EUR: Euro,
};
const CURRENCY_SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
const CURRENCY_LOCALE: Record<string, { locale: string; code: string }> = {
  GBP: { locale: 'en-GB', code: 'GBP' },
  USD: { locale: 'en-US', code: 'USD' },
  EUR: { locale: 'de-DE', code: 'EUR' },
};

const COUNTRY_CODES = [
  { code: "+44", country: "UK" }, { code: "+386", country: "SI" }, { code: "+1", country: "US" },
  { code: "+49", country: "DE" }, { code: "+33", country: "FR" }, { code: "+39", country: "IT" },
  { code: "+34", country: "ES" }, { code: "+43", country: "AT" }, { code: "+385", country: "HR" },
  { code: "+381", country: "RS" }, { code: "+387", country: "BA" }, { code: "+382", country: "ME" },
  { code: "+355", country: "AL" }, { code: "+30", country: "GR" }, { code: "+36", country: "HU" },
  { code: "+48", country: "PL" }, { code: "+420", country: "CZ" }, { code: "+421", country: "SK" },
  { code: "+40", country: "RO" }, { code: "+359", country: "BG" },
];

interface BalanceResult {
  address: string; lana: number; fiatValue: number;
  confirmed: number; unconfirmed: number; rate: number; currency: string;
}

interface CashTabProps {
  selectedWallet?: string | null;
  onClearWallet?: () => void;
  unitCurrency?: string;
  unitId?: string;
}

/** Purchase data snapshot — captured BEFORE scanner opens to avoid stale closures */
interface PurchaseSnapshot {
  unitId: string;
  invoiceNumber: string;
  amount: string;
  currency: string;
  receiptUrl: string | null;
  receiptType: 'receipt' | 'photo';
}

type Step = "receipt" | "invoice" | "scan" | "register" | "confirmed";

const UPLOAD_URL = '/api/receipt/upload';

const CashTab = ({ selectedWallet, onClearWallet, unitCurrency, unitId }: CashTabProps) => {
  const { session } = useAuth();
  const currency = unitCurrency || session?.currency || 'GBP';
  const CurrencyIcon = currencyIcons[currency] || PoundSterling;
  const currencySymbol = CURRENCY_SYMBOL[currency] || '£';

  const [step, setStep] = useState<Step>("receipt");

  // ══════ SNAPSHOT REF — the ONLY ref needed for purchase data ══════
  // Set synchronously BEFORE scanner opens. Scanner callback reads from this.
  const purchaseDataRef = useRef<PurchaseSnapshot | null>(null);

  // Receipt state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Scan state
  const [scannerOpen, setScannerOpen] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  // Wallet data
  const [walletId, setWalletId] = useState<string | null>(null);
  const [nostrHexId, setNostrHexId] = useState<string | null>(null);
  const [nostrNpubId, setNostrNpubId] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceResult | null>(null);

  // Registration form
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [countryCode, setCountryCode] = useState("+386");
  const [mobile, setMobile] = useState("");

  // Invoice form
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Receipt analysis
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [receiptType, setReceiptType] = useState<'receipt' | 'photo'>('receipt');
  const [analysisDescription, setAnalysisDescription] = useState<string | null>(null);

  // Cross-tab entry: wallet already verified from WalletsTab
  const initializedRef = useRef(false);
  useEffect(() => {
    if (selectedWallet && !initializedRef.current) {
      initializedRef.current = true;
      setWalletId(selectedWallet);
      setCheckError(null);
      fetchBalance(selectedWallet);
      setStep(receiptUrl ? "invoice" : "receipt");
    }
  }, [selectedWallet]);

  // Handle receipt photo
  const handleReceiptFile = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      setUploadError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => setReceiptPreview(e.target?.result as string);
    reader.readAsDataURL(file);
    setIsUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('receipt', file, file.name);
      const res = await fetch(UPLOAD_URL, { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success && data.url) setReceiptUrl(data.url);
      else setUploadError('Upload failed. Please try again.');
    } catch {
      setUploadError('Network error. Photo saved locally — will retry on submit.');
    } finally {
      setIsUploading(false);
    }

    // Analyze the receipt with Claude Vision
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
        if (analysis.invoiceNumber) setInvoiceNumber(analysis.invoiceNumber);
        if (analysis.items) setAnalysisDescription(analysis.items);
      } else {
        setReceiptType('photo');
        setAnalysisDescription(analysis.description || 'Photo captured');
      }
    } catch {
      // Analysis failed silently — user can still enter details manually
    } finally {
      setIsAnalyzing(false);
    }
  };

  const fetchBalance = async (address: string) => {
    try {
      const res = await fetch(`/api/balance/${encodeURIComponent(address)}?currency=${currency}`);
      const json = await res.json();
      if (res.ok) setBalance(json);
    } catch {}
  };

  const resetAll = () => {
    setStep("receipt");
    setReceiptPreview(null);
    setReceiptUrl(null);
    setUploadError(null);
    setWalletId(null);
    setNostrHexId(null);
    setNostrNpubId(null);
    setBalance(null);
    setCheckError(null);
    setSubmitError(null);
    setFullName("");
    setEmail("");
    setCountryCode("+386");
    setMobile("");
    setInvoiceNumber("");
    setAmount("");
    purchaseDataRef.current = null;
    onClearWallet?.();
  };

  // ══════ SCAN HANDLER — reads from purchaseDataRef snapshot ══════
  const handleScan = async (data: string) => {
    const trimmed = data.trim();
    const pd = purchaseDataRef.current;

    if (!pd || !pd.invoiceNumber.trim() || !pd.amount.trim()) {
      setSubmitError('Purchase data missing. Please go back and enter invoice details.');
      return;
    }

    setIsChecking(true);
    setCheckError(null);
    setSubmitError(null);
    setBalance(null);

    try {
      let resolvedWalletId: string;
      let resolvedHexId: string | null = null;
      let hasNostrKeys = false;

      const isWalletAddress = trimmed.startsWith('L') && trimmed.length >= 26 && trimmed.length <= 35;

      if (isWalletAddress) {
        resolvedWalletId = trimmed;
      } else {
        const ids = await convertWifToIds(trimmed);
        resolvedWalletId = ids.walletId;
        resolvedHexId = ids.nostrHexId;
        setNostrHexId(ids.nostrHexId);
        setNostrNpubId(ids.nostrNpubId);
        hasNostrKeys = true;
      }

      setWalletId(resolvedWalletId);

      // Check registration + balance + hex lookup in parallel
      const [regRes, balanceRes, userLookup] = await Promise.all([
        fetch('/api/check-wallet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_id: resolvedWalletId }),
        }).then(r => r.json()),
        fetch(`/api/balance/${encodeURIComponent(resolvedWalletId)}?currency=${pd.currency}`)
          .then(r => r.json().then(j => ({ ok: r.ok, json: j })))
          .catch(() => null),
        !hasNostrKeys
          ? fetch(`/api/users/by-wallet/${encodeURIComponent(resolvedWalletId)}`)
              .then(r => r.json()).catch(() => ({ user: null }))
          : Promise.resolve(null),
      ]);

      if (!hasNostrKeys && userLookup?.user) {
        resolvedHexId = userLookup.user.hex_id;
        setNostrHexId(userLookup.user.hex_id);
        setNostrNpubId(userLookup.user.npub);
      }

      if (balanceRes?.ok) setBalance(balanceRes.json);

      if (regRes.success) {
        if (regRes.registered) {
          // ══════ SUBMIT PURCHASE — using snapshot data ══════
          const parsedAmount = parseFloat(pd.amount.replace(',', '.'));
          if (isNaN(parsedAmount) || parsedAmount <= 0) {
            setSubmitError('Invalid amount');
            return;
          }

          setIsSubmitting(true);
          const res = await fetch('/api/brain/purchase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              unit_id: pd.unitId,
              payment_type: 'cash',
              customer_hex: resolvedHexId || '',
              customer_wallet: resolvedWalletId,
              amount: parsedAmount,
              currency: pd.currency,
              invoice_number: pd.invoiceNumber.trim(),
              receipt_url: pd.receiptUrl || undefined,
              receipt_type: pd.receiptType || 'receipt',
            }),
          });
          const purchaseData = await res.json();
          setIsSubmitting(false);

          if (!res.ok || !purchaseData.success) {
            setSubmitError(purchaseData.error || 'Purchase failed. Please try again.');
            return;
          }

          setStep("confirmed");
        } else if (hasNostrKeys) {
          setStep("register");
        } else {
          setCheckError('This wallet is not registered. Scan a WIF Private Key instead to register and pay.');
        }
      } else {
        setCheckError(regRes.message || 'Failed to verify wallet.');
      }
    } catch {
      setCheckError('Invalid scan. Please scan a valid Lana Wallet ID or WIF Private Key.');
    } finally {
      setIsChecking(false);
      setIsSubmitting(false);
    }
  };

  const handleRegister = async () => {
    if (!fullName.trim() || !walletId) return;
    const pd = purchaseDataRef.current;
    if (!pd) { setSubmitError('Purchase data missing.'); return; }

    const parsedAmount = parseFloat(pd.amount.replace(',', '.'));
    if (isNaN(parsedAmount) || parsedAmount <= 0) { setSubmitError('Invalid amount'); return; }

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/brain/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unit_id: pd.unitId,
          payment_type: 'cash',
          customer_hex: nostrHexId || '',
          customer_wallet: walletId,
          amount: parsedAmount,
          currency: pd.currency,
          invoice_number: pd.invoiceNumber.trim(),
          receipt_url: pd.receiptUrl || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setSubmitError(data.error || 'Purchase failed.');
        return;
      }
      setStep("confirmed");
    } catch {
      setSubmitError('Network error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // ─── Balance Card ────────────────
  const BalanceCard = ({ compact }: { compact?: boolean }) => {
    if (!balance) return null;
    return (
      <div className="glass-card rounded-2xl p-4 space-y-2">
        {!compact && <h3 className="font-semibold text-sm text-muted-foreground">Customer Balance</h3>}
        <div className="flex items-baseline gap-2">
          <span className={`${compact ? 'text-xl' : 'text-2xl'} font-bold text-foreground`}>{balance.lana.toLocaleString()}</span>
          <span className="text-sm text-muted-foreground">LANA</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className={`${compact ? 'text-base' : 'text-lg'} font-semibold text-primary`}>
            {balance.fiatValue.toLocaleString(CURRENCY_LOCALE[balance.currency]?.locale || 'en-GB', { style: 'currency', currency: balance.currency || 'GBP' })}
          </span>
        </div>
        <p className="text-xs text-muted-foreground truncate">{balance.address}</p>
      </div>
    );
  };

  // ═══════════════════════════════════════════════════════════════
  // RECEIPT STEP
  // ═══════════════════════════════════════════════════════════════
  if (step === "receipt") {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <Receipt className="w-7 h-7 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">Cash Payment</h2>
            <p className="text-muted-foreground text-sm">Take a photo of the receipt or purchase</p>
          </div>
        </div>
        <div className="glass-card rounded-2xl p-4">
          <p className="text-sm text-muted-foreground">
            Photograph the receipt or invoice. If no receipt is available, take a photo showing the purchase with the items or people involved.
          </p>
        </div>
        {receiptPreview && (
          <div className="relative rounded-2xl overflow-hidden border-2 border-primary/20">
            <img src={receiptPreview} alt="Receipt" className="w-full max-h-64 object-contain bg-black/5" />
            {isUploading && <div className="absolute inset-0 bg-black/40 flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-white" /></div>}
            {receiptUrl && <div className="absolute top-2 right-2 bg-primary text-primary-foreground rounded-full p-1"><CheckCircle2 className="w-5 h-5" /></div>}
          </div>
        )}
        {uploadError && <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-3"><p className="text-xs text-destructive text-center">{uploadError}</p></div>}
        {isAnalyzing && (
          <div className="rounded-2xl bg-primary/5 border border-primary/10 p-3 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
            <p className="text-xs text-primary">Analyzing image...</p>
          </div>
        )}
        {!isAnalyzing && analysisDescription && receiptPreview && (
          <div className={`rounded-2xl p-3 border ${receiptType === 'receipt' ? 'bg-emerald-50 dark:bg-emerald-500/5 border-emerald-200 dark:border-emerald-500/10' : 'bg-amber-50 dark:bg-amber-500/5 border-amber-200 dark:border-amber-500/10'}`}>
            <p className={`text-xs font-medium ${receiptType === 'receipt' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
              {receiptType === 'receipt' ? '✓ Receipt detected' : '📷 Photo (not a receipt)'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">{analysisDescription}</p>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleReceiptFile(f); }} className="hidden" />
        <div className="flex flex-col gap-3">
          <Button onClick={() => fileInputRef.current?.click()} disabled={isUploading || isAnalyzing} className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20">
            <Camera className="w-5 h-5" />{receiptPreview ? 'Retake Photo' : 'Take Photo'}
          </Button>
          {(receiptUrl || receiptPreview) && !isAnalyzing && (
            <Button onClick={() => setStep("invoice")} disabled={isUploading} className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-secondary text-foreground hover:bg-secondary/80">Continue to Invoice</Button>
          )}
          <button onClick={() => setStep("invoice")} className="text-xs text-muted-foreground text-center hover:text-foreground transition-colors mt-1">Skip — no receipt available</button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // SCAN STEP
  // ═══════════════════════════════════════════════════════════════
  if (step === "scan") {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0"><CurrencyIcon className="w-7 h-7 text-primary" /></div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">Cash Payment</h2>
            <p className="text-muted-foreground text-sm">Scan customer wallet or WIF key</p>
          </div>
        </div>
        {isChecking && <div className="flex flex-col items-center gap-3 py-12"><Loader2 className="w-10 h-10 animate-spin text-primary" /><p className="text-sm text-muted-foreground">Checking wallet...</p></div>}
        {(checkError || submitError) && !isChecking && (
          <div className="space-y-4">
            <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4"><p className="text-sm text-destructive text-center">{checkError || submitError}</p></div>
            <Button onClick={() => { setCheckError(null); setSubmitError(null); setScannerOpen(true); }} className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90"><Camera className="w-5 h-5" />Scan Again</Button>
          </div>
        )}
        {!isChecking && !checkError && !submitError && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Button onClick={() => setScannerOpen(true)} className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"><Camera className="w-5 h-5" />Scan Customer</Button>
          </div>
        )}
        <QRScanner isOpen={scannerOpen} onClose={() => setScannerOpen(false)} onScan={handleScan} title="Scan Customer" description="Scan a wallet address or WIF private key" />
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // REGISTER STEP
  // ═══════════════════════════════════════════════════════════════
  if (step === "register") {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0"><UserPlus className="w-7 h-7 text-primary" /></div>
          <div><h2 className="font-display text-xl font-bold text-foreground">Register Wallet</h2><p className="text-muted-foreground text-sm">This wallet needs to be registered first</p></div>
        </div>
        <BalanceCard compact />
        {submitError && <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4"><p className="text-sm text-destructive text-center">{submitError}</p></div>}
        <div className="space-y-3">
          <div className="space-y-1.5"><Label className="text-xs font-medium text-muted-foreground">Full Name <span className="text-destructive">*</span></Label><Input placeholder="First and last name" value={fullName} onChange={(e) => setFullName(e.target.value)} className="h-11 rounded-xl" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium text-muted-foreground">Email</Label><Input type="email" placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="h-11 rounded-xl" /></div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Mobile</Label>
            <div className="flex gap-2">
              <select value={countryCode} onChange={(e) => setCountryCode(e.target.value)} className="h-11 rounded-xl border border-input bg-background px-3 text-sm min-w-[90px]">
                {COUNTRY_CODES.map((c) => <option key={c.code} value={c.code}>{c.country} {c.code}</option>)}
              </select>
              <Input type="tel" placeholder="Phone number" value={mobile} onChange={(e) => setMobile(e.target.value)} className="h-11 rounded-xl flex-1" />
            </div>
          </div>
        </div>
        <Button onClick={handleRegister} disabled={!fullName.trim() || isSubmitting} className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20">
          <UserPlus className="w-5 h-5" />{isSubmitting ? 'Processing...' : 'Register & Continue'}
        </Button>
        <button onClick={resetAll} className="text-sm text-muted-foreground text-center hover:text-foreground transition-colors">Scan Another</button>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // CONFIRMED STEP
  // ═══════════════════════════════════════════════════════════════
  if (step === "confirmed") {
    const pd = purchaseDataRef.current;
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex flex-col items-center gap-4 py-10">
          <CheckCircle2 className="w-16 h-16 text-primary" />
          <h2 className="text-3xl font-black text-foreground">Payment Confirmed</h2>
          <p className="text-2xl font-bold text-primary text-center">{currencySymbol}{pd ? parseFloat(pd.amount.replace(',', '.')).toFixed(2) : '0.00'}</p>
          <p className="text-lg text-muted-foreground text-center">Invoice #{pd?.invoiceNumber || invoiceNumber}</p>
          <p className="text-xs text-muted-foreground truncate max-w-full">Wallet: {walletId}</p>
        </div>
        <Button onClick={resetAll} className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20">New Payment</Button>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // INVOICE STEP (default)
  // ═══════════════════════════════════════════════════════════════
  return (
    <div className="flex flex-col gap-5 px-6 py-4">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0"><CurrencyIcon className="w-7 h-7 text-primary" /></div>
        <div><h2 className="font-display text-xl font-bold text-foreground">Invoice Details</h2><p className="text-muted-foreground text-sm">Enter invoice number and amount</p></div>
      </div>
      {receiptPreview && (
        <div className="flex items-center gap-3 glass-card rounded-xl p-3">
          <img src={receiptPreview} alt="Receipt" className="w-12 h-12 rounded-lg object-cover" />
          <div className="flex-1 min-w-0"><p className="text-xs font-medium text-foreground">Receipt attached</p><p className="text-[10px] text-muted-foreground truncate">{receiptUrl || 'Uploading...'}</p></div>
          {receiptUrl && <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />}
        </div>
      )}
      <div className="glass-card rounded-2xl p-5 space-y-4">
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">
            {receiptType === 'receipt' ? 'Invoice Number' : 'Transaction Description'} <span className="text-destructive">*</span>
          </Label>
          <Input
            placeholder={receiptType === 'receipt' ? 'e.g. 2024-001234' : 'Describe the transaction'}
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            className="h-12 rounded-xl bg-background border-input"
          />
          {receiptType === 'photo' && (
            <p className="text-[11px] text-muted-foreground">No receipt detected — please describe what was purchased.</p>
          )}
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">Amount ({currencySymbol}) <span className="text-destructive">*</span></Label>
          <Input type="text" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))} className="h-12 rounded-xl bg-background border-input" />
          {(() => {
            const maxTx = (window as any).__maxTransactionAmount;
            const parsed = parseFloat(amount.replace(',', '.'));
            if (maxTx && !isNaN(parsed) && parsed > maxTx) {
              return <p className="text-xs text-destructive mt-1">Exceeds max transaction limit ({currencySymbol}{maxTx.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</p>;
            }
            return null;
          })()}
        </div>
      </div>
      {submitError && <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4"><p className="text-sm text-destructive text-center">{submitError}</p></div>}

      {/* ══════ KEY FIX: Snapshot purchase data BEFORE opening scanner ══════ */}
      <Button
        onClick={() => {
          // Snapshot ALL purchase data right now — before scanner captures the closure
          purchaseDataRef.current = {
            unitId: unitId || '',
            invoiceNumber,
            amount,
            currency,
            receiptUrl,
            receiptType,
          };
          setStep("scan");
          setScannerOpen(true);
        }}
        disabled={!invoiceNumber.trim() || !amount.trim() || isSubmitting || (() => {
          const maxTx = (window as any).__maxTransactionAmount;
          const parsed = parseFloat(amount.replace(',', '.'));
          return maxTx && !isNaN(parsed) && parsed > maxTx;
        })()}
        className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 disabled:opacity-50"
      >
        <Camera className="w-5 h-5" />Scan Customer Wallet
      </Button>
      <button onClick={resetAll} className="text-xs text-muted-foreground text-center hover:text-foreground transition-colors">Start Over</button>
    </div>
  );
};

export default CashTab;
