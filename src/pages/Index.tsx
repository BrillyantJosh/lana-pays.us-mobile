import { useState, useEffect, useCallback } from "react";
import { useTranslation } from 'react-i18next';
import { Banknote, ArrowLeft, Store, MapPin, ShieldAlert, Info, Leaf, X, ChevronDown, ChevronUp } from "lucide-react";
import TopBar from "@/components/TopBar";
import MenuDrawer from "@/components/MenuDrawer";
import CashTab from "@/components/tabs/CashTab";
import WalletsTab from "@/components/tabs/WalletsTab";
import LanaTab from "@/components/tabs/LanaTab";
import EditProfile from "@/components/EditProfile";
import RegularCustomersTab from "@/components/tabs/RegularCustomersTab";
import RegisterCustomerTab from "@/components/tabs/RegisterCustomerTab";
import MobileQuotaPanel from "@/components/MobileQuotaPanel";
import { useAuth } from "@/contexts/AuthContext";
import lanaIcon from "@/assets/lana-icon.png";
import mandalaMesh from "@/assets/mandala-mesh.png";

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
  // suspension_status now carries the Merchant Registration Gateway status:
  //   'pending' | 'active' | 'quota_warning_80' | 'quota_blocked' | 'suspended' | 'rejected'
  suspension_status: string;
  suspension_reason: string | null;
  suspension_until: number | null;
  suspension_content: string | null;
  quota_volume_used?: number;
  quota_volume_limit?: number;
  quota_tx_used?: number;
  quota_tx_limit?: number;
  quota_currency?: string;
  quota_period?: string;
}

/**
 * The unit cannot accept new purchases.
 * - 'pending'        → awaiting admin approval
 * - 'quota_blocked'  → monthly limit reached, auto-resets 1st of next month
 * - 'suspended'      → admin suspension
 * - 'rejected'       → terminal rejection
 */
const BLOCKING_STATUSES = new Set(['pending', 'quota_blocked', 'suspended', 'rejected']);
function isUnitBlocked(u: { suspension_status?: string | null }): boolean {
  return BLOCKING_STATUSES.has(u.suspension_status || 'active');
}

function statusLabel(status: string): string {
  switch (status) {
    case 'pending': return 'Awaiting approval';
    case 'quota_warning_80': return 'Approaching limit';
    case 'quota_blocked': return 'Monthly limit reached';
    case 'suspended': return 'Suspended';
    case 'rejected': return 'Rejected';
    default: return '';
  }
}

