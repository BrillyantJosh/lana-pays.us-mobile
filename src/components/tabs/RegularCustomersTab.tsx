import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, UserPlus, Loader2, Trash2, Search, Store, Sparkles, TrendingUp } from 'lucide-react';
import { QRScanner } from '@/components/QRScanner';
import { convertWifToIds } from '@/lib/crypto';

interface RegularCustomer {
  id: number;
  unit_id: string;
  unit_name: string;
  customer_hex_id: string;
  customer_wallet: string;
  customer_npub: string | null;
  display_name: string | null;
  picture: string | null;
  added_by_hex: string;
  note: string | null;
  created_at: string;
}

interface BusinessUnitOption {
  unit_id: string;
  name: string;
  image?: string;
  currency?: string;
}

interface CustomerBalance {
  lana: number;
  fiatValue: number;
  currency: string;
}

const CURRENCY_SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
const WONDER_THRESHOLD_FIAT = 100;

interface RegularCustomersTabProps {
  unitId?: string;
  staffHexId?: string;
  businessUnits?: BusinessUnitOption[];
}

type Step = 'list' | 'scanning' | 'confirm';

const RegularCustomersTab = ({ staffHexId, businessUnits = [] }: RegularCustomersTabProps) => {
  const { t } = useTranslation();

  const [step, setStep] = useState<Step>('list');
  const [customers, setCustomers] = useState<RegularCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // For "Add Customer" — which unit to add to
  const [addToUnitId, setAddToUnitId] = useState<string>(businessUnits[0]?.unit_id || '');

  // Scan result state
  const [scannerOpen, setScannerOpen] = useState(false);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Confirm state
  const [resolvedHexId, setResolvedHexId] = useState<string | null>(null);
  const [resolvedWallet, setResolvedWallet] = useState<string | null>(null);
  const [resolvedNpub, setResolvedNpub] = useState<string | null>(null);
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [resolvedPicture, setResolvedPicture] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Balance + Lana8Wonder status
  const [balances, setBalances] = useState<Record<string, CustomerBalance>>({});
  const [wonderStatus, setWonderStatus] = useState<Record<string, boolean>>({});

  // Delete state
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Fetch ALL customers across all authorized units
  const fetchCustomers = async () => {
    if (!staffHexId) { setLoading(false); return; }
    try {
      const res = await fetch(`/api/regular-customers-all?staff_hex=${staffHexId}`);
      const data = await res.json();
      setCustomers(data.customers || []);
    } catch {
      console.warn('Failed to fetch regular customers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCustomers();
  }, [staffHexId]);

  // Fetch balances + Lana8Wonder for all customers
  useEffect(() => {
    if (customers.length === 0) return;

    // Deduplicate by hex_id (same customer might be in multiple units)
    const seen = new Set<string>();
    customers.forEach(c => {
      if (seen.has(c.customer_hex_id)) return;
      seen.add(c.customer_hex_id);

      const unitCurrency = businessUnits.find(u => u.unit_id === c.unit_id)?.currency || 'EUR';

      fetch(`/api/balance/${encodeURIComponent(c.customer_wallet)}?currency=${unitCurrency}`)
        .then(r => r.json())
        .then(data => {
          if (data.lana !== undefined) {
            setBalances(prev => ({ ...prev, [c.customer_hex_id]: { lana: data.lana, fiatValue: data.fiatValue, currency: data.currency } }));
          }
        })
        .catch(() => {});

      fetch(`/api/lana8wonder/${c.customer_hex_id}`)
        .then(r => r.json())
        .then(data => { setWonderStatus(prev => ({ ...prev, [c.customer_hex_id]: data.enrolled === true })); })
        .catch(() => {});
    });
  }, [customers, businessUnits]);

  // Handle QR scan result
  const handleScan = async (data: string) => {
    const trimmed = data.trim();
    setScannerOpen(false);
    setIsLookingUp(true);
    setLookupError(null);
    setResolvedHexId(null);
    setResolvedWallet(null);
    setResolvedNpub(null);
    setResolvedName(null);
    setResolvedPicture(null);
    setNote('');

    try {
      let hexId: string | null = null;
      let wallet: string;
      let npub: string | null = null;

      const isWalletAddress = trimmed.startsWith('L') && trimmed.length >= 26 && trimmed.length <= 35;

      if (isWalletAddress) {
        wallet = trimmed;
        const userRes = await fetch(`/api/users/by-wallet/${encodeURIComponent(wallet)}`);
        const userData = await userRes.json();
        if (userData.user?.hex_id) {
          hexId = userData.user.hex_id;
          npub = userData.user.npub;
        } else {
          const checkRes = await fetch('/api/check-wallet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet_id: wallet }),
          });
          const checkData = await checkRes.json();
          if (checkData.wallet?.nostr_hex_id) {
            hexId = checkData.wallet.nostr_hex_id;
          }
        }
      } else {
        const ids = await convertWifToIds(trimmed);
        wallet = ids.walletId;
        hexId = ids.nostrHexId;
        npub = ids.nostrNpubId;
      }

      // Check registration
      let isRegistered = false;
      try {
        const regCheck = await fetch('/api/check-wallet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_id: wallet }),
        });
        const regData = await regCheck.json();
        isRegistered = regData.success && regData.registered;
        if (!hexId && regData.wallet?.nostr_hex_id) hexId = regData.wallet.nostr_hex_id;
      } catch {}

      if (!isRegistered) {
        setLookupError(t('regulars.walletNotRegistered'));
        setStep('list');
        setIsLookingUp(false);
        return;
      }

      if (!hexId) {
        setLookupError(t('regulars.lookupFailed'));
        setStep('list');
        setIsLookingUp(false);
        return;
      }

      setResolvedHexId(hexId);
      setResolvedWallet(wallet);
      setResolvedNpub(npub);

      try {
        const profileRes = await fetch('/api/profile-lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hex_id: hexId }),
        });
        const profileData = await profileRes.json();
        if (profileData.profile) {
          setResolvedName(profileData.profile.display_name || profileData.profile.name || null);
          setResolvedPicture(profileData.profile.picture || null);
        }
      } catch {}

      setStep('confirm');
    } catch {
      setLookupError(t('regulars.lookupFailed'));
      setStep('list');
    } finally {
      setIsLookingUp(false);
    }
  };

  // Save customer
  const handleSave = async () => {
    if (!addToUnitId || !staffHexId || !resolvedHexId || !resolvedWallet) return;

    setIsSaving(true);
    setSaveError(null);

    try {
      const res = await fetch('/api/regular-customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unit_id: addToUnitId,
          customer_hex_id: resolvedHexId,
          customer_wallet: resolvedWallet,
          customer_npub: resolvedNpub,
          display_name: resolvedName,
          picture: resolvedPicture,
          staff_hex: staffHexId,
          note: note.trim() || null,
        }),
      });
      const data = await res.json();

      if (data.success) {
        setStep('list');
        fetchCustomers();
      } else {
        setSaveError(data.error || t('regulars.lookupFailed'));
      }
    } catch {
      setSaveError(t('regulars.lookupFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  // Delete customer
  const handleDelete = async (unitId: string, customerHexId: string) => {
    if (!staffHexId) return;
    setDeletingId(customerHexId + unitId);
    try {
      await fetch(`/api/regular-customers/${unitId}/${customerHexId}?staff_hex=${staffHexId}`, { method: 'DELETE' });
      setCustomers(prev => prev.filter(c => !(c.customer_hex_id === customerHexId && c.unit_id === unitId)));
    } catch {} finally {
      setDeletingId(null);
    }
  };

  const inputClass = "w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary";

  // ─── Looking up after scan ───
  if (isLookingUp) {
    return (
      <div className="flex flex-col items-center gap-4 px-6 py-16">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">{t('regulars.lookingUp')}</p>
      </div>
    );
  }

  // ─── Confirm step ───
  if (step === 'confirm') {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <UserPlus className="w-7 h-7 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">{t('regulars.confirmTitle')}</h2>
            <p className="text-muted-foreground text-sm">{t('regulars.confirmSubtitle')}</p>
          </div>
        </div>

        {/* Customer card */}
        <div className="glass-card rounded-2xl p-5 space-y-4">
          <div className="flex items-center gap-4">
            {resolvedPicture ? (
              <img src={resolvedPicture} alt="" className="w-16 h-16 rounded-2xl object-cover shrink-0" />
            ) : (
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center shrink-0">
                <Users className="w-8 h-8 text-primary" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-lg font-bold text-foreground truncate">
                {resolvedName || t('regulars.unknownCustomer')}
              </p>
              {!resolvedName && (
                <p className="text-xs text-amber-600 dark:text-amber-400">{t('regulars.noProfileFound')}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <p className="text-xs text-muted-foreground">{t('regulars.wallet')}</p>
              <p className="text-xs font-mono text-foreground break-all">{resolvedWallet}</p>
            </div>
          </div>

          {/* Select which unit to add to */}
          {businessUnits.length > 1 && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">{t('regulars.addToShop')}</p>
              <select
                value={addToUnitId}
                onChange={e => setAddToUnitId(e.target.value)}
                className="w-full h-11 rounded-xl border border-border bg-background px-3 text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {businessUnits.map(u => (
                  <option key={u.unit_id} value={u.unit_id}>{u.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">{t('regulars.note')}</p>
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={t('regulars.notePlaceholder')}
              className={inputClass}
            />
          </div>
        </div>

        {saveError && (
          <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-3">
            <p className="text-xs text-destructive text-center">{saveError}</p>
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={isSaving || !addToUnitId}
          className="w-full rounded-xl bg-primary text-primary-foreground py-3.5 font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.98] transition-transform"
        >
          {isSaving ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> {t('regulars.saving')}</>
          ) : (
            <><UserPlus className="w-4 h-4" /> {t('regulars.saveCustomer')}</>
          )}
        </button>

        <button
          onClick={() => setStep('list')}
          className="text-sm text-muted-foreground text-center hover:text-foreground transition-colors"
        >
          {t('common.cancel')}
        </button>
      </div>
    );
  }

  // ─── List step (default) ───
  const filtered = searchQuery.trim()
    ? customers.filter(c =>
        (c.display_name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.customer_wallet.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (c.note || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (c.unit_name || '').toLowerCase().includes(searchQuery.toLowerCase())
      )
    : customers;

  return (
    <div className="flex flex-col gap-4 px-6 py-4">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
          <Users className="w-7 h-7 text-primary" />
        </div>
        <div className="flex-1">
          <h2 className="font-display text-xl font-bold text-foreground">{t('regulars.title')}</h2>
          <p className="text-muted-foreground text-sm">{t('regulars.subtitle')}</p>
        </div>
      </div>

      {/* Add button */}
      <button
        onClick={() => { setLookupError(null); setAddToUnitId(businessUnits[0]?.unit_id || ''); setScannerOpen(true); }}
        className="w-full rounded-xl bg-primary text-primary-foreground py-3.5 font-semibold text-sm flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
      >
        <UserPlus className="w-4 h-4" />
        {t('regulars.addCustomer')}
      </button>

      {/* Error from lookup */}
      {lookupError && (
        <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-3">
          <p className="text-xs text-destructive text-center">{lookupError}</p>
        </div>
      )}

      {/* Search (show when 3+ customers) */}
      {customers.length >= 3 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t('regulars.search')}
            className={inputClass + ' pl-9'}
          />
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12">
          <Users className="w-12 h-12 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">{t('regulars.empty')}</p>
          <p className="text-xs text-muted-foreground/60 text-center">{t('regulars.emptyHint')}</p>
        </div>
      ) : (
        /* Customer list — flat across all units */
        <div className="flex flex-col gap-2">
          {filtered.map(customer => {
            const bal = balances[customer.customer_hex_id];
            const hasWonder = wonderStatus[customer.customer_hex_id];
            const unitCur = businessUnits.find(u => u.unit_id === customer.unit_id)?.currency || 'EUR';
            const sym = CURRENCY_SYMBOL[unitCur] || '€';
            const missingFiat = bal ? Math.max(0, WONDER_THRESHOLD_FIAT - bal.fiatValue) : null;
            const missingLana = bal && bal.fiatValue < WONDER_THRESHOLD_FIAT && bal.lana > 0
              ? Math.ceil((WONDER_THRESHOLD_FIAT - bal.fiatValue) / (bal.fiatValue / bal.lana))
              : null;
            const delKey = customer.customer_hex_id + customer.unit_id;

            return (
              <div key={delKey} className="rounded-2xl bg-card border border-border p-4 space-y-3">
                {/* Top row: avatar + name + shop badge + delete */}
                <div className="flex items-center gap-3">
                  {customer.picture ? (
                    <img src={customer.picture} alt="" className="w-11 h-11 rounded-xl object-cover shrink-0" />
                  ) : (
                    <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                      <Users className="w-5 h-5 text-primary" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">
                      {customer.display_name || t('regulars.unknownCustomer')}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Store className="w-3 h-3 text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground truncate">{customer.unit_name}</span>
                    </div>
                    {customer.note && (
                      <p className="text-xs text-primary/70 truncate">{customer.note}</p>
                    )}
                  </div>
                  <button
                    onClick={() => handleDelete(customer.unit_id, customer.customer_hex_id)}
                    disabled={deletingId === delKey}
                    className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                  >
                    {deletingId === delKey ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  </button>
                </div>

                {/* Balance row */}
                {bal ? (
                  <div className="flex items-center justify-between px-1">
                    <p className="text-lg font-black text-foreground">{bal.lana.toLocaleString()} <span className="text-xs font-normal text-muted-foreground">LANA</span></p>
                    <p className="text-lg font-bold text-primary">{sym}{bal.fiatValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-1">
                    <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">{t('regulars.loadingBalance')}</span>
                  </div>
                )}

                {/* Lana8Wonder status */}
                {hasWonder === true ? (
                  <div className="flex items-center gap-2 rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2">
                    <Sparkles className="w-4 h-4 text-amber-500 shrink-0" />
                    <span className="text-xs font-medium text-amber-700 dark:text-amber-400">{t('regulars.wonderActive')}</span>
                  </div>
                ) : hasWonder === false && bal ? (
                  bal.fiatValue >= WONDER_THRESHOLD_FIAT ? (
                    <div className="flex items-center gap-2 rounded-xl bg-green-500/10 border border-green-500/20 px-3 py-2">
                      <Sparkles className="w-4 h-4 text-green-500 shrink-0" />
                      <span className="text-xs font-medium text-green-700 dark:text-green-400">{t('regulars.wonderEligible')}</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2">
                      <TrendingUp className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground">
                        {t('regulars.wonderMissing', {
                          fiat: `${sym}${missingFiat?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                          lana: missingLana?.toLocaleString() || '?'
                        })}
                      </span>
                    </div>
                  )
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* QR Scanner */}
      <QRScanner
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={handleScan}
        title={t('regulars.scanTitle')}
        description={t('regulars.scanDescription')}
      />
    </div>
  );
};

export default RegularCustomersTab;
