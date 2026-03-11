import { useState } from "react";
import { Search, Loader2, AlertCircle, ShieldCheck, ExternalLink, Snowflake, Banknote, Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QRScanner } from "@/components/QRScanner";
import { convertWifToIds } from "@/lib/crypto";
import { useAuth } from "@/contexts/AuthContext";
import lanaIcon from "@/assets/lana-icon.png";

interface BalanceResult {
  address: string;
  lana: number;
  fiatValue: number;
  confirmed: number;
  unconfirmed: number;
  rate: number;
  currency: string;
}

const CURRENCY_LOCALE: Record<string, { locale: string; code: string }> = {
  GBP: { locale: 'en-GB', code: 'GBP' },
  USD: { locale: 'en-US', code: 'USD' },
  EUR: { locale: 'de-DE', code: 'EUR' },
};

const CURRENCY_SYMBOL: Record<string, string> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
};

interface WalletsTabProps {
  onPayWithCash?: (walletId: string) => void;
  onPayWithLana?: (walletAddress: string) => void;
}

const WalletsTab = ({ onPayWithCash, onPayWithLana }: WalletsTabProps) => {
  const { session } = useAuth();
  const userCurrency = session?.currency || 'GBP';
  const currencySymbol = CURRENCY_SYMBOL[userCurrency] || '£';

  const [scannerOpen, setScannerOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRegistered, setIsRegistered] = useState<boolean | null>(null);
  const [isFrozen, setIsFrozen] = useState(false);

  const reset = () => {
    setBalance(null);
    setError(null);
    setIsRegistered(null);
    setIsFrozen(false);
  };

  // Resolve scanned data to wallet address (accepts wallet ID or WIF key)
  const resolveWalletAddress = async (data: string): Promise<string> => {
    const isWalletAddress = data.startsWith('L') && data.length >= 26 && data.length <= 35;
    if (isWalletAddress) return data;
    const ids = await convertWifToIds(data);
    return ids.walletId;
  };

  // Check wallet registration via API
  const checkWalletRegistration = async (walletId: string) => {
    try {
      const res = await fetch('/api/check-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_id: walletId }),
      });
      const json = await res.json();
      if (json.success) {
        return {
          registered: json.registered === true,
          frozen: json.registered && json.wallet?.frozen === true,
        };
      }
    } catch {
      console.warn('Wallet registration check failed');
    }
    return null;
  };

  const handleScan = async (data: string) => {
    const trimmed = data.trim();
    setIsLoading(true);
    setError(null);
    setBalance(null);
    setIsRegistered(null);
    setIsFrozen(false);

    try {
      const walletAddress = await resolveWalletAddress(trimmed);

      const [balanceRes, regResult] = await Promise.all([
        fetch(`/api/balance/${encodeURIComponent(walletAddress)}?currency=${userCurrency}`).then(r => r.json().then(j => ({ ok: r.ok, json: j }))),
        checkWalletRegistration(walletAddress),
      ]);

      if (regResult) {
        setIsRegistered(regResult.registered);
        setIsFrozen(regResult.frozen);
      }

      if (!balanceRes.ok) {
        throw new Error(balanceRes.json.error || 'Failed to fetch balance');
      }

      setBalance(balanceRes.json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid scan. Please scan a valid Lana Wallet ID or WIF Private Key.');
    } finally {
      setIsLoading(false);
    }
  };

  // Frozen wallet banner
  const FrozenBanner = () => (
    <div className="rounded-2xl bg-blue-50 border border-blue-200 p-4 space-y-3 dark:bg-blue-950/30 dark:border-blue-800">
      <div className="flex items-center gap-3">
        <Snowflake className="w-5 h-5 text-blue-500 flex-shrink-0" />
        <p className="text-sm font-medium text-blue-700 dark:text-blue-400">This wallet is frozen</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Spending is disabled for this wallet. Visit the unfreeze portal to resolve this.
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
  );

  return (
    <div className="flex flex-col gap-5 px-6 py-4">

      {/* ─── Loading spinner ─── */}
      {isLoading && (
        <div className="flex flex-col items-center gap-4 py-16">
          <Loader2 className="w-12 h-12 animate-spin text-primary" />
          <p className="text-lg text-muted-foreground">Checking balance...</p>
        </div>
      )}

      {/* ─── Error ─── */}
      {error && !isLoading && (
        <div className="space-y-5 py-4">
          <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-5">
            <p className="text-base text-destructive text-center">{error}</p>
          </div>
          <Button
            onClick={() => { setError(null); setScannerOpen(true); }}
            className="w-full h-16 rounded-2xl text-lg font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
          >
            <Camera className="w-6 h-6" />
            Scan Again
          </Button>
        </div>
      )}

      {/* ─── Balance Result (BIG for mobile) ─── */}
      {balance && !isLoading && (
        <div className="space-y-5">
          {/* Big balance display */}
          <div className="rounded-3xl bg-card border border-border shadow-lg p-6 space-y-4">
            <p className="text-sm font-semibold text-muted-foreground tracking-wide uppercase text-center">Wallet Balance</p>

            {/* LANA amount - very large */}
            <div className="flex items-center justify-center gap-3">
              <img src={lanaIcon} alt="LANA" className="w-10 h-10 object-contain" />
              <span className="text-5xl sm:text-6xl font-extrabold text-foreground leading-none">
                {balance.lana.toLocaleString()}
              </span>
            </div>
            <p className="text-center text-xl font-bold text-muted-foreground">LANA</p>

            {/* Fiat value - large */}
            <div className="text-center pt-2 border-t border-border">
              <span className="text-3xl sm:text-4xl font-bold text-primary">
                {balance.fiatValue.toLocaleString(
                  CURRENCY_LOCALE[balance.currency]?.locale || 'en-GB',
                  { style: 'currency', currency: balance.currency || 'GBP' }
                )}
              </span>
            </div>

            {/* Wallet address */}
            <p className="text-xs text-muted-foreground text-center truncate pt-1">
              {balance.address}
            </p>
          </div>

          {/* Registration status */}
          {isRegistered === true && !isFrozen && (
            <div className="flex items-center gap-3 p-4 rounded-2xl bg-primary/10">
              <ShieldCheck className="w-6 h-6 text-primary flex-shrink-0" />
              <p className="text-base font-semibold text-foreground">Wallet is registered</p>
            </div>
          )}

          {isRegistered === false && (
            <div className="flex items-center gap-3 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20">
              <AlertCircle className="w-6 h-6 text-amber-600 flex-shrink-0" />
              <p className="text-base font-semibold text-amber-700 dark:text-amber-400">Wallet is not registered</p>
            </div>
          )}

          {/* Frozen banner */}
          {isFrozen && <FrozenBanner />}

          {/* Payment buttons */}
          <div className="space-y-3 pt-2">
            {/* Pay with $Lanas — hidden when frozen */}
            {balance.lana > 0 && !isFrozen && (
              <Button
                onClick={() => onPayWithLana?.(balance.address)}
                className="w-full h-16 rounded-2xl text-lg font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
              >
                <img src={lanaIcon} alt="Lana" className="w-7 h-7 object-contain" />
                Pay with $Lanas
              </Button>
            )}
            {/* Pay with Cash — always available */}
            <Button
              onClick={() => onPayWithCash?.(balance.address)}
              variant="outline"
              className="w-full h-16 rounded-2xl text-lg font-semibold gap-3 border-2"
            >
              <Banknote className="w-7 h-7" />
              Pay with {currencySymbol}
            </Button>
          </div>

          {/* Check another */}
          <Button
            onClick={() => { reset(); setScannerOpen(true); }}
            variant="ghost"
            className="w-full h-14 rounded-2xl text-base font-medium text-muted-foreground"
          >
            <Search className="w-5 h-5 mr-2" />
            Check Another Wallet
          </Button>
        </div>
      )}

      {/* ─── Initial state: big scan button ─── */}
      {!balance && !error && !isLoading && (
        <div className="flex flex-col items-center justify-center gap-6 py-16">
          <div className="w-24 h-24 rounded-full bg-primary/10 flex items-center justify-center">
            <Search className="w-12 h-12 text-primary" />
          </div>
          <div className="text-center space-y-2">
            <h2 className="text-2xl font-bold text-foreground">Check Wallet</h2>
            <p className="text-base text-muted-foreground">Scan a Wallet ID or WIF Private Key</p>
          </div>
          <Button
            onClick={() => setScannerOpen(true)}
            className="w-full h-16 rounded-2xl text-lg font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
          >
            <Camera className="w-6 h-6" />
            Scan to Check
          </Button>
        </div>
      )}

      {/* QR Scanner */}
      <QRScanner
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={(data) => handleScan(data)}
        title="Scan Wallet"
        description="Scan a Wallet ID or WIF Private Key"
      />
    </div>
  );
};

export default WalletsTab;
