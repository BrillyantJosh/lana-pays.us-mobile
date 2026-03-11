import { useState } from "react";
import { Banknote, ArrowLeft } from "lucide-react";
import TopBar from "@/components/TopBar";
import MenuDrawer from "@/components/MenuDrawer";
import CashTab from "@/components/tabs/CashTab";
import WalletsTab from "@/components/tabs/WalletsTab";
import LanaTab from "@/components/tabs/LanaTab";
import { useAuth } from "@/contexts/AuthContext";
import lanaIcon from "@/assets/lana-icon.png";

const CURRENCY_SYMBOL: Record<string, string> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
};

type View = "home" | "cash" | "wallets" | "lana";

const Index = () => {
  const { session } = useAuth();
  const currencySymbol = CURRENCY_SYMBOL[session?.currency || 'GBP'] || '£';

  const [activeView, setActiveView] = useState<View>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);
  const [lanaPaymentRequest, setLanaPaymentRequest] = useState<{ walletAddress: string } | null>(null);

  const handlePayWithCash = (walletId: string) => {
    setSelectedWallet(walletId);
    setActiveView("cash");
  };

  const handlePayWithLana = (walletAddress: string) => {
    setLanaPaymentRequest({ walletAddress });
    setActiveView("lana");
  };

  const goHome = () => {
    setSelectedWallet(null);
    setLanaPaymentRequest(null);
    setActiveView("home");
  };

  const handleCheckWallet = () => {
    setSelectedWallet(null);
    setLanaPaymentRequest(null);
    setActiveView("wallets");
  };

  return (
    <div className="min-h-screen bg-background">
      <TopBar onMenuOpen={() => setMenuOpen(true)} />
      <MenuDrawer open={menuOpen} onClose={() => setMenuOpen(false)} onCheckWallet={handleCheckWallet} />

      <main className="pt-14">
        {/* ─── Home: two big buttons ─── */}
        {activeView === "home" && (
          <div className="flex flex-col gap-5 px-6 py-6" style={{ minHeight: 'calc(100vh - 3.5rem)' }}>
            <button
              onClick={() => setActiveView("cash")}
              className="flex-1 rounded-3xl bg-card border-2 border-border shadow-lg flex flex-col items-center justify-center gap-4 p-8 active:scale-[0.98] transition-transform"
            >
              <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
                <Banknote className="w-11 h-11 text-primary" />
              </div>
              <span className="text-3xl font-bold text-foreground">Pay with {currencySymbol}</span>
              <span className="text-base text-muted-foreground">Cash payment</span>
            </button>

            <button
              onClick={() => setActiveView("lana")}
              className="flex-1 rounded-3xl bg-card border-2 border-border shadow-lg flex flex-col items-center justify-center gap-4 p-8 active:scale-[0.98] transition-transform"
            >
              <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
                <img src={lanaIcon} alt="Lana" className="w-11 h-11 object-contain" />
              </div>
              <span className="text-3xl font-bold text-foreground">Pay with $Lana</span>
              <span className="text-base text-muted-foreground">Lana coin payment</span>
            </button>
          </div>
        )}

        {/* ─── Back button + Tabs ─── */}
        {activeView !== "home" && (
          <div>
            <div className="px-4 py-3">
              <button
                onClick={goHome}
                className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors text-sm font-medium"
              >
                <ArrowLeft className="w-5 h-5" />
                Back
              </button>
            </div>

            {activeView === "wallets" && (
              <WalletsTab onPayWithCash={handlePayWithCash} onPayWithLana={handlePayWithLana} />
            )}
            {activeView === "cash" && (
              <CashTab selectedWallet={selectedWallet} onClearWallet={() => setSelectedWallet(null)} />
            )}
            {activeView === "lana" && (
              <LanaTab paymentRequest={lanaPaymentRequest} onClearRequest={() => setLanaPaymentRequest(null)} />
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default Index;
