import { useState, useEffect } from "react";
import { Camera, PoundSterling, DollarSign, Euro, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QRScanner } from "@/components/QRScanner";
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

interface CashTabProps {
  selectedWallet?: string | null;
  onClearWallet?: () => void;
}

const CashTab = ({ selectedWallet, onClearWallet }: CashTabProps) => {
  const { session } = useAuth();
  const currency = session?.currency || 'GBP';
  const CurrencyIcon = currencyIcons[currency] || PoundSterling;
  const currencySymbol = CURRENCY_SYMBOL[currency] || '£';

  // Step state
  const [step, setStep] = useState<1 | 2>(1);
  const [walletId, setWalletId] = useState<string | null>(null);

  // Step 1 state
  const [scannerOpen, setScannerOpen] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  // Step 2 state
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // Cross-tab entry: if selectedWallet is set, skip to step 2
  useEffect(() => {
    if (selectedWallet) {
      setWalletId(selectedWallet);
      setStep(2);
      setCheckError(null);
    }
  }, [selectedWallet]);

  // Auto-open scanner on step 1 entry (only when no wallet set)
  useEffect(() => {
    if (step === 1 && !walletId && !checkError && !isChecking) {
      setScannerOpen(true);
    }
  }, [step]);

  const resetToStep1 = () => {
    setStep(1);
    setWalletId(null);
    setCheckError(null);
    setInvoiceNumber("");
    setAmount("");
    setSubmitted(false);
    onClearWallet?.();
    setScannerOpen(true);
  };

  // Validate and check wallet registration
  const handleWalletScan = async (data: string) => {
    const trimmed = data.trim();

    if (!trimmed.startsWith('L') || trimmed.length < 26 || trimmed.length > 35) {
      setCheckError('Invalid Wallet ID. A valid Lana wallet address starts with "L" and is 26-35 characters long.');
      return;
    }

    setIsChecking(true);
    setCheckError(null);

    try {
      const res = await fetch('/api/check-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_id: trimmed }),
      });
      const json = await res.json();

      if (json.success) {
        if (!json.registered) {
          setCheckError('This wallet is not registered. Only registered wallets can be used for cash payments.');
          return;
        }
        // Registered — advance to step 2 (frozen doesn't matter for cash/fiat)
        setWalletId(trimmed);
        setStep(2);
      } else {
        setCheckError(json.message || 'Failed to verify wallet registration.');
      }
    } catch {
      setCheckError('Failed to check wallet registration. Please try again.');
    } finally {
      setIsChecking(false);
    }
  };

  const canConfirm = invoiceNumber.trim() && amount.trim();

  const handleConfirm = () => {
    if (!canConfirm || !walletId) return;

    console.log('Cash payment (mock):', {
      walletId,
      invoiceNumber: invoiceNumber.trim(),
      amount: parseFloat(amount),
      currency,
    });

    setSubmitted(true);
  };

  // ─── STEP 1: Scan Wallet ────────────────────
  if (step === 1) {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <CurrencyIcon className="w-7 h-7 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">Cash Payment</h2>
            <p className="text-muted-foreground text-sm">Scan customer wallet to begin</p>
          </div>
        </div>

        {/* Loading */}
        {isChecking && (
          <div className="flex flex-col items-center gap-3 py-12">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Checking wallet registration...</p>
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

        {/* Idle — show scan button */}
        {!isChecking && !checkError && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Button
              onClick={() => setScannerOpen(true)}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
            >
              <Camera className="w-5 h-5" />
              Scan Wallet ID
            </Button>
          </div>
        )}

        <QRScanner
          isOpen={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onScan={handleWalletScan}
          title="Scan Wallet ID"
          description="Scan a customer's Lana Wallet ID for cash payment"
        />
      </div>
    );
  }

  // ─── STEP 2: Submitted ──────────────────────
  if (submitted) {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex flex-col items-center gap-4 py-10">
          <CheckCircle2 className="w-16 h-16 text-primary" />
          <h2 className="text-3xl font-black text-foreground">Payment Confirmed</h2>
          <p className="text-2xl font-bold text-primary text-center">
            {currencySymbol}{parseFloat(amount).toFixed(2)}
          </p>
          <p className="text-lg text-muted-foreground text-center">
            Invoice #{invoiceNumber}
          </p>
          <p className="text-xs text-muted-foreground truncate max-w-full">
            Wallet: {walletId}
          </p>
        </div>

        <Button
          onClick={resetToStep1}
          className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
        >
          New Payment
        </Button>
      </div>
    );
  }

  // ─── STEP 2: Invoice Details ─────────────────
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
          onClick={resetToStep1}
          className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
        >
          Change
        </button>
      </div>

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
            type="number"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-12 rounded-xl bg-background border-input"
          />
        </div>
      </div>

      {/* Confirm button */}
      <Button
        onClick={handleConfirm}
        disabled={!canConfirm}
        className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 disabled:opacity-50"
      >
        Confirm Payment
      </Button>
    </div>
  );
};

export default CashTab;
