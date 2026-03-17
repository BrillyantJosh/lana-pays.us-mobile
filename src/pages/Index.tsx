import { useState, useEffect } from "react";
import { Banknote, ArrowLeft, Store, MapPin } from "lucide-react";
import TopBar from "@/components/TopBar";
import MenuDrawer from "@/components/MenuDrawer";
import CashTab from "@/components/tabs/CashTab";
import WalletsTab from "@/components/tabs/WalletsTab";
import LanaTab from "@/components/tabs/LanaTab";
import { useAuth } from "@/contexts/AuthContext";
import lanaIcon from "@/assets/lana-icon.png";

interface BusinessUnit {
  unit_id: string;
  name: string;
  owner_hex: string;
  category: string;
  category_detail: string;
  currency: string;
  country: string;
  image: string;
  logo: string;
  status: string;
  receiver_city: string;
  lanapays_payout_method: string;
}

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
  const [businessUnits, setBusinessUnits] = useState<BusinessUnit[]>([]);
  const [selectedUnit, setSelectedUnit] = useState<BusinessUnit | null>(null);
  const [loadingUnits, setLoadingUnits] = useState(true);

  // Fetch business units for logged-in user
  useEffect(() => {
    if (!session?.nostrHexId) {
      setBusinessUnits([]);
      setLoadingUnits(false);
      return;
    }

    const fetchUnits = async () => {
      try {
        const res = await fetch(`/api/business-units/${session.nostrHexId}`);
        const data = await res.json();
        setBusinessUnits(data.units || []);
        // Auto-select first unit if only one
        if (data.units?.length === 1) {
          setSelectedUnit(data.units[0]);
        }
      } catch (e) {
        console.warn('Failed to fetch business units:', e);
      } finally {
        setLoadingUnits(false);
      }
    };

    fetchUnits();
  }, [session?.nostrHexId]);

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

            {/* ─── Shop Selector ─── */}
            {loadingUnits ? (
              <div className="rounded-2xl bg-card border border-border p-4 flex items-center justify-center">
                <span className="text-sm text-muted-foreground animate-pulse">Loading shops...</span>
              </div>
            ) : businessUnits.length === 0 ? (
              <div className="rounded-2xl bg-card border border-border p-4 flex items-center gap-3">
                <Store className="w-5 h-5 text-muted-foreground shrink-0" />
                <span className="text-sm text-muted-foreground">No shops assigned to your account</span>
              </div>
            ) : businessUnits.length === 1 ? (
              <div className="rounded-2xl bg-primary/5 border-2 border-primary/20 p-4 flex items-center gap-3">
                {businessUnits[0].image ? (
                  <img src={businessUnits[0].image} alt="" className="w-10 h-10 rounded-xl object-cover shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                    <Store className="w-5 h-5 text-primary" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{businessUnits[0].name}</p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    {businessUnits[0].receiver_city && <><MapPin className="w-3 h-3" />{businessUnits[0].receiver_city}</>}
                    {businessUnits[0].receiver_city && businessUnits[0].category && ' · '}
                    {businessUnits[0].category}
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1">Select shop</p>
                <div className="flex flex-col gap-2">
                  {businessUnits.map(unit => (
                    <button
                      key={unit.unit_id}
                      onClick={() => setSelectedUnit(unit)}
                      className={`rounded-2xl border-2 p-4 flex items-center gap-3 transition-all active:scale-[0.98] ${
                        selectedUnit?.unit_id === unit.unit_id
                          ? 'bg-primary/5 border-primary/30 shadow-md'
                          : 'bg-card border-border hover:border-primary/20'
                      }`}
                    >
                      {unit.image ? (
                        <img src={unit.image} alt="" className="w-10 h-10 rounded-xl object-cover shrink-0" />
                      ) : (
                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                          <Store className="w-5 h-5 text-primary" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0 text-left">
                        <p className="text-sm font-semibold text-foreground truncate">{unit.name}</p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          {unit.receiver_city && <><MapPin className="w-3 h-3" />{unit.receiver_city}</>}
                          {unit.receiver_city && unit.category && ' · '}
                          {unit.category}
                        </p>
                      </div>
                      {selectedUnit?.unit_id === unit.unit_id && (
                        <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                          <div className="w-2 h-2 rounded-full bg-white" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ─── Payment buttons ─── */}
            <button
              onClick={() => setActiveView("cash")}
              disabled={businessUnits.length > 1 && !selectedUnit}
              className="flex-1 rounded-3xl bg-card border-2 border-border shadow-lg flex flex-col items-center justify-center gap-4 p-8 active:scale-[0.98] transition-transform disabled:opacity-40 disabled:pointer-events-none"
            >
              <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
                <Banknote className="w-11 h-11 text-primary" />
              </div>
              <span className="text-3xl font-bold text-foreground">Pay with {currencySymbol}</span>
              <span className="text-base text-muted-foreground">Cash payment</span>
            </button>

            <button
              onClick={() => setActiveView("lana")}
              disabled={businessUnits.length > 1 && !selectedUnit}
              className="flex-1 rounded-3xl bg-card border-2 border-border shadow-lg flex flex-col items-center justify-center gap-4 p-8 active:scale-[0.98] transition-transform disabled:opacity-40 disabled:pointer-events-none"
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
