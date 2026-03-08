import { useState } from "react";
import { Search, UserPlus, Loader2, CheckCircle2, X, Coins, Banknote, ArrowLeft } from "lucide-react";
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

type View = "home" | "check" | "register";

const WalletsTab = () => {
  const { session } = useAuth();
  const userCurrency = session?.currency || 'GBP';
  const currencySymbol = CURRENCY_SYMBOL[userCurrency] || '£';

  const [view, setView] = useState<View>("home");

  // Balance check state
  const [walletScannerOpen, setWalletScannerOpen] = useState(false);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  // Registration state
  const [regScannerOpen, setRegScannerOpen] = useState(false);
  const [scannedWallet, setScannedWallet] = useState<ScannedWallet | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [regSubmitted, setRegSubmitted] = useState(false);

  // Form fields
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [countryCode, setCountryCode] = useState("+44");
  const [mobile, setMobile] = useState("");

  const goHome = () => {
    setView("home");
    setBalance(null);
    setBalanceError(null);
    setScannedWallet(null);
    setScanError(null);
    setRegSubmitted(false);
    setFullName("");
    setEmail("");
    setCountryCode("+44");
    setMobile("");
  };

  const fetchBalance = async (address: string) => {
    setIsLoadingBalance(true);
    setBalanceError(null);
    setBalance(null);

    try {
      const res = await fetch(`/api/balance/${encodeURIComponent(address)}?currency=${userCurrency}`);
      const json = await res.json();

      if (!res.ok) {
        throw new Error(json.error || 'Failed to fetch balance');
      }

      setBalance(json);
    } catch (err) {
      setBalanceError(err instanceof Error ? err.message : 'Failed to check balance');
    } finally {
      setIsLoadingBalance(false);
    }
  };

  const handleWifScan = async (data: string) => {
    setIsVerifying(true);
    setScanError(null);

    try {
      const ids = await convertWifToIds(data);
      setScannedWallet({
        walletId: ids.walletId,
        nostrHexId: ids.nostrHexId,
        nostrNpubId: ids.nostrNpubId,
      });
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Invalid WIF key');
    } finally {
      setIsVerifying(false);
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
          onScan={(data) => fetchBalance(data)}
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

            {/* Payment buttons */}
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
                onClick={() => console.log('Pay with', userCurrency)}
                variant="outline"
                className="w-full h-16 rounded-2xl text-lg font-semibold gap-3 border-2"
              >
                <Banknote className="w-7 h-7" />
                Pay with {currencySymbol} {userCurrency}
              </Button>
            </div>

            {/* Scan another */}
            <Button
              onClick={() => { setBalance(null); setWalletScannerOpen(true); }}
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
          onScan={(data) => fetchBalance(data)}
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
            onClick={() => console.log('Pay with', userCurrency, scannedWallet.walletId)}
            variant="outline"
            className="w-full h-16 rounded-2xl text-lg font-semibold gap-3 border-2"
          >
            <Banknote className="w-7 h-7" />
            Pay with {currencySymbol} {userCurrency}
          </Button>

          <Button
            onClick={goHome}
            variant="ghost"
            className="w-full h-12 rounded-2xl text-sm font-medium text-muted-foreground"
          >
            <UserPlus className="w-4 h-4 mr-2" />
            Register Another
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
                onClick={() => { setScannedWallet(null); setRegScannerOpen(true); }}
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
