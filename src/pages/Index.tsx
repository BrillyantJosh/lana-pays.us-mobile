import { useState, useEffect, useCallback } from "react";
import { Banknote, ArrowLeft, Store, MapPin, ShieldAlert, Info } from "lucide-react";
import TopBar from "@/components/TopBar";
import MenuDrawer from "@/components/MenuDrawer";
import CashTab from "@/components/tabs/CashTab";
import WalletsTab from "@/components/tabs/WalletsTab";
import LanaTab from "@/components/tabs/LanaTab";
import EditProfile from "@/components/EditProfile";
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
  suspension_status: string;
  suspension_reason: string | null;
  suspension_until: number | null;
  suspension_content: string | null;
}

const CURRENCY_SYMBOL: Record<string, string> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
};

type View = "home" | "cash" | "wallets" | "lana" | "profile";

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
  const [maxTransactions, setMaxTransactions] = useState<Record<string, {
    max_amount: number | null;
    source: string;
    merchant_limit: number | null;
    fund_limit: number | null;
  }>>({});

  // Sync selected unit ID to window for payment tabs to access
  const effectiveUnit = selectedUnit || (businessUnits.length === 1 ? businessUnits[0] : null);
  const selectedMaxTx = effectiveUnit ? maxTransactions[effectiveUnit.unit_id] : null;

  useEffect(() => {
    (window as any).__selectedUnitId = effectiveUnit?.unit_id || '';
    (window as any).__maxTransactionAmount = selectedMaxTx?.max_amount ?? null;
  }, [effectiveUnit, selectedMaxTx]);

  // Fetch business units for logged-in user (initial + poll every 30s)
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
        const units = data.units || [];
        setBusinessUnits(units);
        // Auto-select if only one and nothing selected yet
        if (units.length === 1) {
          setSelectedUnit(prev => prev || units[0]);
        }
      } catch (e) {
        console.warn('Failed to fetch business units:', e);
      } finally {
        setLoadingUnits(false);
      }
    };

    fetchUnits();
    const interval = setInterval(fetchUnits, 30_000);
    return () => clearInterval(interval);
  }, [session?.nostrHexId]);

  // Fetch max transaction limits for ALL business units
  useEffect(() => {
    if (businessUnits.length === 0) {
      setMaxTransactions({});
      return;
    }

    const fetchAllMaxTx = async () => {
      const results: typeof maxTransactions = {};
      await Promise.all(
        businessUnits
          .filter(u => u.suspension_status !== 'suspended')
          .map(async (unit) => {
            try {
              const currency = unit.currency || session?.currency || 'EUR';
              const res = await fetch(`/api/max-transaction?unit_id=${encodeURIComponent(unit.unit_id)}&currency=${currency}`);
              if (res.ok) {
                results[unit.unit_id] = await res.json();
              }
            } catch (e) {
              console.warn(`Failed to fetch max transaction for ${unit.unit_id}:`, e);
            }
          })
      );
      setMaxTransactions(results);
    };

    fetchAllMaxTx();
    const interval = setInterval(fetchAllMaxTx, 60_000);
    return () => clearInterval(interval);
  }, [businessUnits, session?.currency]);

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

  const handleEditProfile = () => {
    setSelectedWallet(null);
    setLanaPaymentRequest(null);
    setActiveView("profile");
  };

  return (
    <div className="min-h-screen bg-background">
      <TopBar onMenuOpen={() => setMenuOpen(true)} />
      <MenuDrawer open={menuOpen} onClose={() => setMenuOpen(false)} onCheckWallet={handleCheckWallet} onEditProfile={handleEditProfile} />

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
              <div className={`rounded-2xl border-2 p-4 flex flex-col gap-2 ${
                businessUnits[0].suspension_status === 'suspended'
                  ? 'bg-destructive/5 border-destructive/20'
                  : 'bg-primary/5 border-primary/20'
              }`}>
                <div className="flex items-center gap-3">
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
                    {(() => {
                      const tx = maxTransactions[businessUnits[0].unit_id];
                      if (!tx || tx.max_amount === null || tx.max_amount === undefined) return null;
                      const sym = CURRENCY_SYMBOL[businessUnits[0].currency] || currencySymbol;
                      return (
                        <p className="text-xs text-blue-600 dark:text-blue-400 font-medium mt-0.5 flex items-center gap-1">
                          <Info className="w-3 h-3" />
                          Max: {sym}{tx.max_amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </p>
                      );
                    })()}
                  </div>
                </div>
                {businessUnits[0].suspension_status === 'suspended' && (
                  <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3">
                    <ShieldAlert className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-destructive">Suspended</p>
                      <p className="text-xs text-destructive/80">{businessUnits[0].suspension_reason || businessUnits[0].suspension_content}</p>
                      {businessUnits[0].suspension_until && (
                        <p className="text-xs text-destructive/60 mt-1">Until: {new Date(businessUnits[0].suspension_until * 1000).toLocaleDateString()}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1">Select shop</p>
                <div className="flex flex-col gap-2">
                  {businessUnits.map(unit => (
                    <button
                      key={unit.unit_id}
                      onClick={() => unit.suspension_status !== 'suspended' && setSelectedUnit(unit)}
                      disabled={unit.suspension_status === 'suspended'}
                      className={`rounded-2xl border-2 p-4 flex flex-col gap-2 transition-all active:scale-[0.98] disabled:opacity-60 disabled:active:scale-100 ${
                        unit.suspension_status === 'suspended'
                          ? 'bg-destructive/5 border-destructive/20'
                          : selectedUnit?.unit_id === unit.unit_id
                            ? 'bg-primary/5 border-primary/30 shadow-md'
                            : 'bg-card border-border hover:border-primary/20'
                      }`}
                    >
                      <div className="flex items-center gap-3 w-full">
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
                          {(() => {
                            const tx = maxTransactions[unit.unit_id];
                            if (!tx || tx.max_amount === null || tx.max_amount === undefined) return null;
                            const sym = CURRENCY_SYMBOL[unit.currency] || currencySymbol;
                            return (
                              <p className="text-xs text-blue-600 dark:text-blue-400 font-medium mt-0.5 flex items-center gap-1">
                                <Info className="w-3 h-3" />
                                Max: {sym}{tx.max_amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </p>
                            );
                          })()}
                        </div>
                        {unit.suspension_status !== 'suspended' && selectedUnit?.unit_id === unit.unit_id && (
                          <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                            <div className="w-2 h-2 rounded-full bg-white" />
                          </div>
                        )}
                      </div>
                      {unit.suspension_status === 'suspended' && (
                        <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 w-full">
                          <ShieldAlert className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                          <div className="min-w-0 text-left">
                            <p className="text-xs font-semibold text-destructive">Suspended</p>
                            <p className="text-xs text-destructive/80">{unit.suspension_reason || unit.suspension_content}</p>
                            {unit.suspension_until && (
                              <p className="text-xs text-destructive/60 mt-1">Until: {new Date(unit.suspension_until * 1000).toLocaleDateString()}</p>
                            )}
                          </div>
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
              disabled={(businessUnits.length > 1 && !selectedUnit) || (selectedUnit?.suspension_status === 'suspended') || (businessUnits.length === 1 && businessUnits[0]?.suspension_status === 'suspended')}
              className="flex-1 rounded-3xl bg-card border-2 border-border shadow-lg flex flex-col items-center justify-center gap-4 p-8 active:scale-[0.98] transition-transform disabled:opacity-40 disabled:pointer-events-none"
            >
              <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
                <Banknote className="w-11 h-11 text-primary" />
              </div>
              <span className="text-3xl font-bold text-foreground">Pay with {CURRENCY_SYMBOL[effectiveUnit?.currency || ''] || currencySymbol}</span>
              <span className="text-base text-muted-foreground">Cash payment</span>
            </button>

            <button
              onClick={() => setActiveView("lana")}
              disabled={(businessUnits.length > 1 && !selectedUnit) || (selectedUnit?.suspension_status === 'suspended') || (businessUnits.length === 1 && businessUnits[0]?.suspension_status === 'suspended')}
              className="flex-1 rounded-3xl bg-card border-2 border-border shadow-lg flex flex-col items-center justify-center gap-4 p-8 active:scale-[0.98] transition-transform disabled:opacity-40 disabled:pointer-events-none"
            >
              <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
                <img src={lanaIcon} alt="Lana" className="w-11 h-11 object-contain dark:invert" />
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
              <CashTab selectedWallet={selectedWallet} onClearWallet={() => setSelectedWallet(null)} unitCurrency={effectiveUnit?.currency} />
            )}
            {activeView === "lana" && (
              <LanaTab paymentRequest={lanaPaymentRequest} onClearRequest={() => setLanaPaymentRequest(null)} unitCurrency={effectiveUnit?.currency} />
            )}
            {activeView === "profile" && (
              <EditProfile />
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default Index;
