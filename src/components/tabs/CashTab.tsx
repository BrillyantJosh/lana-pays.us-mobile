import { useState, useEffect, useRef } from "react";
import { useTranslation } from 'react-i18next';
import { Camera, PoundSterling, DollarSign, Euro, Loader2, CheckCircle2, UserPlus, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QRScanner } from "@/components/QRScanner";
import { convertWifToIds } from "@/lib/crypto";
import { createAndSignKind0, type Kind0Content } from "@/lib/nostr-sign";
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
  receiptDescription: string | null;
}

type Step = "receipt" | "invoice" | "scan" | "register" | "confirmed";

const UPLOAD_URL = '/api/receipt/upload';

const CashTab = ({ selectedWallet, onClearWallet, unitCurrency, unitId }: CashTabProps) => {
  const { t } = useTranslation();
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
  const [customerPrivateKeyHex, setCustomerPrivateKeyHex] = useState<string | null>(null);
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
      setUploadError(t('cash.fileTooLarge', { size: (file.size / 1024 / 1024).toFixed(1) }));
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
      else setUploadError(t('cash.uploadFailed'));
    } catch {
      setUploadError(t('cash.networkErrorRetry'));
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
        setAnalysisDescription(analysis.description || t('cash.photoCaptured'));
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
      setSubmitError(t('cash.purchaseDataMissing'));
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
        setCustomerPrivateKeyHex(ids.privateKeyHex);
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

      if (!hasNostrKeys) {
        // Try user lookup first, then fall back to registration data
        if (userLookup?.user?.hex_id) {
          resolvedHexId = userLookup.user.hex_id;
          setNostrHexId(userLookup.user.hex_id);
          setNostrNpubId(userLookup.user.npub);
        } else if (regRes?.wallet?.nostr_hex_id) {
          resolvedHexId = regRes.wallet.nostr_hex_id;
          setNostrHexId(regRes.wallet.nostr_hex_id);
        }
      }

      if (balanceRes?.ok) setBalance(balanceRes.json);

      if (regRes.success) {
        if (regRes.registered) {
          // ══════ SUBMIT PURCHASE — using snapshot data ══════
          const parsedAmount = parseFloat(pd.amount.replace(',', '.'));
          if (isNaN(parsedAmount) || parsedAmount <= 0) {
            setSubmitError(t('cash.invalidAmount'));
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
              receipt_description: pd.receiptDescription || undefined,
            }),
          });
          const purchaseData = await res.json();
          setIsSubmitting(false);

          if (!res.ok || !purchaseData.success) {
            setSubmitError(purchaseData.error || t('cash.purchaseFailed'));
            return;
          }

          setStep("confirmed");
        } else if (hasNostrKeys) {
          setStep("register");
        } else {
          setCheckError(t('cash.walletNotRegistered'));
        }
      } else {
        setCheckError(regRes.message || t('cash.walletVerifyFailed'));
      }
    } catch {
      setCheckError(t('cash.invalidScan'));
    } finally {
      setIsChecking(false);
      setIsSubmitting(false);
    }
  };

  const handleRegister = async () => {
    if (!fullName.trim() || !walletId || !nostrHexId || !customerPrivateKeyHex) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // 1. Create and broadcast KIND 0 profile
      console.log('[CashTab] Creating KIND 0 profile for new customer...');
      const kind0Content: Kind0Content = {
        name: fullName.trim(),
        display_name: fullName.trim(),
        about: 'LanaPays.Us customer',
        location: '',
        country: '',
        currency: currency,
        lanoshi2lash: '10000',
        lanaWalletID: walletId,
        whoAreYou: 'Human',
        orgasmic_profile: 'Living life',
        statement_of_responsibility: 'I accept full and unconditional self-responsibility for everything I do or do not do inside the Lana World.',
        email: email.trim() || undefined,
        phone: mobile.trim() || undefined,
        phone_country_code: mobile.trim() ? countryCode : undefined,
      };

      const tags: string[][] = [['lang', 'en']];

      const signedEvent = createAndSignKind0(customerPrivateKeyHex, kind0Content, tags);

      const broadcastRes = await fetch('/api/broadcast-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: signedEvent }),
      });
      const broadcastData = await broadcastRes.json();
      console.log(`[CashTab] KIND 0 broadcast: ${broadcastData.success?.length || 0} relays ok`);

      // 2. Register wallet via Lana Register API
      console.log('[CashTab] Registering wallet via Lana Register API...');
      const regRes = await fetch('/api/register/wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_id: walletId,
          nostr_id_hex: nostrHexId,
        }),
      });
      const regData = await regRes.json();
      console.log(`[CashTab] Wallet registration: ${regData.status} - ${regData.message}`);

      if (!regData.success && regData.status === 'rejected') {
        setSubmitError(regData.message || 'Wallet registration rejected');
        return;
      }

      // 3. Register user in local DB
      try {
        await fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hex_id: nostrHexId,
            npub: nostrNpubId,
            lana_address: walletId,
            display_name: fullName.trim(),
            picture: null,
          }),
        });
      } catch {} // non-critical

      // 4. Proceed to invoice step
      setStep("invoice");
    } catch (err: any) {
      console.error('[CashTab] Registration error:', err);
      setSubmitError(err.message || 'Registration failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  // ─── Balance Card ────────────────
  const BalanceCard = ({ compact }: { compact?: boolean }) => {
    if (!balance) return null;
    return (
      <div className="glass-card rounded-2xl p-4 space-y-2">
        {!compact && <h3 className="font-semibold text-sm text-muted-foreground">{t('cash.customerBalance')}</h3>}
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
            <h2 className="font-display text-xl font-bold text-foreground">{t('cash.title')}</h2>
            <p className="text-muted-foreground text-sm">{t('cash.receiptSubtitle')}</p>
          </div>
        </div>
        <div className="glass-card rounded-2xl p-4">
          <p className="text-sm text-muted-foreground">
            {t('cash.receiptInstruction')}
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
            <p className="text-xs text-primary">{t('cash.analyzingImage')}</p>
          </div>
        )}
        {!isAnalyzing && analysisDescription && receiptPreview && (
          <div className={`rounded-2xl p-3 border ${receiptType === 'receipt' ? 'bg-emerald-50 dark:bg-emerald-500/5 border-emerald-200 dark:border-emerald-500/10' : 'bg-amber-50 dark:bg-amber-500/5 border-amber-200 dark:border-amber-500/10'}`}>
            <p className={`text-xs font-medium ${receiptType === 'receipt' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
              {receiptType === 'receipt' ? t('cash.receiptDetected') : t('cash.photoNotReceipt')}
            </p>
            <p className="text-xs text-muted-foreground mt-1">{analysisDescription}</p>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleReceiptFile(f); }} className="hidden" />
        <div className="flex flex-col gap-3">
          {!receiptPreview ? (
            <Button onClick={() => fileInputRef.current?.click()} disabled={isUploading || isAnalyzing} className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20">
              <Camera className="w-5 h-5" />{t('cash.takePhoto')}
            </Button>
          ) : (
            <>
              {!isAnalyzing && (
                <Button onClick={() => setStep("invoice")} disabled={isUploading} className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20">{t('cash.continueToInvoice')}</Button>
              )}
              <Button onClick={() => fileInputRef.current?.click()} disabled={isUploading || isAnalyzing} variant="outline" className="w-full h-12 rounded-2xl text-sm font-medium gap-2">
                <Camera className="w-4 h-4" />{t('cash.retakePhoto')}
              </Button>
            </>
          )}
          <button onClick={() => setStep("invoice")} className="text-xs text-muted-foreground text-center hover:text-foreground transition-colors mt-1">{t('cash.skipNoReceipt')}</button>
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
            <h2 className="font-display text-xl font-bold text-foreground">{t('cash.title')}</h2>
            <p className="text-muted-foreground text-sm">{t('cash.scanSubtitle')}</p>
          </div>
        </div>
        {isChecking && <div className="flex flex-col items-center gap-3 py-12"><Loader2 className="w-10 h-10 animate-spin text-primary" /><p className="text-sm text-muted-foreground">{t('cash.checkingWallet')}</p></div>}
        {(checkError || submitError) && !isChecking && (
          <div className="space-y-4">
            <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4"><p className="text-sm text-destructive text-center">{checkError || submitError}</p></div>
            <Button onClick={() => { setCheckError(null); setSubmitError(null); setScannerOpen(true); }} className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90"><Camera className="w-5 h-5" />{t('common.scanAgain')}</Button>
          </div>
        )}
        {!isChecking && !checkError && !submitError && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Button onClick={() => setScannerOpen(true)} className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"><Camera className="w-5 h-5" />{t('cash.scanTitle')}</Button>
          </div>
        )}
        <QRScanner isOpen={scannerOpen} onClose={() => setScannerOpen(false)} onScan={handleScan} title={t('cash.scanTitle')} description={t('cash.scanDescription')} />
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
          <div><h2 className="font-display text-xl font-bold text-foreground">{t('cash.registerTitle')}</h2><p className="text-muted-foreground text-sm">{t('cash.registerSubtitle')}</p></div>
        </div>
        <BalanceCard compact />
        {submitError && <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4"><p className="text-sm text-destructive text-center">{submitError}</p></div>}
        <div className="space-y-3">
          <div className="space-y-1.5"><Label className="text-xs font-medium text-muted-foreground">{t('cash.fullName')} <span className="text-destructive">*</span></Label><Input placeholder={t('cash.fullNamePlaceholder')} value={fullName} onChange={(e) => setFullName(e.target.value)} className="h-11 rounded-xl" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-medium text-muted-foreground">{t('profile.email')}</Label><Input type="email" placeholder={t('cash.emailPlaceholder')} value={email} onChange={(e) => setEmail(e.target.value)} className="h-11 rounded-xl" /></div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">{t('cash.mobile')}</Label>
            <div className="flex gap-2">
              <select value={countryCode} onChange={(e) => setCountryCode(e.target.value)} className="h-11 rounded-xl border border-input bg-background px-3 text-sm min-w-[90px]">
                {COUNTRY_CODES.map((c) => <option key={c.code} value={c.code}>{c.country} {c.code}</option>)}
              </select>
              <Input type="tel" placeholder={t('cash.phonePlaceholder')} value={mobile} onChange={(e) => setMobile(e.target.value)} className="h-11 rounded-xl flex-1" />
            </div>
          </div>
        </div>
        <Button onClick={handleRegister} disabled={!fullName.trim() || isSubmitting} className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20">
          <UserPlus className="w-5 h-5" />{isSubmitting ? t('cash.processing') : t('cash.registerAndContinue')}
        </Button>
        <button onClick={resetAll} className="text-sm text-muted-foreground text-center hover:text-foreground transition-colors">{t('common.scanAnother')}</button>
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
          <h2 className="text-3xl font-black text-foreground">{t('cash.confirmedTitle')}</h2>
          <p className="text-2xl font-bold text-primary text-center">{currencySymbol}{pd ? parseFloat(pd.amount.replace(',', '.')).toFixed(2) : '0.00'}</p>
          <p className="text-lg text-muted-foreground text-center">{t('cash.invoiceLabel', { number: pd?.invoiceNumber || invoiceNumber })}</p>
          <p className="text-xs text-muted-foreground truncate max-w-full">{t('cash.walletLabel', { address: walletId })}</p>
        </div>
        <Button onClick={() => window.location.href = '/'} className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20">{t('common.newPayment')}</Button>
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
        <div><h2 className="font-display text-xl font-bold text-foreground">{t('cash.invoiceTitle')}</h2><p className="text-muted-foreground text-sm">{t('cash.invoiceSubtitle')}</p></div>
      </div>
      {receiptPreview && (
        <div className="flex items-center gap-3 glass-card rounded-xl p-3">
          <img src={receiptPreview} alt="Receipt" className="w-12 h-12 rounded-lg object-cover" />
          <div className="flex-1 min-w-0"><p className="text-xs font-medium text-foreground">{t('cash.receiptAttached')}</p><p className="text-[10px] text-muted-foreground truncate">{receiptUrl || t('cash.uploading')}</p></div>
          {receiptUrl && <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />}
        </div>
      )}
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
          {receiptType === 'photo' && (
            <p className="text-[11px] text-muted-foreground">{t('cash.noReceiptDescription')}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">{t('cash.amount', { symbol: currencySymbol })} <span className="text-destructive">*</span></Label>
          <Input type="text" inputMode="decimal" placeholder={t('cash.amountPlaceholder')} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))} className="h-12 rounded-xl bg-background border-input" />
          {(() => {
            const maxTx = (window as any).__maxTransactionAmount;
            const parsed = parseFloat(amount.replace(',', '.'));
            if (maxTx !== null && maxTx !== undefined && maxTx <= 0) {
              return <p className="text-xs text-destructive mt-1">{t('cash.noFunds')}</p>;
            }
            if (maxTx !== null && maxTx !== undefined && !isNaN(parsed) && parsed > maxTx) {
              return <p className="text-xs text-destructive mt-1">{t('cash.exceedsMax', { symbol: currencySymbol, amount: maxTx.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}</p>;
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
            receiptDescription: analysisDescription,
          };
          setStep("scan");
          setScannerOpen(true);
        }}
        disabled={!invoiceNumber.trim() || !amount.trim() || isSubmitting || (() => {
          const maxTx = (window as any).__maxTransactionAmount;
          if (maxTx !== null && maxTx !== undefined && maxTx <= 0) return true;
          const parsed = parseFloat(amount.replace(',', '.'));
          return maxTx !== null && maxTx !== undefined && !isNaN(parsed) && parsed > maxTx;
        })()}
        className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 disabled:opacity-50"
      >
        <Camera className="w-5 h-5" />{t('cash.scanCustomerWallet')}
      </Button>
      <button onClick={resetAll} className="text-xs text-muted-foreground text-center hover:text-foreground transition-colors">{t('common.startOver')}</button>
    </div>
  );
};

export default CashTab;
