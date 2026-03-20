import { useState, useEffect } from "react";
import { Camera, PoundSterling, DollarSign, Euro, Loader2, CheckCircle2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QRScanner } from "@/components/QRScanner";
import { convertWifToIds } from "@/lib/crypto";
import { useAuth } from "@/contexts/AuthContext";

const currencyIcons: Record<string, typeof PoundSterling> = {
  GBP: PoundSterling,
  USD: DollarSign,
  EUR: Euro,
};

const CURRENCY_SYMBOL: Record<string, string> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
};

const CURRENCY_LOCALE: Record<string, { locale: string; code: string }> = {
  GBP: { locale: 'en-GB', code: 'GBP' },
  USD: { locale: 'en-US', code: 'USD' },
  EUR: { locale: 'de-DE', code: 'EUR' },
};

const COUNTRY_CODES = [
  { code: "+44", country: "UK" },
  { code: "+386", country: "SI" },
  { code: "+1", country: "US" },
  { code: "+49", country: "DE" },
  { code: "+33", country: "FR" },
  { code: "+39", country: "IT" },
  { code: "+34", country: "ES" },
  { code: "+43", country: "AT" },
  { code: "+385", country: "HR" },
  { code: "+381", country: "RS" },
  { code: "+387", country: "BA" },
  { code: "+382", country: "ME" },
  { code: "+355", country: "AL" },
  { code: "+30", country: "GR" },
  { code: "+36", country: "HU" },
  { code: "+48", country: "PL" },
  { code: "+420", country: "CZ" },
  { code: "+421", country: "SK" },
  { code: "+40", country: "RO" },
  { code: "+359", country: "BG" },
];

interface BalanceResult {
  address: string;
  lana: number;
  fiatValue: number;
  confirmed: number;
  unconfirmed: number;
  rate: number;
  currency: string;
}

interface CashTabProps {
  selectedWallet?: string | null;
  onClearWallet?: () => void;
  unitCurrency?: string;
}

type Step = "scan" | "register" | "invoice" | "confirmed";

