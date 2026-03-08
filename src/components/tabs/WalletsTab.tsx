import { useState } from "react";
import { ScanLine, Wallet, Loader2, KeyRound, UserPlus, CheckCircle2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QRScanner } from "@/components/QRScanner";
import { convertWifToIds } from "@/lib/crypto";

interface BalanceResult {
  address: string;
  lana: number;
  gbp: number;
  confirmed: number;
  unconfirmed: number;
  rate: number;
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

const WalletsTab = () => {
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

  const fetchBalance = async (address: string) => {
    setIsLoadingBalance(true);
    setBalanceError(null);
    setBalance(null);

    try {
      const res = await fetch(`/api/balance/${encodeURIComponent(address)}`);
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

    // Mock — just log and show success
    console.log('Registration (mock):', {
      walletId: scannedWallet.walletId,
      nostrHexId: scannedWallet.nostrHexId,
      fullName: fullName.trim(),
      email: email.trim() || null,
      mobile: mobile.trim() ? `${countryCode}${mobile.trim()}` : null,
    });

    setRegSubmitted(true);
  };

  const resetRegistration = () => {
    setScannedWallet(null);
    setScanError(null);
    setRegSubmitted(false);
    setFullName("");
    setEmail("");
    setCountryCode("+44");
    setMobile("");
  };

  return (
    <div className="flex flex-col gap-6 px-6 py-4">

      {/* ─── Register Wallet ─────────────────────────── */}
      <div className="glass-card rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <KeyRound className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-sm text-foreground">Register Wallet</h3>
            <p className="text-xs text-muted-foreground">Scan customer's WIF key to register</p>
          </div>
        </div>

        {/* Success state */}
        {regSubmitted && scannedWallet && (
          <div className="space-y-3">
            <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/10">
              <CheckCircle2 className="w-5 h-5 text-primary flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Wallet Registered</p>
                <p className="text-xs text-muted-foreground truncate">{scannedWallet.walletId}</p>
              </div>
            </div>
            <Button
              onClick={resetRegistration}
              variant="outline"
              className="w-full h-11 rounded-xl text-sm font-semibold"
            >
              Register Another
            </Button>
          </div>
        )}

        {/* Scan step — no wallet scanned yet */}
        {!scannedWallet && !regSubmitted && (
          <>
            <Button
              onClick={() => setRegScannerOpen(true)}
              disabled={isVerifying}
              className="w-full h-12 rounded-xl text-sm font-semibold gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {isVerifying ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Verifying...
                </>
              ) : (
                <>
                  <ScanLine className="w-4 h-4" />
                  Scan WIF Key
                </>
              )}
            </Button>

            {scanError && (
              <div className="rounded-xl bg-destructive/10 border border-destructive/20 p-3">
                <p className="text-sm text-destructive text-center">{scanError}</p>
              </div>
            )}
          </>
        )}

        {/* Form step — wallet scanned, show registration form */}
        {scannedWallet && !regSubmitted && (
          <div className="space-y-4">
            {/* Wallet ID display */}
            <div className="flex items-center justify-between p-3 rounded-xl bg-secondary">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Wallet ID</p>
                <p className="text-sm font-mono text-foreground truncate">{scannedWallet.walletId}</p>
              </div>
              <button
                onClick={resetRegistration}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Name (required) */}
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

            {/* Mobile with country code */}
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
              className="w-full h-12 rounded-xl text-sm font-semibold gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <UserPlus className="w-4 h-4" />
              Register Wallet
            </Button>
          </div>
        )}
      </div>

      <div className="border-t border-border" />

      {/* ─── Check Customer Balance ──────────────────── */}
      <div className="flex flex-col items-center gap-5">
        <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center">
          <Wallet className="w-8 h-8 text-primary" />
        </div>
        <div className="text-center space-y-1">
          <h2 className="font-display text-xl font-bold text-foreground">Check Balance</h2>
          <p className="text-muted-foreground text-sm max-w-[260px]">
            Scan a customer's Lana Wallet ID to check their balance
          </p>
        </div>
        <Button
          onClick={() => setWalletScannerOpen(true)}
          disabled={isLoadingBalance}
          className="w-full max-w-xs h-13 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
        >
          {isLoadingBalance ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Checking...
            </>
          ) : (
            <>
              <ScanLine className="w-5 h-5" />
              Scan Wallet ID
            </>
          )}
        </Button>
      </div>

      {/* Balance Result */}
      {balance && (
        <div className="glass-card rounded-2xl p-5 space-y-3">
          <h3 className="font-semibold text-sm text-foreground">Customer Balance</h3>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-foreground">{balance.lana.toLocaleString()}</span>
            <span className="text-lg text-muted-foreground">LANA</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-semibold text-primary">
              {balance.gbp.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Rate: 1 LANA = {balance.rate} GBP
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {balance.address}
          </p>
        </div>
      )}

      {balanceError && (
        <div className="rounded-xl bg-destructive/10 border border-destructive/20 p-3">
          <p className="text-sm text-destructive text-center">{balanceError}</p>
        </div>
      )}

      {/* QR Scanners */}
      <QRScanner
        isOpen={walletScannerOpen}
        onClose={() => setWalletScannerOpen(false)}
        onScan={(data) => fetchBalance(data)}
        title="Scan Wallet ID"
        description="Scan a customer's Lana Wallet ID QR code to check their balance"
      />

      <QRScanner
        isOpen={regScannerOpen}
        onClose={() => setRegScannerOpen(false)}
        onScan={(data) => handleWifScan(data)}
        title="Scan WIF Key"
        description="Scan a Lana WIF Private Key to register a new wallet"
      />
    </div>
  );
};

export default WalletsTab;
