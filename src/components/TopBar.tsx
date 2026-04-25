import { useEffect, useState } from "react";
import { Menu } from "lucide-react";
import lanaLogo from "@/assets/lana-icon-green.png";
import { useAuth } from "@/contexts/AuthContext";

interface TopBarProps {
  onMenuOpen: () => void;
}

const CURRENCY_SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };

const TopBar = ({ onMenuOpen }: TopBarProps) => {
  const { session } = useAuth();
  const greeting = session?.profileDisplayName || session?.profileName || null;
  const [fiatValue, setFiatValue] = useState<number | null>(null);

  const currency = session?.currency || 'EUR';
  const symbol = CURRENCY_SYMBOL[currency] || currency;

  useEffect(() => {
    if (!session?.walletId) return;

    const fetchBalance = () => {
      fetch(`/api/balance/${encodeURIComponent(session.walletId)}?currency=${currency}`)
        .then(r => r.json())
        .then(data => {
          if (data.fiatValue !== undefined) setFiatValue(data.fiatValue);
        })
        .catch(() => {});
    };

    fetchBalance();
    const interval = setInterval(fetchBalance, 60_000); // refresh every minute
    return () => clearInterval(interval);
  }, [session?.walletId, currency]);

  return (
    <header className="fixed top-0 left-0 right-0 h-14 bg-card/90 backdrop-blur-md border-b border-border flex items-center justify-between px-4 z-50">
      <div className="flex items-center gap-2 shrink-0">
        <img src={lanaLogo} alt="Lana" className="w-8 h-8 object-contain dark:brightness-125" />
        <h1 className="font-display text-lg font-bold text-foreground hidden sm:block">
          Lana<span className="text-primary">Pays.Us</span>
        </h1>
      </div>

      {/* Center: balance in fiat */}
      {fiatValue !== null && (
        <div className="flex-1 flex items-center justify-center px-2 min-w-0">
          <span className="text-base sm:text-lg font-bold text-primary truncate">
            {symbol}{fiatValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 shrink-0">
        {greeting && (
          <span className="text-sm font-semibold text-muted-foreground truncate max-w-[100px] sm:max-w-[150px] hidden sm:inline">
            {greeting}
          </span>
        )}
        <button
          onClick={onMenuOpen}
          className="w-10 h-10 flex items-center justify-center rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
      </div>
    </header>
  );
};

export default TopBar;