const CashTab = ({ selectedWallet, onClearWallet, unitCurrency }: CashTabProps) => {
  const { session } = useAuth();
  const currency = unitCurrency || session?.currency || 'GBP';
  const CurrencyIcon = currencyIcons[currency] || PoundSterling;
  const currencySymbol = CURRENCY_SYMBOL[currency] || '£';

  const [step, setStep] = useState<Step>("scan");

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

  // Cross-tab entry: wallet already verified from WalletsTab
  useEffect(() => {
    if (selectedWallet) {
      setWalletId(selectedWallet);
      setCheckError(null);
      fetchBalance(selectedWallet);
      setStep("invoice");
    }
  }, [selectedWallet]);

  // Auto-open scanner on scan step
  useEffect(() => {
    if (step === "scan" && !walletId && !checkError && !isChecking) {
      setScannerOpen(true);
    }
  }, [step]);

  const fetchBalance = async (address: string) => {
    try {
      const res = await fetch(`/api/balance/${encodeURIComponent(address)}?currency=${currency}`);
      const json = await res.json();
      if (res.ok) setBalance(json);
    } catch {
      // Balance fetch failure is non-critical for cash payments
    }
  };

  const resetAll = () => {
    setStep("scan");
    setWalletId(null);
    setNostrHexId(null);
    setNostrNpubId(null);
    setBalance(null);
    setCheckError(null);
    setFullName("");
    setEmail("");
    setCountryCode("+386");
    setMobile("");
    setInvoiceNumber("");
    setAmount("");
    onClearWallet?.();
    setScannerOpen(true);
  };

  // Main scan handler — accepts wallet address or WIF key
  const handleScan = async (data: string) => {
    const trimmed = data.trim();

    setIsChecking(true);
    setCheckError(null);
    setBalance(null);
    setNostrHexId(null);
    setNostrNpubId(null);

    try {
      let resolvedWalletId: string;
      let hasNostrKeys = false;

      const isWalletAddress = trimmed.startsWith('L') && trimmed.length >= 26 && trimmed.length <= 35;

      if (isWalletAddress) {
        resolvedWalletId = trimmed;
      } else {
        // Derive wallet from WIF key
        const ids = await convertWifToIds(trimmed);
        resolvedWalletId = ids.walletId;
        setNostrHexId(ids.nostrHexId);
        setNostrNpubId(ids.nostrNpubId);
        hasNostrKeys = true;
      }

      setWalletId(resolvedWalletId);

      // Check registration + balance in parallel
      const [regRes, balanceRes] = await Promise.all([
        fetch('/api/check-wallet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_id: resolvedWalletId }),
        }).then(r => r.json()),
        fetch(`/api/balance/${encodeURIComponent(resolvedWalletId)}?currency=${currency}`)
          .then(r => r.json().then(j => ({ ok: r.ok, json: j })))
          .catch(() => null),
      ]);

      // Store balance
      if (balanceRes?.ok) {
        setBalance(balanceRes.json);
      }

      // Check registration result
      if (regRes.success) {
        if (regRes.registered) {
          setStep("invoice");
        } else if (hasNostrKeys) {
          // Not registered, but we have keys from WIF → show registration form
          setStep("register");
        } else {
          // Scanned wallet address but not registered — can't register without WIF
          setCheckError('This wallet is not registered. Scan a WIF Private Key instead to register and pay.');
        }
      } else {
        setCheckError(regRes.message || 'Failed to verify wallet.');
      }
    } catch {
      setCheckError('Invalid scan. Please scan a valid Lana Wallet ID or WIF Private Key.');
    } finally {
      setIsChecking(false);
    }
  };

  const handleRegister = () => {
    if (!fullName.trim() || !walletId) return;
    // Registration data is captured — proceed to invoice
    // Actual wallet registration happens through the Lana Register API separately
    setStep("invoice");
  };

  const handleConfirm = async () => {
    if (!invoiceNumber.trim() || !amount.trim() || !walletId) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch('/api/brain/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unit_id: (window as any).__selectedUnitId || '',
          payment_type: 'cash',
          customer_hex: nostrHexId || '',
          customer_wallet: walletId,
          amount: parseFloat(amount.replace(',', '.')),
          currency,
          invoice_number: invoiceNumber.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setSubmitError(data.error || 'Purchase failed. Please try again.');
        setIsSubmitting(false);
        return;
      }

      setStep("confirmed");
    } catch (err: any) {
      setSubmitError('Network error. Please check connection and try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // ─── Balance Card Component ────────────────
  const BalanceCard = ({ compact }: { compact?: boolean }) => {
    if (!balance) return null;
    return (
      <div className="glass-card rounded-2xl p-4 space-y-2">
        {!compact && <h3 className="font-semibold text-sm text-muted-foreground">Customer Balance</h3>}
        <div className="flex items-baseline gap-2">
          <span className={`${compact ? 'text-xl' : 'text-2xl'} font-bold text-foreground`}>
            {balance.lana.toLocaleString()}
          </span>
          <span className="text-sm text-muted-foreground">LANA</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className={`${compact ? 'text-base' : 'text-lg'} font-semibold text-primary`}>
            {balance.fiatValue.toLocaleString(
              CURRENCY_LOCALE[balance.currency]?.locale || 'en-GB',
              { style: 'currency', currency: balance.currency || 'GBP' }
            )}
          </span>
        </div>
        <p className="text-xs text-muted-foreground truncate">{balance.address}</p>
      </div>
    );
  };

  // ─── SCAN STEP ─────────────────────────────
  if (step === "scan") {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <CurrencyIcon className="w-7 h-7 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">Cash Payment</h2>
            <p className="text-muted-foreground text-sm">Scan customer wallet or WIF key</p>
          </div>
        </div>

        {/* Loading */}
        {isChecking && (
          <div className="flex flex-col items-center gap-3 py-12">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Checking wallet...</p>
          </div>
        )}

        {/* Error */}
        {checkError && !isChecking && (
          <div className="space-y-4">
            <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4">
              <p className="text-sm text-destructive text-center">{checkError}</p>
            </div>
            <Button
              onClick={() => { setCheckError(null); setScannerOpen(true); }}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Camera className="w-5 h-5" />
              Scan Again
            </Button>
          </div>
        )}

        {/* Idle — scan button */}
        {!isChecking && !checkError && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Button
              onClick={() => setScannerOpen(true)}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
            >
              <Camera className="w-5 h-5" />
              Scan Customer
            </Button>
          </div>
        )}

        <QRScanner
          isOpen={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onScan={handleScan}
          title="Scan Customer"
          description="Scan a wallet address or WIF private key"
        />
      </div>
    );
  }

  // ─── REGISTER STEP ─────────────────────────
  if (step === "register") {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <UserPlus className="w-7 h-7 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">Register Wallet</h2>
            <p className="text-muted-foreground text-sm">This wallet needs to be registered first</p>
          </div>
        </div>

        {/* Balance card */}
        <BalanceCard compact />

        {/* Registration form */}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">
              Full Name <span className="text-destructive">*</span>
            </Label>
            <Input
              placeholder="First and last name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="h-11 rounded-xl"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Email</Label>
            <Input
              type="email"
              placeholder="email@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-11 rounded-xl"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Mobile</Label>
            <div className="flex gap-2">
              <select
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                className="h-11 rounded-xl border border-input bg-background px-3 text-sm min-w-[90px]"
              >
                {COUNTRY_CODES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.country} {c.code}
                  </option>
                ))}
              </select>
              <Input
                type="tel"
                placeholder="Phone number"
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                className="h-11 rounded-xl flex-1"
              />
            </div>
          </div>
        </div>

        <Button
          onClick={handleRegister}
          disabled={!fullName.trim()}
          className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
        >
          <UserPlus className="w-5 h-5" />
          Register & Continue
        </Button>

        <button
          onClick={resetAll}
          className="text-sm text-muted-foreground text-center hover:text-foreground transition-colors"
        >
          Scan Another
        </button>
      </div>
    );
  }

  // ─── CONFIRMED STEP ────────────────────────
  if (step === "confirmed") {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex flex-col items-center gap-4 py-10">
          <CheckCircle2 className="w-16 h-16 text-primary" />
          <h2 className="text-3xl font-black text-foreground">Payment Confirmed</h2>
          <p className="text-2xl font-bold text-primary text-center">
            {currencySymbol}{parseFloat(amount.replace(',', '.')).toFixed(2)}
          </p>
          <p className="text-lg text-muted-foreground text-center">
            Invoice #{invoiceNumber}
          </p>
          <p className="text-xs text-muted-foreground truncate max-w-full">
            Wallet: {walletId}
          </p>
        </div>

        <Button
          onClick={resetAll}
          className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
        >
          New Payment
        </Button>
      </div>
    );
  }

  // ─── INVOICE STEP ──────────────────────────
  return (
    <div className="flex flex-col gap-5 px-6 py-4">
      {/* Header with wallet info */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <CurrencyIcon className="w-7 h-7 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">Cash Payment</h2>
            <p className="text-muted-foreground text-xs font-mono truncate max-w-[180px]">
              {walletId}
            </p>
          </div>
        </div>
        <button
          onClick={resetAll}
          className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
        >
          Change
        </button>
      </div>

      {/* Balance card */}
      <BalanceCard />

      {/* Invoice form */}
      <div className="glass-card rounded-2xl p-5 space-y-4">
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">
            Invoice Number <span className="text-destructive">*</span>
          </Label>
          <Input
            placeholder="e.g. 2024-001234"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            className="h-12 rounded-xl bg-background border-input"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">
            Amount ({currencySymbol}) <span className="text-destructive">*</span>
          </Label>
          <Input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
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
            if (maxTx && !isNaN(parsed) && parsed > maxTx) {
              return (
                <p className="text-xs text-destructive mt-1">
                  Exceeds max transaction limit ({currencySymbol}{maxTx.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
                </p>
              );
            }
            return null;
          })()}
        </div>
      </div>

      {/* Error feedback */}
      {submitError && (
        <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4">
          <p className="text-sm text-destructive text-center">{submitError}</p>
        </div>
      )}

      {/* Confirm button */}
      <Button
        onClick={handleConfirm}
        disabled={!invoiceNumber.trim() || !amount.trim() || isSubmitting || (() => {
          const maxTx = (window as any).__maxTransactionAmount;
          const parsed = parseFloat(amount.replace(',', '.'));
          return maxTx && !isNaN(parsed) && parsed > maxTx;
        })()}
        className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 disabled:opacity-50"
      >
        {isSubmitting ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            Processing...
          </>
        ) : (
          'Confirm Payment'
        )}
      </Button>
    </div>
  );
};

export default CashTab;
