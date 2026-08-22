import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, UserPlus, Loader2, Trash2, Search, Store, Sparkles, TrendingUp, Snowflake, AlertTriangle, ExternalLink, ScanLine, X } from 'lucide-react';
import { QRScanner } from '@/components/QRScanner';
import { convertWifToIds } from '@/lib/crypto';

interface SearchProfile {
  pubkey: string;
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
  location?: string;
  lanaWalletID?: string;
}

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
  currency?: string;
}

interface BusinessUnitOption {
  unit_id: string;
  name: string;
  image?: string;
  currency?: string;
  owner_hex?: string;
}

/** One row of GET /api/customers-status — null means "we could not establish it". */
interface CustomerStatus {
  balance: CustomerBalance | null;
  enrolled: boolean | null;
  freeze: string | null;
  wallets: CustomerWallet[];
}

interface CustomerWallet {
  wallet_id?: string;
  walletType?: string;
  frozen?: boolean;
}

interface CustomerBalance {
  lana: number;
  fiatValue: number;
  currency: string;
}

const CURRENCY_SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
const WONDER_THRESHOLD_FIAT = 100;
const MAX_CAP_LANA = 1500; // Above this, account will be frozen at next split

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

  // Regulars are owner-scoped, so the "add to" picker only needs to choose the
  // MERCHANT (owner). Collapse the per-shop list to one option per owner (a
  // representative shop); the picker is hidden entirely when there is one owner.
  const ownerOptions = useMemo(() => {
    const byOwner = new Map<string, BusinessUnitOption[]>();
    for (const u of businessUnits) {
      const key = u.owner_hex || u.unit_id;
      const arr = byOwner.get(key);
      if (arr) arr.push(u); else byOwner.set(key, [u]);
    }
    return [...byOwner.values()].map(shops => ({
      unitId: shops[0].unit_id,
      label: shops.length > 1 ? `${shops[0].name} (+${shops.length - 1})` : shops[0].name,
    }));
  }, [businessUnits]);

  // Keep the selected "add to" unit valid (a representative of one owner option).
  useEffect(() => {
    if (ownerOptions.length && !ownerOptions.some(o => o.unitId === addToUnitId)) {
      setAddToUnitId(ownerOptions[0].unitId);
    }
  }, [ownerOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scan result state
  const [scannerOpen, setScannerOpen] = useState(false);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Profile search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [profileQuery, setProfileQuery] = useState('');
  const [profileResults, setProfileResults] = useState<SearchProfile[]>([]);
  const [searching, setSearching] = useState(false);

  // Confirm state
  const [resolvedHexId, setResolvedHexId] = useState<string | null>(null);
  const [resolvedWallet, setResolvedWallet] = useState<string | null>(null);
  const [resolvedNpub, setResolvedNpub] = useState<string | null>(null);
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [resolvedPicture, setResolvedPicture] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Balance + Lana8Wonder + freeze status
  const [balances, setBalances] = useState<Record<string, CustomerBalance>>({});
  const [wonderStatus, setWonderStatus] = useState<Record<string, boolean>>({});
  const [freezeStatus, setFreezeStatus] = useState<Record<string, string>>({}); // hex -> 'active' | 'frozen'
  // hex → list of wallets from /api/wallets. Lets us resolve walletType for
  // the SPECIFIC wallet stored on each regular_customers row (same hex can
  // appear with different wallets across units). Retail wallets are exempt
  // from the 1500 LANA freeze rule — we use this map at render time so the
  // warning hides only for the row whose scanned wallet IS Retail, while
  // other rows for the same customer with a Main/etc wallet keep the warning.
  const [walletsByHex, setWalletsByHex] = useState<Record<string, any[]>>({});

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

  // Balance + Lana8Wonder + freeze for the WHOLE list, in ONE request.
  //
  // This used to be three fetches per customer (/api/balance, /api/lana8wonder,
  // /api/wallets), and the effect keyed on `businessUnits` — a fresh array on
  // every parent render — so it re-fired about once a minute. At ~150 regulars
  // that is ~470 requests a minute against a 1500/15min budget: the merchant
  // rate-limited herself out of her own app (429 on login, white screen on the
  // JS bundle). The server now fans out instead, cached and capped.
  //
  // Keyed on the customer ids, so it runs when the LIST changes — not when the
  // parent happens to re-render.
  const customerKey = useMemo(
    () => customers.map(c => c.customer_hex_id).join(','),
    [customers]
  );

  useEffect(() => {
    if (!staffHexId || customers.length === 0) return;
    let cancelled = false;

    fetch(`/api/customers-status?staff_hex=${staffHexId}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        const statuses: Record<string, CustomerStatus> = data.statuses || {};
        const nextBalances: Record<string, CustomerBalance> = {};
        const nextWonder: Record<string, boolean> = {};
        const nextFreeze: Record<string, string> = {};
        const nextWallets: Record<string, CustomerWallet[]> = {};

        Object.entries(statuses).forEach(([hex, st]) => {
          // Anything the server could not establish comes back null — leave the
          // previous value in place rather than showing a confident wrong one
          // (no zero balances, no "not frozen" from a dead upstream).
          if (st.balance) nextBalances[hex] = st.balance;
          if (st.enrolled !== null && st.enrolled !== undefined) nextWonder[hex] = st.enrolled === true;
          if (st.freeze) nextFreeze[hex] = st.freeze;
          if (st.wallets) nextWallets[hex] = st.wallets;
        });

        setBalances(prev => ({ ...prev, ...nextBalances }));
        setWonderStatus(prev => ({ ...prev, ...nextWonder }));
        setFreezeStatus(prev => ({ ...prev, ...nextFreeze }));
        setWalletsByHex(prev => ({ ...prev, ...nextWallets }));
      })
      .catch(() => { /* keep whatever is already on screen */ });

    return () => { cancelled = true; };
  }, [staffHexId, customerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Profile search — debounced lookup against mejmoSeFajn Lana Transparency
  useEffect(() => {
    if (!searchOpen) return;
    const q = profileQuery.trim();
    if (q.length < 2) {
      setProfileResults([]);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const r = await fetch('/api/profile-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ search: q }),
        });
        const data = await r.json();
        setProfileResults(data.profiles || []);
      } catch {
        setProfileResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [profileQuery, searchOpen]);

  // Pick a profile from search results → jump straight to confirm step
  const handlePickProfile = (profile: SearchProfile) => {
    if (!profile.lanaWalletID || !profile.pubkey) return;
    setSearchOpen(false);
    setProfileQuery('');
    setProfileResults([]);
    setLookupError(null);
    setResolvedHexId(profile.pubkey);
    setResolvedWallet(profile.lanaWalletID);
    setResolvedNpub(null);
    setResolvedName(profile.name || profile.display_name || null);
    setResolvedPicture(profile.picture || null);
    setNote('');
    setStep('confirm');
  };

  // Handle QR scan result.
  //
  // A user can have multiple wallets but only their MAIN wallet carries the
  // Nostr hex ID that publishes KIND 0. Other wallets don't. So we must NOT
  // trust the locally-derived hex (from a WIF scan) or a stale `users` lookup
  // — the Lana Register service is the source of truth and returns the
  // owner's main nostr_hex_id for any of their wallets. We always go through
  // /api/check-wallet and use wallet.nostr_hex_id from that response so the
  // KIND 0 profile (and therefore the customer name + picture) always loads.
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
      // Step 1: derive the wallet address (from a Lana wallet QR or WIF QR)
      let wallet: string;
      const isWalletAddress = trimmed.startsWith('L') && trimmed.length >= 26 && trimmed.length <= 35;
      if (isWalletAddress) {
        wallet = trimmed;
      } else {
        const ids = await convertWifToIds(trimmed);
        wallet = ids.walletId;
      }

      // Step 2: check the registry — this gives us the OWNER's main nostr_hex_id
      // (the one with KIND 0), even if `wallet` is a secondary wallet of theirs.
      const regCheck = await fetch('/api/check-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_id: wallet }),
      });
      const regData = await regCheck.json();
      const isRegistered = regData.success && regData.registered;

      if (!isRegistered) {
        setLookupError(t('regulars.walletNotRegistered'));
        setStep('list');
        setIsLookingUp(false);
        return;
      }

      const mainHexId: string | null = regData.wallet?.nostr_hex_id || null;
      if (!mainHexId) {
        setLookupError(t('regulars.lookupFailed'));
        setStep('list');
        setIsLookingUp(false);
        return;
      }

      setResolvedHexId(mainHexId);
      setResolvedWallet(wallet);
      // We deliberately don't carry the WIF-derived npub here — it would belong
      // to the scanned wallet, not the main identity. The server can derive
      // npub from mainHexId on its own when displaying the customer.
      setResolvedNpub(null);

      // Step 3: fetch KIND 0 profile via the MAIN hex — name + picture always load
      try {
        const profileRes = await fetch('/api/profile-lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hex_id: mainHexId }),
        });
        const profileData = await profileRes.json();
        if (profileData.profile) {
          setResolvedName(profileData.profile.name || profileData.profile.display_name || null);
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
      // The list is deduped per person and the server clears them across the
      // operator's merchants, so drop every row for this customer.
      setCustomers(prev => prev.filter(c => c.customer_hex_id !== customerHexId));
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

          {/* Choose which MERCHANT (owner) to add to — only when the operator has
              shops of more than one owner. With a single owner there's nothing to
              choose (regulars are shared across all that owner's shops). */}
          {ownerOptions.length > 1 && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">{t('regulars.addToShop')}</p>
              <select
                value={addToUnitId}
                onChange={e => setAddToUnitId(e.target.value)}
                className="w-full h-11 rounded-xl border border-border bg-background px-3 text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {ownerOptions.map(o => (
                  <option key={o.unitId} value={o.unitId}>{o.label}</option>
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
          <p className="text-xs text-primary/80 mt-1 flex items-center gap-1">
            <Store className="w-3 h-3 shrink-0" />
            {t('regulars.sharedHint')}
          </p>
        </div>
      </div>

      {/* Add buttons — Scan QR + Search profile */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => { setLookupError(null); setAddToUnitId(businessUnits[0]?.unit_id || ''); setScannerOpen(true); }}
          className="rounded-xl bg-primary text-primary-foreground py-3.5 font-semibold text-sm flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
        >
          <ScanLine className="w-4 h-4" />
          {t('regulars.addByScan')}
        </button>
        <button
          onClick={() => { setLookupError(null); setAddToUnitId(businessUnits[0]?.unit_id || ''); setProfileQuery(''); setProfileResults([]); setSearchOpen(true); }}
          className="rounded-xl border-2 border-primary text-primary bg-primary/5 py-3.5 font-semibold text-sm flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
        >
          <Search className="w-4 h-4" />
          {t('regulars.addBySearch')}
        </button>
      </div>

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
            const unitCur = customer.currency || businessUnits.find(u => u.unit_id === customer.unit_id)?.currency || 'EUR';
            const sym = CURRENCY_SYMBOL[unitCur] || '€';
            const missingFiat = bal ? Math.max(0, WONDER_THRESHOLD_FIAT - bal.fiatValue) : null;
            const missingLana = bal && bal.fiatValue < WONDER_THRESHOLD_FIAT && bal.lana > 0
              ? Math.ceil((WONDER_THRESHOLD_FIAT - bal.fiatValue) / (bal.fiatValue / bal.lana))
              : null;
            const delKey = customer.customer_hex_id + customer.unit_id;
            const isFrozen = freezeStatus[customer.customer_hex_id] === 'frozen';
            // Resolve the type of the WALLET that was actually scanned/saved
            // on this regular_customers row (not just any wallet on the hex).
            // Only when that specific wallet is Retail do we suppress the cap
            // warning — Main / standard wallets keep the warning as before.
            const scannedWallet = (walletsByHex[customer.customer_hex_id] || [])
              .find((w: any) => w.walletId === customer.customer_wallet);
            const isScannedRetail =
              !!scannedWallet && typeof scannedWallet.walletType === 'string'
                && scannedWallet.walletType.toLowerCase() === 'retail';
            const isNearMaxCap = bal && bal.lana > MAX_CAP_LANA && !isFrozen && !isScannedRetail;

            return (
              <div key={delKey} className={`rounded-2xl p-4 space-y-3 ${
                isFrozen
                  ? 'bg-blue-50 dark:bg-blue-950/30 border-2 border-blue-300 dark:border-blue-700'
                  : 'bg-card border border-border'
              }`}>
                {/* Frozen banner — takes priority */}
                {isFrozen && (
                  <div className="rounded-xl bg-blue-100 dark:bg-blue-900/40 border border-blue-200 dark:border-blue-800 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Snowflake className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0" />
                      <span className="text-sm font-bold text-blue-700 dark:text-blue-300">{t('regulars.frozenTitle')}</span>
                    </div>
                    <p className="text-xs text-blue-600 dark:text-blue-400">{t('regulars.frozenMessage')}</p>
                    <a
                      href="https://youtu.be/0DHEQriOXjw"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-xs font-medium text-blue-700 dark:text-blue-300 underline"
                    >
                      <ExternalLink className="w-3 h-3" />
                      {t('regulars.frozenVideoLink')}
                    </a>
                  </div>
                )}

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

                {/* Max cap warning — near limit, needs to spend */}
                {isNearMaxCap && (
                  <div className="rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                      <span className="text-xs font-bold text-amber-700 dark:text-amber-400">{t('regulars.maxCapWarning')}</span>
                    </div>
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {hasWonder
                        ? t('regulars.maxCapMessageWonder', { lana: MAX_CAP_LANA.toLocaleString() })
                        : t('regulars.maxCapMessage', { lana: MAX_CAP_LANA.toLocaleString() })}
                    </p>
                    {!hasWonder && (
                      <a
                        href="https://www.lana8wonder.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 underline"
                      >
                        <Sparkles className="w-3 h-3" />
                        {t('regulars.wonderEnrollLink')}
                      </a>
                    )}
                  </div>
                )}
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

      {/* Profile Search Drawer */}
      {searchOpen && (
        <>
          <div className="fixed inset-0 bg-foreground/30 backdrop-blur-sm z-[80]" onClick={() => setSearchOpen(false)} />
          <div className="fixed inset-x-3 top-3 bottom-3 z-[90] bg-card rounded-2xl border border-border shadow-xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
              <div>
                <h2 className="font-display font-bold text-foreground text-base">{t('regulars.searchTitle')}</h2>
                <p className="text-xs text-muted-foreground">{t('regulars.searchSubtitle')}</p>
              </div>
              <button onClick={() => setSearchOpen(false)} className="w-9 h-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 border-b border-border shrink-0">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  autoFocus
                  value={profileQuery}
                  onChange={e => setProfileQuery(e.target.value)}
                  placeholder={t('regulars.searchPlaceholder')}
                  className={inputClass + ' pl-9'}
                />
              </div>
              <p className="text-[11px] text-muted-foreground/70 mt-2">{t('regulars.searchHint')}</p>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {searching ? (
                <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">{t('regulars.searching')}</span>
                </div>
              ) : profileQuery.trim().length < 2 ? (
                <div className="py-12 text-center text-xs text-muted-foreground/60 px-4">
                  {t('regulars.searchPlaceholder')}
                </div>
              ) : profileResults.length === 0 ? (
                <div className="py-12 text-center text-xs text-muted-foreground/60 px-4">
                  {t('regulars.searchEmpty')}
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {profileResults.map(p => (
                    <button
                      key={p.pubkey}
                      onClick={() => handlePickProfile(p)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-secondary active:scale-[0.99] transition-all text-left"
                    >
                      {p.picture ? (
                        <img src={p.picture} alt="" className="w-10 h-10 rounded-xl object-cover shrink-0" />
                      ) : (
                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                          <Users className="w-5 h-5 text-primary" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">
                          {p.name || p.display_name || t('regulars.unknownCustomer')}
                          {p.name && p.display_name && p.name !== p.display_name && (
                            <span className="ml-1.5 text-xs font-normal text-muted-foreground">@{p.name}</span>
                          )}
                        </p>
                        {p.location && (
                          <p className="text-xs text-muted-foreground truncate">📍 {p.location}</p>
                        )}
                        <p className="text-[10px] font-mono text-muted-foreground/70 truncate">
                          {p.lanaWalletID}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default RegularCustomersTab;
