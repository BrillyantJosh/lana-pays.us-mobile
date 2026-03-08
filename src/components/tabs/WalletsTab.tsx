import { useState } from "react";
import { Search, UserPlus, Loader2, CheckCircle2, X, Banknote, ArrowLeft, AlertCircle, ShieldCheck, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

interface ScannedWallet {
  walletId: string;
  nostrHexId: string;
  nostrNpubId: string;
}

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
}

type View = "home" | "check" | "register";

const WalletsTab = ({ onPayWithCash }: WalletsTabProps) => {
  const { session } = useAuth();
  const userCurrency = session?.currency || 'GBP';
  const currencySymbol = CURRENCY_SYMBOL[userCurrency] || '£';

  const [view, setView] = useState<View>("home");

  // Balance check state
  const [walletScannerOpen, setWalletScannerOpen] = useState(false);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  // Check flow registration state
  const [checkWalletRegistered, setCheckWalletRegistered] = useState<boolean | null>(null);
  const [checkWalletFrozen, setCheckWalletFrozen] = useState(false);
  const [checkingCheckWallet, setCheckingCheckWallet] = useState(false);

  // Registration state
  const [regScannerOpen, setRegScannerOpen] = useState(false);
  const [scannedWallet, setScannedWallet] = useState<ScannedWallet | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [regSubmitted, setRegSubmitted] = useState(false);
  const [walletRegistered, setWalletRegistered] = useState<boolean | null>(null);
  const [walletFrozen, setWalletFrozen] = useState(false);
  const [checkingRegistration, setCheckingRegistration] = useState(false);

  // Form fields
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [countryCode, setCountryCode] = useState("+44");
  const [mobile, setMobile] = useState("");

  const goHome = () => {
    setView("home");
    setBalance(null);
    setBalanceError(null);
    setCheckWalletRegistered(null);
    setCheckWalletFrozen(false);
    setCheckingCheckWallet(false);
    setScannedWallet(null);
    setScanError(null);
    setRegSubmitted(false);
    setWalletRegistered(null);
    setWalletFrozen(false);
    setCheckingRegistration(false);
    setFullName("");
    setEmail("");
    setCountryCode("+44");
    setMobile("");
  };

  // Helper: check wallet registration via API
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

  // Validate and fetch balance for a wallet address
  const handleWalletScan = async (data: string) => {
    const trimmed = data.trim();

    // Validate: must start with 'L' and be 26-35 chars
    if (!trimmed.startsWith('L') || trimmed.length < 26 || trimmed.length > 35) {
      setBalanceError('Invalid Wallet ID. A valid Lana wallet address starts with "L" and is 26-35 characters long.');
      return;
    }

    setIsLoadingBalance(true);
    setBalanceError(null);
    setBalance(null);
    setCheckWalletRegistered(null);
    setCheckWalletFrozen(false);

    try {
      // Check registration in parallel with balance
      setCheckingCheckWallet(true);
      const [balanceRes, regResult] = await Promise.all([
        fetch(`/api/balance/${encodeURIComponent(trimmed)}?currency=${userCurrency}`).then(r => r.json().then(j => ({ ok: r.ok, json: j }))),
        checkWalletRegistration(trimmed),
      ]);
      setCheckingCheckWallet(false);

      if (regResult) {
        setCheckWalletRegistered(regResult.registered);
        setCheckWalletFrozen(regResult.frozen);
      }

      if (!balanceRes.ok) {
        throw new Error(balanceRes.json.error || 'Failed to fetch balance');
      }

      setBalance(balanceRes.json);
    } catch (err) {
      setBalanceError(err instanceof Error ? err.message : 'Failed to check balance');
    } finally {
      setIsLoadingBalance(false);
      setCheckingCheckWallet(false);
    }
  };

  // Validate and process WIF key scan
  const handleWifScan = async (data: string) => {
    const trimmed = data.trim();

    // Basic WIF validation: LanaCoin WIF keys start with '6' or '7' (0xb0 prefix)
    // and are typically 51-52 characters (base58)
    if (trimmed.startsWith('L') && trimmed.length >= 26 && trimmed.length <= 35) {
      setScanError('This looks like a Wallet Address, not a Private Key. Please scan the WIF Private Key instead.');
      return;
    }

    if (trimmed.startsWith('npub') || trimmed.startsWith('nsec')) {
      setScanError('This is a Nostr key, not a LanaCoin WIF Private Key.');
      return;
    }

    setIsVerifying(true);
    setScanError(null);
    setWalletRegistered(null);
    setWalletFrozen(false);

    try {
      const ids = await convertWifToIds(trimmed);

      // Pre-check: if already registered, redirect to Check flow
      setCheckingRegistration(true);
      const regResult = await checkWalletRegistration(ids.walletId);
      setCheckingRegistration(false);

      if (regResult?.registered) {
        // Already registered — redirect to Check flow with this wallet
        setIsVerifying(false);
        setView("check");
        handleWalletScan(ids.walletId);
        return;
      }

      setScannedWallet({
        walletId: ids.walletId,
        nostrHexId: ids.nostrHexId,
        nostrNpubId: ids.nostrNpubId,
      });

      if (regResult) {
        setWalletRegistered(regResult.registered);
        setWalletFrozen(regResult.frozen);
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Invalid WIF Private Key. Make sure you are scanning a valid LanaCoin private key.');
    } finally {
      setIsVerifying(false);
      setCheckingRegistration(false);
    }
  };

  const handleRegSubmit = () => {
    if (!fullName.trim() || !scannedWallet) return;

    console.log('Registration (mock):', {
      walletId: scannedWallet.walletId,
      nostrHexId: scannedWallet.nostrHexId,
      fullName: fullName.trim(),
      email: email.trim() || null,
      mobile: mobile.trim() ? `${countryCode}${mobile.trim()}` : null,
    });

    setRegSubmitted(true);
  };

  // Frozen wallet banner component
  const FrozenBanner = () => (
    <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4 space-y-3">
      <div className="flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0" />
        <p className="text-sm font-medium text-destructive">This wallet is frozen</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Spending is disabled for this wallet. Visit the unfreeze portal to resolve this.
      </p>
      <a
        href="https://unfreeze.lanapays.us"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 w-full h-11 rounded-xl bg-destructive/10 text-destructive text-sm font-semibold hover:bg-destructive/20 transition-colors"
      >
        <ExternalLink className="w-4 h-4" />
        Go to Unfreeze Portal
      </a>
    </div>
  );

  // ─── HOME VIEW: Two big buttons ───────────────────
  if (view === "home") {
    return (
      <div className="flex flex-col gap-5 px-6 py-6">
        <button
          onClick={() => { setView("check"); setWalletScannerOpen(true); }}
          className="flex items-center gap-5 p-6 rounded-2xl bg-card border border-border shadow-sm active:scale-[0.98] transition-transform"
        >
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Search className="w-8 h-8 text-primary" />
          </div>
          <div className="text-left">
            <h2 className="text-xl font-bold text-foreground">Check</h2>
            <p className="text-sm text-muted-foreground">Scan wallet to check balance</p>
          </div>
        </button>

        <button
          onClick={() => { setView("register"); setRegScannerOpen(true); }}
          className="flex items-center gap-5 p-6 rounded-2xl bg-card border border-border shadow-sm active:scale-[0.98] transition-transform"
        >
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <UserPlus className="w-8 h-8 text-primary" />
          </div>
          <div className="text-left">
            <h2 className="text-xl font-bold text-foreground">Register</h2>
            <p className="text-sm text-muted-foreground">Scan WIF key to register wallet</p>
          </div>
        </button>

        {/* QR Scanners */}
        <QRScanner
          isOpen={walletScannerOpen}
          onClose={() => { setWalletScannerOpen(false); if (!balance) setView("home"); }}
          onScan={(data) => handleWalletScan(data)}
          title="Scan Wallet ID"
          description="Scan a customer's Lana Wallet ID QR code"
        />

        <QRScanner
          isOpen={regScannerOpen}
          onClose={() => { setRegScannerOpen(false); if (!scannedWallet) setView("home"); }}
          onScan={(data) => handleWifScan(data)}
          title="Scan WIF Key"
          description="Scan a Lana WIF Private Key to register"
        />
      </div>
    );
  }

  // ─── CHECK VIEW: Balance result + payment buttons ──
  if (view === "check") {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        {/* Back button */}
        <button
          onClick={goHome}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors self-start"
        >
          <ArrowLeft className="w-5 h-5" />
          <span className="text-sm font-medium">Back</span>
        </button>

        {/* Loading */}
        {isLoadingBalance && (
          <div className="flex flex-col items-center gap-3 py-12">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Checking balance...</p>
          </div>
        )}

        {/* Error */}
        {balanceError && (
          <div className="space-y-4">
            <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4">
              <p className="text-sm text-destructive text-center">{balanceError}</p>
            </div>
            <Button
              onClick={() => setWalletScannerOpen(true)}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Search className="w-5 h-5" />
              Scan Again
            </Button>
          </div>
        )}

        {/* Balance Result + Payment Buttons */}
        {balance && (
          <div className="space-y-5">
            {/* Balance card */}
            <div className="glass-card rounded-2xl p-5 space-y-3">
              <h3 className="font-semibold text-sm text-muted-foreground">Customer Balance</h3>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-foreground">{balance.lana.toLocaleString()}</span>
                <span className="text-lg text-muted-foreground">LANA</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-semibold text-primary">
                  {balance.fiatValue.toLocaleString(
                    CURRENCY_LOCALE[balance.currency]?.locale || 'en-GB',
                    { style: 'currency', currency: balance.currency || 'GBP' }
                  )}
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate">
                {balance.address}
              </p>
            </div>

            {/* Registration status */}
            {checkingCheckWallet && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-secondary">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Checking registration...</p>
              </div>
            )}

            {checkWalletRegistered === true && !checkWalletFrozen && (
              <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/10">
                <ShieldCheck className="w-5 h-5 text-primary flex-shrink-0" />
                <p className="text-sm font-medium text-foreground">Wallet is registered</p>
              </div>
            )}

            {checkWalletRegistered === false && (
              <div className="flex items-center gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
                <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Wallet is not registered</p>
              </div>
            )}

            {/* Frozen wallet */}
            {checkWalletFrozen && <FrozenBanner />}

            {/* Payment buttons — only if not frozen */}
            {!checkWalletFrozen && (
              <div className="space-y-3">
                {balance.lana > 0 && (
                  <Button
                    onClick={() => console.log('Pay with $Lanas', balance.address)}
                    className="w-full h-16 rounded-2xl text-lg font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
                  >
                    <img src={lanaIcon} alt="Lana" className="w-7 h-7 object-contain" />
                    Pay with $Lanas
                  </Button>
                )}
                <Button
                  onClick={() => onPayWithCash?.(balance.address)}
                  variant="outline"
                  className="w-full h-16 rounded-2xl text-lg font-semibold gap-3 border-2"
                >
                  <Banknote className="w-7 h-7" />
                  Pay with {currencySymbol}
                </Button>
              </div>
            )}

            {/* Scan another */}
            <Button
              onClick={() => { setBalance(null); setCheckWalletRegistered(null); setCheckWalletFrozen(false); setWalletScannerOpen(true); }}
              variant="ghost"
              className="w-full h-12 rounded-2xl text-sm font-medium text-muted-foreground"
            >
              <Search className="w-4 h-4 mr-2" />
              Check Another Wallet
            </Button>
          </div>
        )}

        {/* No result yet and not loading — show scan button */}
        {!balance && !balanceError && !isLoadingBalance && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Button
              onClick={() => setWalletScannerOpen(true)}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
            >
              <Search className="w-5 h-5" />
              Scan Wallet ID
            </Button>
          </div>
        )}

        <QRScanner
          isOpen={walletScannerOpen}
          onClose={() => setWalletScannerOpen(false)}
          onScan={(data) => handleWalletScan(data)}
          title="Scan Wallet ID"
          description="Scan a customer's Lana Wallet ID QR code"
        />
      </div>
    );
  }

  // ─── REGISTER VIEW: WIF scan → form → payment button ──
  return (
    <div className="flex flex-col gap-5 px-6 py-4">
      {/* Back button */}
      <button
        onClick={goHome}
        className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors self-start"
      >
        <ArrowLeft className="w-5 h-5" />
        <span className="text-sm font-medium">Back</span>
      </button>

      {/* Verifying spinner */}
      {isVerifying && (
        <div className="flex flex-col items-center gap-3 py-12">
          <Loader2 className="w-10 h-10 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Verifying key...</p>
        </div>
      )}

      {/* Scan error */}
      {scanError && !isVerifying && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4">
            <p className="text-sm text-destructive text-center">{scanError}</p>
          </div>
          <Button
            onClick={() => { setScanError(null); setRegScannerOpen(true); }}
            className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <UserPlus className="w-5 h-5" />
            Scan Again
          </Button>
        </div>
      )}

      {/* Registration success */}
      {regSubmitted && scannedWallet && (
        <div className="space-y-5">
          <div className="flex items-center gap-3 p-4 rounded-2xl bg-primary/10">
            <CheckCircle2 className="w-6 h-6 text-primary flex-shrink-0" />
            <p className="text-base font-semibold text-foreground">Wallet Registered</p>
          </div>

          {/* All derived data */}
          <div className="glass-card rounded-2xl p-4 space-y-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Wallet ID</p>
              <p className="text-sm font-mono text-foreground break-all">{scannedWallet.walletId}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Nostr HEX ID</p>
              <p className="text-sm font-mono text-foreground break-all">{scannedWallet.nostrHexId}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Nostr npub</p>
              <p className="text-sm font-mono text-foreground break-all">{scannedWallet.nostrNpubId}</p>
            </div>
          </div>

          {/* Payment button */}
          <Button
            onClick={() => onPayWithCash?.(scannedWallet.walletId)}
            variant="outline"
            className="w-full h-16 rounded-2xl text-lg font-semibold gap-3 border-2"
          >
            <Banknote className="w-7 h-7" />
            Pay with {currencySymbol}
          </Button>
        </div>
      )}

      {/* Registration form */}
      {scannedWallet && !regSubmitted && (
        <div className="space-y-4">
          {/* Derived IDs */}
          <div className="rounded-xl bg-secondary p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Derived Keys</p>
              <button
                onClick={() => { setScannedWallet(null); setWalletRegistered(null); setWalletFrozen(false); setRegScannerOpen(true); }}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground">Wallet ID</p>
              <p className="text-xs font-mono text-foreground break-all">{scannedWallet.walletId}</p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground">Nostr HEX ID</p>
              <p className="text-xs font-mono text-foreground break-all">{scannedWallet.nostrHexId}</p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground">Nostr npub</p>
              <p className="text-xs font-mono text-foreground break-all">{scannedWallet.nostrNpubId}</p>
            </div>
          </div>

          {/* Registration status */}
          {checkingRegistration && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-secondary">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Checking registration...</p>
            </div>
          )}

          {walletRegistered === true && !walletFrozen && (
            <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/10">
              <ShieldCheck className="w-5 h-5 text-primary flex-shrink-0" />
              <p className="text-sm font-medium text-foreground">Wallet is registered</p>
            </div>
          )}

          {walletRegistered === true && walletFrozen && <FrozenBanner />}

          {walletRegistered === false && (
            <div className="flex items-center gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
              <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Wallet is not registered</p>
            </div>
          )}

          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Full Name <span className="text-destructive">*</span>
            </label>
            <Input
              placeholder="First and last name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="h-11 rounded-xl"
            />
          </div>

          {/* Email */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Email</label>
            <Input
              type="email"
              placeholder="email@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-11 rounded-xl"
            />
          </div>

          {/* Mobile */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Mobile</label>
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

          {/* Submit */}
          <Button
            onClick={handleRegSubmit}
            disabled={!fullName.trim()}
            className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
          >
            <UserPlus className="w-5 h-5" />
            Register Wallet
          </Button>
        </div>
      )}

      {/* No wallet scanned yet — show scan button */}
      {!scannedWallet && !scanError && !isVerifying && !regSubmitted && (
        <div className="flex flex-col items-center gap-4 py-8">
          <Button
            onClick={() => setRegScannerOpen(true)}
            className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
          >
            <UserPlus className="w-5 h-5" />
            Scan WIF Key
          </Button>
        </div>
      )}

      <QRScanner
        isOpen={regScannerOpen}
        onClose={() => setRegScannerOpen(false)}
        onScan={(data) => handleWifScan(data)}
        title="Scan WIF Key"
        description="Scan a Lana WIF Private Key to register"
      />
    </div>
  );
};

export default WalletsTab;