function nextMonthLabel(): string {
  const now = new Date();
  const nm = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return nm.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

function statusBlurb(u: BusinessUnit): string {
  switch (u.suspension_status) {
    case 'pending': return 'Admin is reviewing this business unit. Payments are paused until approved.';
    case 'quota_warning_80': return `Approaching monthly limit. Resets ${nextMonthLabel()}.`;
    case 'quota_blocked': return `Monthly limit reached. Resumes ${nextMonthLabel()}.`;
    case 'suspended': return u.suspension_reason || u.suspension_content || 'Suspended — contact admin.';
    case 'rejected': return u.suspension_reason || u.suspension_content || 'Registration rejected — contact admin.';
    default: return '';
  }
}

/**
 * Compact pill rendering the gateway status. Returns null for plain 'active'.
 */
function StatusPill({ status }: { status: string }) {
  if (status === 'active' || !status) return null;
  const cls =
    status === 'pending' ? 'bg-amber-100 text-amber-800' :
    status === 'quota_warning_80' ? 'bg-yellow-100 text-yellow-800' :
    status === 'quota_blocked' ? 'bg-red-100 text-red-800' :
    status === 'suspended' ? 'bg-gray-200 text-gray-800' :
    status === 'rejected' ? 'bg-rose-100 text-rose-800' :
    'bg-gray-100 text-gray-700';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${cls}`}>
      {statusLabel(status)}
    </span>
  );
}

/** Convert relative /api/uploads/ paths to absolute shop.lanapays.us URLs */
function resolveImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('/api/uploads/')) return `https://shop.lanapays.us${url}`;
  return url;
}

/**
 * Compact panel that explains why a unit is blocked (pending / quota_blocked
 * / suspended / rejected). Replaces the cash/LANA payment buttons so the
 * staff can't confuse a disabled button for an outage.
 */
function BlockedStatusPanel({ unit }: { unit: BusinessUnit }) {
  return (
    <div className="rounded-3xl bg-destructive/5 border-2 border-destructive/20 p-6 text-center space-y-3">
      <div className="w-14 h-14 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
        <ShieldAlert className="w-7 h-7 text-destructive" />
      </div>
      <h3 className="text-lg font-bold text-destructive">{statusLabel(unit.suspension_status)}</h3>
      <p className="text-sm text-destructive/80 leading-relaxed">{statusBlurb(unit)}</p>
      {unit.suspension_until && (
        <p className="text-xs text-destructive/60">
          Until: {new Date(unit.suspension_until * 1000).toLocaleDateString()}
        </p>
      )}
    </div>
  );
}

/**
 * Compact "Quota ▾" toggle button. Renders only the trigger; the expanded
 * MobileQuotaPanel is rendered separately by the parent so it can occupy
 * full card width (the button itself sits under the Max Invoice number).
 */
function QuotaToggle({
  unit,
  open,
  onToggle,
}: {
  unit: BusinessUnit;
  open: boolean;
  onToggle: () => void;
}) {
  const hasQuota = (unit.quota_volume_limit ?? 0) > 0 || (unit.quota_tx_limit ?? 0) > 0;
  if (!hasQuota) return null;
  return (
    <button
      onClick={onToggle}
      className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
    >
      <Info className="w-3 h-3" />
      Quota
      {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
    </button>
  );
}

const CURRENCY_SYMBOL: Record<string, string> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
};

type View = "home" | "cash" | "wallets" | "lana" | "profile" | "regulars" | "register";

const Index = () => {
  const { t } = useTranslation();
  const { session } = useAuth();
  const currencySymbol = CURRENCY_SYMBOL[session?.currency || 'GBP'] || '£';

  const [activeView, setActiveView] = useState<View>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [principlesOpen, setPrinciplesOpen] = useState(false);
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

  // Per-unit toggle for quota detail panel under the selected card
  const [quotaOpen, setQuotaOpen] = useState<Record<string, boolean>>({});

  // Sync selected unit ID to window for payment tabs to access
  const effectiveUnit = selectedUnit || (businessUnits.length === 1 ? businessUnits[0] : null);
  const selectedMaxTx = effectiveUnit ? maxTransactions[effectiveUnit.unit_id] : null;

  useEffect(() => {
    (window as any).__selectedUnitId = effectiveUnit?.unit_id || '';
    (window as any).__selectedUnit = effectiveUnit || null;
    (window as any).__maxTransactionAmount = selectedMaxTx?.max_amount ?? null;
  }, [effectiveUnit, selectedMaxTx]);

  // Whenever the polled list refreshes, swap our selected reference for the
  // fresh row so suspension_status / quota fields stay current. This drives
  // the auto-deselect-when-blocked UX without a separate effect.
  useEffect(() => {
    if (!selectedUnit || businessUnits.length === 0) return;
    const fresh = businessUnits.find(u => u.unit_id === selectedUnit.unit_id);
    if (!fresh) {
      setSelectedUnit(null);
      return;
    }
    if (fresh !== selectedUnit) {
      // Compare on the fields we care about; preserve referential stability
      // so React doesn't re-render unnecessarily.
      const changed = (
        fresh.suspension_status !== selectedUnit.suspension_status
        || fresh.quota_volume_used !== selectedUnit.quota_volume_used
        || fresh.quota_volume_limit !== selectedUnit.quota_volume_limit
        || fresh.quota_tx_used !== selectedUnit.quota_tx_used
        || fresh.quota_tx_limit !== selectedUnit.quota_tx_limit
      );
      if (changed) setSelectedUnit(fresh);
    }
  }, [businessUnits]);  // eslint-disable-line react-hooks/exhaustive-deps

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
          .filter(u => !isUnitBlocked(u))
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

  const handleRegularCustomers = () => {
    setSelectedWallet(null);
    setLanaPaymentRequest(null);
    setActiveView("regulars");
  };

  const handleRegisterCustomer = () => {
    setSelectedWallet(null);
    setLanaPaymentRequest(null);
    setActiveView("register");
  };

  return (
    <div className="min-h-screen bg-background">
      <TopBar onMenuOpen={() => setMenuOpen(true)} />
      <MenuDrawer open={menuOpen} onClose={() => setMenuOpen(false)} onEditProfile={handleEditProfile} onRegularCustomers={handleRegularCustomers} onRegisterCustomer={handleRegisterCustomer} />

      <main className="pt-14">
        {/* ─── Home: two big buttons ─── */}
        {activeView === "home" && (
          <div className="flex flex-col gap-5 px-6 py-6" style={{ minHeight: 'calc(100vh - 3.5rem)' }}>

            {/* ─── Principles banner (top, prominent) ─── */}
            <button
              onClick={() => setPrinciplesOpen(true)}
              className="w-full rounded-2xl bg-primary/5 border border-primary/20 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform text-left"
            >
              <Leaf className="w-6 h-6 text-primary shrink-0" />
              <p className="text-sm font-medium text-foreground leading-snug">{t('principles.banner')}</p>
            </button>

            {/* ─── Shop Selector ─── */}
            {loadingUnits ? (
              <div className="rounded-2xl bg-card border border-border p-4 flex items-center justify-center">
                <span className="text-sm text-muted-foreground animate-pulse">{t('home.loadingShops')}</span>
              </div>
            ) : businessUnits.length === 0 ? (
              <div className="rounded-2xl bg-card border border-border p-4 flex items-center gap-3">
                <Store className="w-5 h-5 text-muted-foreground shrink-0" />
                <span className="text-sm text-muted-foreground">{t('home.noShops')}</span>
              </div>
            ) : businessUnits.length === 1 ? (
              <div className={`rounded-2xl border-2 p-4 flex flex-col gap-2 ${
                isUnitBlocked(businessUnits[0])
                  ? 'bg-destructive/5 border-destructive/20'
                  : businessUnits[0].suspension_status === 'quota_warning_80'
                    ? 'bg-yellow-50 border-yellow-300'
                    : 'bg-primary/5 border-primary/20'
              }`}>
                <div className="flex items-center gap-3">
                  {resolveImageUrl(businessUnits[0].image) ? (
                    <img src={resolveImageUrl(businessUnits[0].image)!} alt="" className="w-10 h-10 rounded-xl object-cover shrink-0" />
                  ) : (
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                      <Store className="w-5 h-5 text-primary" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-foreground truncate">{businessUnits[0].name}</p>
                      <StatusPill status={businessUnits[0].suspension_status} />
                    </div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      {businessUnits[0].receiver_city && <><MapPin className="w-3 h-3" />{businessUnits[0].receiver_city}</>}
                      {businessUnits[0].receiver_city && businessUnits[0].category && ' · '}
                      {businessUnits[0].category}
                    </p>
                  </div>
                  {(() => {
                    const tx = maxTransactions[businessUnits[0].unit_id];
                    if (!tx || tx.max_amount === null || tx.max_amount === undefined) return null;
                    const sym = CURRENCY_SYMBOL[businessUnits[0].currency] || currencySymbol;
                    const noFunds = tx.max_amount <= 0;
                    return (
                      <div className="shrink-0 text-right">
                        <p className="text-xs text-muted-foreground">{t('home.maxInvoice')}</p>
                        <p className={`text-2xl font-black leading-tight ${noFunds ? 'text-destructive' : 'text-primary'}`}>
                          {sym}{tx.max_amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </p>
                        <div className="flex justify-end">
                          <QuotaToggle
                            unit={businessUnits[0]}
                            open={!!quotaOpen[businessUnits[0].unit_id]}
                            onToggle={() => setQuotaOpen(s => ({ ...s, [businessUnits[0].unit_id]: !s[businessUnits[0].unit_id] }))}
                          />
                        </div>
                      </div>
                    );
                  })()}
                </div>
                {quotaOpen[businessUnits[0].unit_id] && (
                  <MobileQuotaPanel unit={businessUnits[0]} />
                )}
                {(isUnitBlocked(businessUnits[0]) || businessUnits[0].suspension_status === 'quota_warning_80') && (
                  <div className={`flex items-start gap-2 rounded-xl p-3 ${
                    isUnitBlocked(businessUnits[0]) ? 'bg-destructive/10' : 'bg-yellow-100'
                  }`}>
                    <ShieldAlert className={`w-4 h-4 shrink-0 mt-0.5 ${
                      isUnitBlocked(businessUnits[0]) ? 'text-destructive' : 'text-yellow-700'
                    }`} />
                    <div className="min-w-0">
                      <p className={`text-xs font-semibold ${
                        isUnitBlocked(businessUnits[0]) ? 'text-destructive' : 'text-yellow-800'
                      }`}>
                        {statusLabel(businessUnits[0].suspension_status)}
                      </p>
                      <p className={`text-xs ${
                        isUnitBlocked(businessUnits[0]) ? 'text-destructive/80' : 'text-yellow-800/80'
                      }`}>{statusBlurb(businessUnits[0])}</p>
                      {businessUnits[0].suspension_until && (
                        <p className="text-xs text-destructive/60 mt-1">{t('home.suspendedUntil', { date: new Date(businessUnits[0].suspension_until * 1000).toLocaleDateString() })}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : businessUnits.length === 2 ? (
              /* ─── 2 units: inline cards ─── */
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1">{t('home.selectShop')}</p>
                <div className="flex flex-col gap-2">
                  {businessUnits.map(unit => (
                    <button
                      key={unit.unit_id}
                      onClick={() => !isUnitBlocked(unit) && setSelectedUnit(unit)}
                      disabled={isUnitBlocked(unit)}
                      className={`rounded-2xl border-2 p-4 flex flex-col gap-2 transition-all active:scale-[0.98] disabled:opacity-60 disabled:active:scale-100 ${
                        isUnitBlocked(unit)
                          ? 'bg-destructive/5 border-destructive/20'
                          : unit.suspension_status === 'quota_warning_80'
                            ? 'bg-yellow-50 border-yellow-300'
                            : selectedUnit?.unit_id === unit.unit_id
                              ? 'bg-primary/5 border-primary/30 shadow-md'
                              : 'bg-card border-border hover:border-primary/20'
                      }`}
                    >
                      <div className="flex items-center gap-3 w-full">
                        {resolveImageUrl(unit.image) ? (
                          <img src={resolveImageUrl(unit.image)!} alt="" className="w-10 h-10 rounded-xl object-cover shrink-0" />
                        ) : (
                          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                            <Store className="w-5 h-5 text-primary" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0 text-left">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold text-foreground truncate">{unit.name}</p>
                            <StatusPill status={unit.suspension_status} />
                          </div>
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            {unit.receiver_city && <><MapPin className="w-3 h-3" />{unit.receiver_city}</>}
                            {unit.receiver_city && unit.category && ' · '}
                            {unit.category}
                          </p>
                        </div>
                        {(() => {
                          const tx = maxTransactions[unit.unit_id];
                          if (tx && tx.max_amount !== null && tx.max_amount !== undefined) {
                            const sym = CURRENCY_SYMBOL[unit.currency] || currencySymbol;
                            const noFunds = tx.max_amount <= 0;
                            return (
                              <div className="shrink-0 text-right">
                                <p className="text-xs text-muted-foreground">{t('home.maxInvoice')}</p>
                                <p className={`text-2xl font-black leading-tight ${noFunds ? 'text-destructive' : 'text-primary'}`}>
                                  {sym}{tx.max_amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </p>
                              </div>
                            );
                          }
                          if (!isUnitBlocked(unit) && selectedUnit?.unit_id === unit.unit_id) {
                            return (
                              <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                                <div className="w-2 h-2 rounded-full bg-white" />
                              </div>
                            );
                          }
                          return null;
                        })()}
                      </div>
                      {(isUnitBlocked(unit) || unit.suspension_status === 'quota_warning_80') && (
                        <div className={`flex items-start gap-2 rounded-xl p-3 w-full ${
                          isUnitBlocked(unit) ? 'bg-destructive/10' : 'bg-yellow-100'
                        }`}>
                          <ShieldAlert className={`w-4 h-4 shrink-0 mt-0.5 ${
                            isUnitBlocked(unit) ? 'text-destructive' : 'text-yellow-700'
                          }`} />
                          <div className="min-w-0 text-left">
                            <p className={`text-xs font-semibold ${
                              isUnitBlocked(unit) ? 'text-destructive' : 'text-yellow-800'
                            }`}>{statusLabel(unit.suspension_status)}</p>
                            <p className={`text-xs ${
                              isUnitBlocked(unit) ? 'text-destructive/80' : 'text-yellow-800/80'
                            }`}>{statusBlurb(unit)}</p>
                            {unit.suspension_until && (
                              <p className="text-xs text-destructive/60 mt-1">{t('home.suspendedUntil', { date: new Date(unit.suspension_until * 1000).toLocaleDateString() })}</p>
                            )}
                          </div>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
                {/* Quota toggle for selected unit (2-unit layout has buttons-as-rows;
                    nesting another button inside is bad HTML/A11y, so the trigger
                    sits outside the row group). */}
                {selectedUnit && (
                  <div className="px-1 flex justify-end">
                    <QuotaToggle
                      unit={selectedUnit}
                      open={!!quotaOpen[selectedUnit.unit_id]}
                      onToggle={() => setQuotaOpen(s => ({ ...s, [selectedUnit.unit_id]: !s[selectedUnit.unit_id] }))}
                    />
                  </div>
                )}
                {selectedUnit && quotaOpen[selectedUnit.unit_id] && (
                  <MobileQuotaPanel unit={selectedUnit} />
                )}
              </div>
            ) : (
              /* ─── 3+ units: dropdown selector ─── */
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1">{t('home.selectShop')}</p>

                {/* Selected unit card (or prompt to select) */}
                {selectedUnit ? (
                  <div className={`rounded-2xl border-2 p-4 flex flex-col gap-2 ${
                    isUnitBlocked(selectedUnit)
                      ? 'bg-destructive/5 border-destructive/20'
                      : selectedUnit.suspension_status === 'quota_warning_80'
                        ? 'bg-yellow-50 border-yellow-300'
                        : 'bg-primary/5 border-primary/20'
                  }`}>
                    <div className="flex items-center gap-3">
                      {resolveImageUrl(selectedUnit.image) ? (
                        <img src={resolveImageUrl(selectedUnit.image)!} alt="" className="w-10 h-10 rounded-xl object-cover shrink-0" />
                      ) : (
                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                          <Store className="w-5 h-5 text-primary" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-foreground truncate">{selectedUnit.name}</p>
                          <StatusPill status={selectedUnit.suspension_status} />
                        </div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          {selectedUnit.receiver_city && <><MapPin className="w-3 h-3" />{selectedUnit.receiver_city}</>}
                          {selectedUnit.receiver_city && selectedUnit.category && ' · '}
                          {selectedUnit.category}
                        </p>
                      </div>
                      {(() => {
                        const tx = maxTransactions[selectedUnit.unit_id];
                        if (!tx || tx.max_amount === null || tx.max_amount === undefined) return null;
                        const sym = CURRENCY_SYMBOL[selectedUnit.currency] || currencySymbol;
                        const noFunds = tx.max_amount <= 0;
                        return (
                          <div className="shrink-0 text-right">
                            <p className="text-xs text-muted-foreground">{t('home.maxInvoice')}</p>
                            <p className={`text-2xl font-black leading-tight ${noFunds ? 'text-destructive' : 'text-primary'}`}>
                              {sym}{tx.max_amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </p>
                            <div className="flex justify-end">
                              <QuotaToggle
                                unit={selectedUnit}
                                open={!!quotaOpen[selectedUnit.unit_id]}
                                onToggle={() => setQuotaOpen(s => ({ ...s, [selectedUnit.unit_id]: !s[selectedUnit.unit_id] }))}
                              />
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    {quotaOpen[selectedUnit.unit_id] && (
                      <MobileQuotaPanel unit={selectedUnit} />
                    )}
                    {(isUnitBlocked(selectedUnit) || selectedUnit.suspension_status === 'quota_warning_80') && (
                      <div className={`flex items-start gap-2 rounded-xl p-3 ${
                        isUnitBlocked(selectedUnit) ? 'bg-destructive/10' : 'bg-yellow-100'
                      }`}>
                        <ShieldAlert className={`w-4 h-4 shrink-0 mt-0.5 ${
                          isUnitBlocked(selectedUnit) ? 'text-destructive' : 'text-yellow-700'
                        }`} />
                        <div className="min-w-0">
                          <p className={`text-xs font-semibold ${
                            isUnitBlocked(selectedUnit) ? 'text-destructive' : 'text-yellow-800'
                          }`}>{statusLabel(selectedUnit.suspension_status)}</p>
                          <p className={`text-xs ${
                            isUnitBlocked(selectedUnit) ? 'text-destructive/80' : 'text-yellow-800/80'
                          }`}>{statusBlurb(selectedUnit)}</p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}

                {/* Dropdown select */}
                <select
                  value={selectedUnit?.unit_id || ''}
                  onChange={(e) => {
                    const unit = businessUnits.find(u => u.unit_id === e.target.value);
                    if (unit && !isUnitBlocked(unit)) setSelectedUnit(unit);
                  }}
                  className="w-full h-14 rounded-2xl border-2 border-border bg-card px-4 text-base font-semibold text-foreground appearance-none focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                  style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', backgroundSize: '24px', paddingRight: '44px' }}
                >
                  <option value="">{t('home.selectShop')}...</option>
                  {businessUnits.map(unit => {
                    const blocked = isUnitBlocked(unit);
                    const label = statusLabel(unit.suspension_status);
                    return (
                      <option
                        key={unit.unit_id}
                        value={unit.unit_id}
                        disabled={blocked}
                      >
                        {unit.name}{blocked && label ? ` (${label})` : ''}{unit.receiver_city ? ` — ${unit.receiver_city}` : ''}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}

            {/* ─── Payment buttons OR blocked-status panel ─── */}
            {(() => {
              const noShopSelected = (businessUnits.length > 1 && !selectedUnit);
              const isBlocked = (selectedUnit ? isUnitBlocked(selectedUnit) : false) || (businessUnits.length === 1 && isUnitBlocked(businessUnits[0]));
              const noFunds = selectedMaxTx !== null && selectedMaxTx !== undefined && (selectedMaxTx.max_amount === null || selectedMaxTx.max_amount === undefined || selectedMaxTx.max_amount <= 0);

              // Blocked statuses (pending / quota_blocked / suspended /
              // rejected) replace the payment buttons entirely with a
              // status panel — no confusion about why buttons are greyed.
              if (isBlocked && effectiveUnit) {
                return <BlockedStatusPanel unit={effectiveUnit} />;
              }

              const payDisabled = noShopSelected || noFunds;
              return (
                <>
                  <button
                    onClick={() => setActiveView("cash")}
                    disabled={payDisabled}
                    className="relative overflow-hidden flex-1 rounded-3xl bg-card border-2 border-border shadow-lg flex flex-col items-center justify-center gap-4 p-8 active:scale-[0.98] transition-transform disabled:opacity-40 disabled:pointer-events-none"
                  >
                    {/* Mandala background mesh */}
                    <img
                      src={mandalaMesh}
                      alt=""
                      aria-hidden="true"
                      className="absolute inset-0 w-full h-full object-cover opacity-25 dark:opacity-15 mix-blend-multiply dark:mix-blend-screen pointer-events-none select-none"
                    />
                    {/* Content */}
                    <div className="relative z-10 w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center backdrop-blur-sm">
                      <Banknote className="w-11 h-11 text-primary" />
                    </div>
                    <span className="relative z-10 text-3xl font-bold text-foreground">{t('home.payWithCurrency', { symbol: CURRENCY_SYMBOL[effectiveUnit?.currency || ''] || currencySymbol })}</span>
                    <span className="relative z-10 text-base text-muted-foreground">{t('home.cashPayment')}</span>
                  </button>

                  <button
                    onClick={() => setActiveView("lana")}
                    disabled={payDisabled}
                    className="relative overflow-hidden flex-1 rounded-3xl bg-card border-2 border-border shadow-lg flex flex-col items-center justify-center gap-4 p-8 active:scale-[0.98] transition-transform disabled:opacity-40 disabled:pointer-events-none"
                  >
                    {/* Mandala background mesh */}
                    <img
                      src={mandalaMesh}
                      alt=""
                      aria-hidden="true"
                      className="absolute inset-0 w-full h-full object-cover opacity-25 dark:opacity-15 mix-blend-multiply dark:mix-blend-screen pointer-events-none select-none"
                    />
                    {/* Content */}
                    <div className="relative z-10 w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center backdrop-blur-sm">
                      <img src={lanaIcon} alt="Lana" className="w-11 h-11 object-contain dark:invert" />
                    </div>
                    <span className="relative z-10 text-3xl font-bold text-foreground">{t('home.payWithLana')}</span>
                    <span className="relative z-10 text-base text-muted-foreground">{t('home.lanaPayment')}</span>
                  </button>

                  {noFunds && !noShopSelected && (
                    <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4">
                      <p className="text-sm text-destructive text-center font-medium">{t('home.noFunds')}</p>
                    </div>
                  )}
                </>
              );
            })()}

          </div>
        )}

        {/* ─── Principles Modal ─── */}
        {principlesOpen && (
          <>
            <div className="fixed inset-0 bg-foreground/30 backdrop-blur-sm z-[80]" onClick={() => setPrinciplesOpen(false)} />
            <div className="fixed inset-4 z-[90] bg-card rounded-2xl border border-border shadow-xl flex flex-col overflow-hidden">
              <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
                <h2 className="font-display font-bold text-foreground text-lg">{t('principles.title')}</h2>
                <button onClick={() => setPrinciplesOpen(false)} className="w-9 h-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-5 space-y-5 text-sm text-foreground leading-relaxed">
                <p className="text-muted-foreground">{t('principles.subtitle')}</p>

                <div>
                  <h3 className="font-bold text-primary mb-2">{t('principles.s1Title')}</h3>
                  <p className="text-muted-foreground mb-2">{t('principles.s1Intro')}</p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                    <li>{t('principles.s1P1')}</li><li>{t('principles.s1P2')}</li><li>{t('principles.s1P3')}</li><li>{t('principles.s1P4')}</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-bold text-primary mb-2">{t('principles.s2Title')}</h3>
                  <p className="text-muted-foreground mb-2">{t('principles.s2Intro')}</p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                    <li>{t('principles.s2P1')}</li><li>{t('principles.s2P2')}</li><li>{t('principles.s2P3')}</li><li>{t('principles.s2P4')}</li>
                  </ul>
                  <p className="text-muted-foreground mt-2 mb-2">{t('principles.s2Not')}</p>
                  <ul className="list-disc list-inside space-y-1 text-destructive/80">
                    <li>{t('principles.s2N1')}</li><li>{t('principles.s2N2')}</li><li>{t('principles.s2N3')}</li><li>{t('principles.s2N4')}</li><li>{t('principles.s2N5')}</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-bold text-primary mb-2">{t('principles.s3Title')}</h3>
                  <p className="text-muted-foreground mb-2">{t('principles.s3Intro')}</p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                    <li>{t('principles.s3P1')}</li><li>{t('principles.s3P2')}</li><li>{t('principles.s3P3')}</li><li>{t('principles.s3P4')}</li>
                  </ul>
                  <p className="text-muted-foreground mt-2 mb-2">{t('principles.s3Action')}</p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                    <li>{t('principles.s3A1')}</li><li>{t('principles.s3A2')}</li><li>{t('principles.s3A3')}</li><li>{t('principles.s3A4')}</li>
                  </ul>
                  <p className="text-muted-foreground mt-2 italic">{t('principles.s3Responsibility')}</p>
                </div>

                <div>
                  <h3 className="font-bold text-primary mb-2">{t('principles.s4Title')}</h3>
                  <p className="text-muted-foreground mb-2">{t('principles.s4Intro')}</p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                    <li>{t('principles.s4P1')}</li><li>{t('principles.s4P2')}</li><li>{t('principles.s4P3')}</li><li>{t('principles.s4P4')}</li>
                  </ul>
                  <p className="text-muted-foreground mt-2">{t('principles.s4Restore')}</p>
                  <p className="text-muted-foreground mt-1">{t('principles.s4Repeated')}</p>
                </div>

                <div className="rounded-xl bg-primary/5 border border-primary/20 p-4">
                  <p className="text-sm font-bold text-primary text-center italic">{t('principles.core')}</p>
                  <p className="text-xs text-muted-foreground text-center mt-2">{t('principles.closing')}</p>
                </div>
              </div>
            </div>
          </>
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
                {t('common.back')}
              </button>
            </div>

            {activeView === "wallets" && (
              <WalletsTab onPayWithCash={handlePayWithCash} onPayWithLana={handlePayWithLana} />
            )}
            {activeView === "cash" && (
              <CashTab selectedWallet={selectedWallet} onClearWallet={() => setSelectedWallet(null)} unitCurrency={effectiveUnit?.currency} unitId={effectiveUnit?.unit_id} />
            )}
            {activeView === "lana" && (
              <LanaTab paymentRequest={lanaPaymentRequest} onClearRequest={() => setLanaPaymentRequest(null)} unitCurrency={effectiveUnit?.currency} unitId={effectiveUnit?.unit_id} />
            )}
            {activeView === "profile" && (
              <EditProfile />
            )}
            {activeView === "regulars" && (
              <RegularCustomersTab unitId={effectiveUnit?.unit_id} staffHexId={session?.nostrHexId} businessUnits={businessUnits.filter(u => !isUnitBlocked(u))} />
            )}
            {activeView === "register" && (
              <RegisterCustomerTab unitCurrency={effectiveUnit?.currency} />
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default Index;
