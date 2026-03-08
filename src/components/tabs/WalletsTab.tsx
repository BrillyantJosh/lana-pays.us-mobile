import { useState } from "react";
import { ScanLine, Wallet, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QRScanner } from "@/components/QRScanner";
import { useAuth } from "@/contexts/AuthContext";

interface BalanceResult {
  address: string;
  lana: number;
  gbp: number;
  confirmed: number;
  unconfirmed: number;
  rate: number;
}

const WalletsTab = () => {
  const { session } = useAuth();
  const [walletScannerOpen, setWalletScannerOpen] = useState(false);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col gap-6 px-6 py-4">
      {/* My Wallet */}
      {session && (
        <div className="glass-card rounded-2xl p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center">
              <Wallet className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-sm text-foreground">My Wallet</h3>
              <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                {session.walletId}
              </p>
            </div>
          </div>

          <Button
            onClick={() => fetchBalance(session.walletId)}
            disabled={isLoadingBalance}
            className="w-full h-12 rounded-xl text-sm font-semibold gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {isLoadingBalance ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Checking...
              </>
            ) : (
              <>
                <Wallet className="w-4 h-4" />
                Check My Balance
              </>
            )}
          </Button>
        </div>
      )}

      {/* Balance Result */}
      {balance && (
        <div className="glass-card rounded-2xl p-5 space-y-3">
          <h3 className="font-semibold text-sm text-foreground">Balance</h3>
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

      <div className="border-t border-border" />

      {/* Scan Any Wallet */}
      <div className="flex flex-col items-center gap-5">
        <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center">
          <Wallet className="w-8 h-8 text-primary" />
        </div>
        <div className="text-center space-y-1">
          <h2 className="font-display text-xl font-bold text-foreground">Check Balance</h2>
          <p className="text-muted-foreground text-sm max-w-[260px]">
            Scan any Lana Wallet ID to check its balance
          </p>
        </div>
        <Button
          onClick={() => setWalletScannerOpen(true)}
          disabled={isLoadingBalance}
          className="w-full max-w-xs h-13 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
        >
          <ScanLine className="w-5 h-5" />
          Scan Wallet ID
        </Button>
      </div>

      <QRScanner
        isOpen={walletScannerOpen}
        onClose={() => setWalletScannerOpen(false)}
        onScan={(data) => fetchBalance(data)}
        title="Scan Wallet ID"
        description="Scan a Lana Wallet ID QR code to check its balance"
      />
    </div>
  );
};

export default WalletsTab;
