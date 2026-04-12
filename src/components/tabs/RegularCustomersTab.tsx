import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, UserPlus, Loader2, Trash2, Search, Store } from 'lucide-react';
import { QRScanner } from '@/components/QRScanner';
import { convertWifToIds } from '@/lib/crypto';

interface RegularCustomer {
  id: number;
  unit_id: string;
  customer_hex_id: string;
  customer_wallet: string;
  customer_npub: string | null;
  display_name: string | null;
  picture: string | null;
  added_by_hex: string;
  note: string | null;
  created_at: string;
}

interface RegularCustomersTabProps {
  unitId?: string;
  staffHexId?: string;
}

type Step = 'list' | 'scanning' | 'confirm';

const RegularCustomersTab = ({ unitId, staffHexId }: RegularCustomersTabProps) => {
  const { t } = useTranslation();

  const [step, setStep] = useState<Step>('list');
  const [customers, setCustomers] = useState<RegularCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

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

  // Delete state
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Fetch customers
  const fetchCustomers = async () => {
    if (!unitId || !staffHexId) { setLoading(false); return; }
    try {
      const res = await fetch(`/api/regular-customers/${unitId}?staff_hex=${staffHexId}`);
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
  }, [unitId, staffHexId]);

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

        // Try local user lookup first
        const userRes = await fetch(`/api/users/by-wallet/${encodeURIComponent(wallet)}`);
        const userData = await userRes.json();

        if (userData.user?.hex_id) {
          hexId = userData.user.hex_id;
          npub = userData.user.npub;
        } else {
          // Try check-wallet API for registration data
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
        // WIF private key — derive all IDs
        const ids = await convertWifToIds(trimmed);
        wallet = ids.walletId;
        hexId = ids.nostrHexId;
        npub = ids.nostrNpubId;
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

      // Fetch KIND 0 profile for name and picture
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
      } catch {} // profile lookup is best-effort

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
    if (!unitId || !staffHexId || !resolvedHexId || !resolvedWallet) return;

    setIsSaving(true);
    setSaveError(null);

    try {
      const res = await fetch('/api/regular-customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unit_id: unitId,
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
  const handleDelete = async (customerHexId: string) => {
    if (!unitId || !staffHexId) return;
    setDeletingId(customerHexId);
    try {
      await fetch(`/api/regular-customers/${unitId}/${customerHexId}?staff_hex=${staffHexId}`, { method: 'DELETE' });
      setCustomers(prev => prev.filter(c => c.customer_hex_id !== customerHexId));
    } catch {} finally {
      setDeletingId(null);
    }
  };

  const inputClass = "w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary";

  // ─── No shop selected ───
  if (!unitId) {
    return (
      <div className="flex flex-col items-center gap-4 px-6 py-16">
        <Store className="w-12 h-12 text-muted-foreground" />
        <p className="text-sm text-muted-foreground text-center">{t('regulars.noShopSelected')}</p>
      </div>
    );
  }

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
            <div>
              <p className="text-xs text-muted-foreground">{t('regulars.hexId')}</p>
              <p className="text-xs font-mono text-foreground break-all">{resolvedHexId}</p>
            </div>
          </div>

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
          disabled={isSaving}
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
        (c.note || '').toLowerCase().includes(searchQuery.toLowerCase())
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
        onClick={() => { setLookupError(null); setScannerOpen(true); }}
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
        /* Empty state */
        <div className="flex flex-col items-center gap-3 py-12">
          <Users className="w-12 h-12 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">{t('regulars.empty')}</p>
          <p className="text-xs text-muted-foreground/60 text-center">{t('regulars.emptyHint')}</p>
        </div>
      ) : (
        /* Customer list */
        <div className="flex flex-col gap-2">
          {filtered.map(customer => (
            <div
              key={customer.customer_hex_id}
              className="rounded-2xl bg-card border border-border p-4 flex items-center gap-3"
            >
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
                <p className="text-xs text-muted-foreground font-mono truncate">
                  {customer.customer_wallet}
                </p>
                {customer.note && (
                  <p className="text-xs text-primary/70 mt-0.5 truncate">{customer.note}</p>
                )}
              </div>
              <button
                onClick={() => handleDelete(customer.customer_hex_id)}
                disabled={deletingId === customer.customer_hex_id}
                className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
              >
                {deletingId === customer.customer_hex_id ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
              </button>
            </div>
          ))}
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
