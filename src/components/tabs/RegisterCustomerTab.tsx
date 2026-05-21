import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanLine, KeyRound, Loader2, CheckCircle2, AlertCircle, UserPlus, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { QRScanner } from '@/components/QRScanner';
import { convertWifToIds } from '@/lib/crypto';
import { createAndSignKind0, type Kind0Content } from '@/lib/nostr-sign';
import { useAuth } from '@/contexts/AuthContext';

interface RegisterCustomerTabProps {
  /** Currency of the seller's currently selected shop — used for the new KIND 0 */
  unitCurrency?: string;
}

type Step = 'scan' | 'checking' | 'already_registered' | 'form' | 'submitting' | 'done';

interface DerivedIds {
  walletId: string;
  nostrHexId: string;
  nostrNpubId: string;
  privateKeyHex: string;
}

const RegisterCustomerTab = ({ unitCurrency }: RegisterCustomerTabProps) => {
  const { t, i18n } = useTranslation();
  const { session } = useAuth();

  const [step, setStep]                     = useState<Step>('scan');
  const [scannerOpen, setScannerOpen]       = useState(false);
  const [manualWif, setManualWif]           = useState('');
  const [derived, setDerived]               = useState<DerivedIds | null>(null);
  const [fullName, setFullName]             = useState('');
  const [error, setError]                   = useState<string | null>(null);

  // Registry → tells us whether this wallet is already in the Lana Register.
  // If it IS, we BLOCK — this page is only for fresh wallets.
  const handleWifSubmit = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    setError(null);
    setStep('checking');

    try {
      const ids = await convertWifToIds(trimmed);
      // convertWifToIds returns several extra fields (walletIdCompressed/Uncompressed/isCompressed) — pick only what we need.
      setDerived({
        walletId: ids.walletId,
        nostrHexId: ids.nostrHexId,
        nostrNpubId: ids.nostrNpubId,
        privateKeyHex: ids.privateKeyHex,
      });

      const res = await fetch('/api/check-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_id: ids.walletId }),
      });
      const data = await res.json();

      if (data.success && data.registered) {
        // If the registrar reports this wallet linked to a DIFFERENT primary
        // identity than this WIF derives, surface the differentiated message
        // — that hints to the seller that this is a secondary wallet of an
        // existing customer and they should use the customer's primary WIF
        // instead. If it matches (same identity re-scanning), the generic
        // "already registered" message is enough.
        if (data.wallet?.nostr_hex_id && data.wallet.nostr_hex_id !== ids.nostrHexId) {
          setError(t('registerCustomer.alreadyLinkedDifferentIdentity'));
        }
        setStep('already_registered');
      } else {
        setStep('form');
      }
    } catch (err: any) {
      setError(err.message || t('registerCustomer.lookupFailed'));
      setStep('scan');
    }
  };

  const handleRegister = async () => {
    if (!derived || !fullName.trim()) return;

    setError(null);
    setStep('submitting');

    try {
      // Defensive re-check: between scan-time and submit the wallet could
      // have been registered (race window or user backing through tabs).
      // If the registrar now reports it registered under a DIFFERENT
      // primary nostr_hex_id than this WIF derives, we must NOT publish a
      // new KIND 0 — that would silently overwrite an existing customer
      // identity with the seller-supplied name. Bail out instead and tell
      // the seller to use the customer's primary WIF.
      try {
        const recheck = await fetch('/api/check-wallet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_id: derived.walletId }),
        });
        const recheckData = await recheck.json();
        if (
          recheckData?.success &&
          recheckData?.registered &&
          recheckData?.wallet?.nostr_hex_id &&
          recheckData.wallet.nostr_hex_id !== derived.nostrHexId
        ) {
          setError(t('registerCustomer.alreadyLinkedDifferentIdentity'));
          setStep('already_registered');
          return;
        }
      } catch {
        // If the recheck itself fails, fall through — original scan-time
        // check already confirmed the wallet was not registered.
      }

      // 1. Build + sign + broadcast KIND 0 with the customer's private key.
      //    Only the name is user-supplied; everything else is auto from the
      //    seller context — same approach as Cash payment registration.
      const kind0: Kind0Content = {
        name: fullName.trim(),
        display_name: fullName.trim(),
        about: 'LanaPays.Us customer',
        location: '',
        country: '',
        currency: unitCurrency || session?.currency || 'EUR',
        lanoshi2lash: '10000',
        lanaWalletID: derived.walletId,
        whoAreYou: 'Human',
        orgasmic_profile: 'Living life',
        statement_of_responsibility:
          'I accept full and unconditional self-responsibility for everything I do or do not do inside the Lana World.',
      };
      const tags: string[][] = [['lang', i18n.language || 'en']];
      const signed = createAndSignKind0(derived.privateKeyHex, kind0, tags);

      const broadcast = await fetch('/api/broadcast-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: signed }),
      });
      const bData = await broadcast.json();
      if (!bData.success || !bData.success.length) {
        throw new Error(t('registerCustomer.broadcastFailed'));
      }

      // 2. Register with the Lana Register service
      const reg = await fetch('/api/register/wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_id: derived.walletId,
          nostr_id_hex: derived.nostrHexId,
        }),
      });
      const rData = await reg.json();
      if (!reg.ok || (rData.status === 'rejected')) {
        throw new Error(rData.message || rData.error || t('registerCustomer.registrationFailed'));
      }

      // 3. Best-effort local user record (non-critical — same as Cash flow)
      try {
        await fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hex_id: derived.nostrHexId,
            npub: derived.nostrNpubId,
            lana_address: derived.walletId,
            display_name: fullName.trim(),
            picture: null,
          }),
        });
      } catch {}

      setStep('done');
    } catch (err: any) {
      setError(err.message || t('registerCustomer.registrationFailed'));
      setStep('form');
    }
  };

  const reset = () => {
    setStep('scan');
    setManualWif('');
    setDerived(null);
    setFullName('');
    setError(null);
  };

  // ─── STEP: scan WIF ────────────────────────────────────────────
  if (step === 'scan') {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <UserPlus className="w-7 h-7 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">{t('registerCustomer.title')}</h2>
            <p className="text-muted-foreground text-sm">{t('registerCustomer.subtitle')}</p>
          </div>
        </div>

        {/* Explanation card — appears in the user's language */}
        <div className="rounded-2xl bg-primary/5 border border-primary/20 p-4 flex gap-3">
          <Info className="w-5 h-5 text-primary shrink-0 mt-0.5" />
          <p className="text-sm text-foreground/80 leading-relaxed">
            {t('registerCustomer.explanation')}
          </p>
        </div>

        {error && (
          <div className="rounded-xl bg-destructive/10 border border-destructive/20 p-3">
            <p className="text-sm text-destructive text-center">{error}</p>
          </div>
        )}

        <Button
          onClick={() => setScannerOpen(true)}
          className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
        >
          <ScanLine className="w-5 h-5" />
          {t('registerCustomer.scanWifKey')}
        </Button>

        {/* Optional manual paste */}
        <div className="space-y-2">
          <Label htmlFor="wif-paste" className="text-xs text-muted-foreground">
            {t('registerCustomer.orPasteWif')}
          </Label>
          <Input
            id="wif-paste"
            type="password"
            placeholder={t('registerCustomer.wifPlaceholder')}
            value={manualWif}
            onChange={e => setManualWif(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && manualWif.trim()) handleWifSubmit(manualWif); }}
            className="font-mono text-xs"
          />
          {manualWif.trim() && (
            <Button
              onClick={() => handleWifSubmit(manualWif)}
              variant="outline"
              className="w-full h-11 rounded-xl text-sm font-medium gap-2"
            >
              <KeyRound className="w-4 h-4" />
              {t('registerCustomer.checkWallet')}
            </Button>
          )}
        </div>

        <QRScanner
          isOpen={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onScan={(value) => { setScannerOpen(false); handleWifSubmit(value); }}
          title={t('registerCustomer.scanTitle')}
          description={t('registerCustomer.scanDescription')}
        />
      </div>
    );
  }

  // ─── STEP: checking ─────────────────────────────────────────────
  if (step === 'checking') {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-16">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">{t('registerCustomer.checking')}</p>
      </div>
    );
  }

  // ─── STEP: already registered (block — page is only for new wallets) ─
  if (step === 'already_registered') {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-amber-100 dark:bg-amber-500/10 flex items-center justify-center shrink-0">
            <AlertCircle className="w-7 h-7 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">{t('registerCustomer.alreadyRegisteredTitle')}</h2>
            <p className="text-muted-foreground text-sm">{t('registerCustomer.alreadyRegisteredSubtitle')}</p>
          </div>
        </div>

        <div className="rounded-2xl bg-amber-50 dark:bg-amber-500/5 border border-amber-200 dark:border-amber-500/20 p-4">
          <p className="text-sm text-amber-700 dark:text-amber-400 leading-relaxed">
            {error || t('registerCustomer.alreadyRegisteredMessage')}
          </p>
        </div>

        <div className="rounded-xl bg-card border border-border p-3">
          <p className="text-xs text-muted-foreground mb-1">{t('registerCustomer.walletLabel')}</p>
          <p className="text-xs font-mono text-foreground break-all">{derived?.walletId}</p>
        </div>

        <Button onClick={reset} variant="outline" className="w-full h-12 rounded-xl text-sm font-medium">
          {t('registerCustomer.tryAnotherWallet')}
        </Button>
      </div>
    );
  }

  // ─── STEP: name form ────────────────────────────────────────────
  if (step === 'form') {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <UserPlus className="w-7 h-7 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">{t('registerCustomer.formTitle')}</h2>
            <p className="text-muted-foreground text-sm">{t('registerCustomer.formSubtitle')}</p>
          </div>
        </div>

        <div className="rounded-xl bg-card border border-border p-3">
          <p className="text-xs text-muted-foreground mb-1">{t('registerCustomer.walletLabel')}</p>
          <p className="text-xs font-mono text-foreground break-all">{derived?.walletId}</p>
        </div>

        {error && (
          <div className="rounded-xl bg-destructive/10 border border-destructive/20 p-3">
            <p className="text-sm text-destructive text-center">{error}</p>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="full-name" className="text-sm font-medium">
            {t('registerCustomer.fullNameLabel')}
          </Label>
          <Input
            id="full-name"
            autoFocus
            value={fullName}
            onChange={e => setFullName(e.target.value)}
            placeholder={t('registerCustomer.fullNamePlaceholder')}
            className="h-12 rounded-xl"
          />
          <p className="text-[11px] text-muted-foreground/70">{t('registerCustomer.fullNameHint')}</p>
        </div>

        <Button
          onClick={handleRegister}
          disabled={!fullName.trim()}
          className="w-full h-14 rounded-2xl text-base font-semibold gap-2 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 disabled:opacity-50"
        >
          <UserPlus className="w-5 h-5" />
          {t('registerCustomer.registerButton')}
        </Button>

        <button onClick={reset} className="text-xs text-muted-foreground text-center hover:text-foreground transition-colors">
          {t('common.cancel')}
        </button>
      </div>
    );
  }

  // ─── STEP: submitting ──────────────────────────────────────────
  if (step === 'submitting') {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-16">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">{t('registerCustomer.submitting')}</p>
      </div>
    );
  }

  // ─── STEP: done ────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-5 px-6 py-8">
      <div className="flex flex-col items-center gap-3">
        <div className="w-20 h-20 rounded-full bg-emerald-100 dark:bg-emerald-500/10 flex items-center justify-center">
          <CheckCircle2 className="w-12 h-12 text-emerald-600 dark:text-emerald-400" />
        </div>
        <div className="text-center space-y-1">
          <h2 className="font-display text-2xl font-bold text-foreground">{t('registerCustomer.doneTitle')}</h2>
          <p className="text-muted-foreground text-sm max-w-[280px]">{t('registerCustomer.doneSubtitle', { name: fullName.trim() })}</p>
        </div>
      </div>

      <div className="rounded-xl bg-card border border-border p-3">
        <p className="text-xs text-muted-foreground mb-1">{t('registerCustomer.walletLabel')}</p>
        <p className="text-xs font-mono text-foreground break-all">{derived?.walletId}</p>
      </div>

      <Button onClick={reset} className="w-full h-12 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90">
        {t('registerCustomer.registerAnother')}
      </Button>
    </div>
  );
};

export default RegisterCustomerTab;
