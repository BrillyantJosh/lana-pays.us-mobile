import { useState, useEffect } from "react";
import { ArrowLeft, Loader2, CheckCircle2, AlertCircle, Snowflake, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QRScanner } from "@/components/QRScanner";
import { convertWifToIds } from "@/lib/crypto";
import { useAuth } from "@/contexts/AuthContext";
import lanaIcon from "@/assets/lana-icon.png";

const CURRENCY_SYMBOL: Record<string, string> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
};

interface LanaTabProps {
  paymentRequest?: { walletAddress: string; invoiceNumber?: string; amount?: number } | null;
  onClearRequest?: () => void;
}

type Step = "entry" | "display" | "processing" | "paid";

const LanaTab = ({ paymentRequest, onClearRequest }: LanaTabProps) => {
  const { session } = useAuth();
  const currency = session?.currency || 'GBP';
  const currencySymbol = CURRENCY_SYMBOL[currency] || '£';

  const [step, setStep] = useState<Step>("entry");
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
        setRateError('Exchange rate not available. Please try again later.');
        setIsLoadingRate(false);
        return;
      }
      setExchangeRate(rate);
      const lana = Math.round(fiatAmount / rate);
      setLanaAmount(lana);
      setStep("display");
      setWifScannerOpen(true);
    } catch {
      setRateError('Failed to fetch exchange rate. Please try again.');
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
      setScanError('This looks like a Wallet Address, not a Private Key. The customer needs to show their WIF Private Key.');
      return;
    }

    // Reject Nostr keys
    if (trimmed.startsWith('npub') || trimmed.startsWith('nsec')) {
      setScanError('This is a Nostr key, not a LanaCoin WIF Private Key.');
      return;
    }

    setScanError(null);
    setIsCheckingBalance(true);
    setIsFrozen(false);

    try {
      const ids = await convertWifToIds(trimmed);
      setCustomerWalletId(ids.walletId);

      // Check if wallet is frozen
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
        setScanError(`Insufficient balance. Wallet has ${walletLana.toLocaleString()} LANA but ${lanaAmount.toLocaleString()} LANA is required.`);
        setIsCheckingBalance(false);
        return;
      }

      // Sufficient balance — proceed to processing
      setIsCheckingBalance(false);
      setStep("processing");
      setPurchaseError(null);

      try {
        const purchaseRes = await fetch('/api/brain/purchase', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            unit_id: (window as any).__selectedUnitId || '',
            payment_type: 'lana',
            customer_hex: ids.nostrHexId,
            customer_wallet: ids.walletId,
            amount: parseFloat(amount.replace(',', '.')),
            currency,
            invoice_number: invoiceNumber.trim(),
          }),
        });

        const brainData = await purchaseRes.json();

        if (!purchaseRes.ok || !brainData.success) {
          setPurchaseError(brainData.error || 'Purchase processing failed');
          setStep("display");
          return;
        }

        setTxHash(brainData.data.transaction_id);
        setStep("paid");
      } catch (err: any) {
        setPurchaseError('Network error. Please check connection and try again.');
        setStep("display");
      }

    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Invalid WIF Private Key.');
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

  // ─── STEP: Entry ─────────────────────────────
  if (step === "entry") {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <img src={lanaIcon} alt="Lana" className="w-7 h-7 object-contain" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">$Lana Payment</h2>
            <p className="text-muted-foreground text-sm">Enter invoice details</p>
          </div>
        </div>

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

        {rateError && (
          <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4">
            <p className="text-sm text-destructive text-center">{rateError}</p>
          </div>
        )}

        <Button
          onClick={handleContinue}
          disabled={!invoiceNumber.trim() || !amount.trim() || parseFloat(amount.replace(',', '.')) <= 0 || isLoadingRate || (() => {
            const maxTx = (window as any).__maxTransactionAmount;
            const parsed = parseFloat(amount.replace(',', '.'));
            return maxTx && !isNaN(parsed) && parsed > maxTx;
          })()}
          className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 disabled:opacity-50"
        >
          {isLoadingRate ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Loading rate...
            </>
          ) : (
            'Continue to Payment'
          )}
        </Button>
      </div>
    );
  }

  // ─── STEP: Display (customer-facing) ─────────
  if (step === "display") {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        {/* Back to entry */}
        <button
          onClick={() => { setStep("entry"); setScanError(null); setIsCheckingBalance(false); }}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors self-start"
        >
          <ArrowLeft className="w-5 h-5" />
          <span className="text-sm font-medium">Back</span>
        </button>

        {/* Payment amounts — designed for customer to read */}
        <div className="flex flex-col items-center gap-2 py-4">
          <p className="text-sm text-muted-foreground">Invoice #{invoiceNumber}</p>

          <p className="text-2xl font-semibold text-foreground">
            {currencySymbol}{parseFloat(amount.replace(',', '.')).toFixed(2)}
          </p>

          <div className="flex items-center gap-3 py-3">
            <img src={lanaIcon} alt="Lana" className="w-10 h-10 object-contain" />
            <span className="text-5xl font-black text-primary tracking-tight">
              {lanaAmount.toLocaleString()}
            </span>
            <span className="text-2xl font-bold text-primary/70">LANA</span>
          </div>

          <p className="text-xs text-muted-foreground">
            1 LANA = {currencySymbol}{exchangeRate.toFixed(6)}
          </p>
        </div>

        {/* Balance check loading */}
        {isCheckingBalance && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Checking wallet balance...</p>
          </div>
        )}

        {/* Frozen wallet */}
        {isFrozen && !isCheckingBalance && (
          <div className="space-y-4">
            <div className="rounded-2xl bg-blue-50 border border-blue-200 p-4 space-y-3 dark:bg-blue-950/30 dark:border-blue-800">
              <div className="flex items-center gap-3">
                <Snowflake className="w-5 h-5 text-blue-500 flex-shrink-0" />
                <p className="text-sm font-medium text-blue-700 dark:text-blue-400">This wallet is frozen</p>
              </div>
              <p className="text-xs text-muted-foreground">
                Frozen wallets cannot be used for $Lana payments. Visit the unfreeze portal to resolve this.
              </p>
              <a
                href="https://unfreeze.lanapays.us"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full h-11 rounded-xl bg-blue-100 text-blue-700 text-sm font-semibold hover:bg-blue-200 transition-colors dark:bg-blue-900/40 dark:text-blue-400 dark:hover:bg-blue-900/60"
              >
                <ExternalLink className="w-4 h-4" />
                Go to Unfreeze Portal
              </a>
            </div>
            <Button
              onClick={() => { setIsFrozen(false); setWifScannerOpen(true); }}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Scan Another WIF
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
              Try Again
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
              Scan Again
            </Button>
          </div>
        )}

        {/* Prompt to scan — when idle */}
        {!scanError && !purchaseError && !isCheckingBalance && !isFrozen && (
          <div className="flex flex-col items-center gap-4">
            <p className="text-sm text-muted-foreground text-center">
              Ask the customer to show their WIF Private Key QR code
            </p>
            <Button
              onClick={() => setWifScannerOpen(true)}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
            >
              <img src={lanaIcon} alt="Lana" className="w-5 h-5 object-contain" />
              Scan Customer WIF
            </Button>
          </div>
        )}

        <QRScanner
          isOpen={wifScannerOpen}
          onClose={() => setWifScannerOpen(false)}
          onScan={handleWifScan}
          title="Scan WIF Key"
          description="Scan the customer's Lana WIF Private Key"
        >
          <div className="flex items-center justify-between rounded-xl bg-secondary p-3">
            <span className="text-sm text-muted-foreground">
              {currencySymbol}{parseFloat(amount.replace(',', '.')).toFixed(2)}
            </span>
            <div className="flex items-center gap-1.5">
              <img src={lanaIcon} alt="Lana" className="w-5 h-5 object-contain" />
              <span className="text-lg font-bold text-primary">
                {lanaAmount.toLocaleString()} LANA
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
        <h2 className="text-xl font-bold text-foreground">Processing Payment</h2>
        <p className="text-sm text-muted-foreground text-center">
          Sending {lanaAmount.toLocaleString()} LANA...
        </p>
      </div>
    );
  }

  // ─── STEP: Paid ──────────────────────────────
  return (
    <div className="flex flex-col gap-5 px-6 py-4">
      <div className="flex flex-col items-center gap-3 py-8">
        <CheckCircle2 className="w-14 h-14 text-primary" />
        <h2 className="text-2xl font-bold text-foreground">Paid</h2>
        <p className="text-lg text-muted-foreground">
          Invoice #{invoiceNumber}
        </p>
      </div>

      <div className="glass-card rounded-2xl p-5 space-y-3">
        <div className="flex justify-between items-baseline">
          <span className="text-sm text-muted-foreground">Amount</span>
          <span className="text-base font-semibold text-foreground">
            {currencySymbol}{parseFloat(amount.replace(',', '.')).toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between items-baseline">
          <span className="text-sm text-muted-foreground">LANA</span>
          <span className="text-base font-bold text-primary">
            {lanaAmount.toLocaleString()} LANA
          </span>
        </div>
        <div className="flex justify-between items-baseline">
          <span className="text-sm text-muted-foreground">Rate</span>
          <span className="text-sm text-foreground">
            1 LANA = {currencySymbol}{exchangeRate.toFixed(6)}
          </span>
        </div>
        <div className="pt-2 border-t border-border space-y-1">
          <p className="text-xs text-muted-foreground">Customer Wallet</p>
          <p className="text-xs font-mono text-foreground break-all">{customerWalletId}</p>
        </div>
        {txHash && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Transaction ID</p>
            <p className="text-xs font-mono text-foreground break-all">{txHash}</p>
          </div>
        )}
      </div>

      <Button
        onClick={resetAll}
        className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
      >
        New Payment
      </Button>
    </div>
  );
};

export default LanaTab;
