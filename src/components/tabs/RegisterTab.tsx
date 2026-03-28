import { useState } from "react";
import { useTranslation } from 'react-i18next';
import { ScanLine, KeyRound, Loader2, CheckCircle, XCircle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { convertWifToIds } from "@/lib/crypto";
import { signNostrEvent, publishToRelays } from "@/lib/nostrSigning";
import QRScanner from "@/components/QRScanner";

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'sl', name: 'Slovenščina' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'it', name: 'Italiano' },
  { code: 'hr', name: 'Hrvatski' },
  { code: 'sr', name: 'Srpski' },
  { code: 'bs', name: 'Bosanski' },
  { code: 'pl', name: 'Polski' },
  { code: 'cs', name: 'Čeština' },
  { code: 'tr', name: 'Türkçe' },
];

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'PLN', 'CZK', 'HRK', 'RSD', 'TRY'];

interface DerivedIds {
  walletId: string;
  nostrHexId: string;
  nostrNpubId: string;
  nostrPrivateKey: string;
}

const RegisterTab = () => {
  const { t } = useTranslation();
  const [step, setStep] = useState<'scan' | 'checking' | 'registered' | 'form' | 'publishing' | 'done'>('scan');
  const [showScanner, setShowScanner] = useState(false);
  const [wif, setWif] = useState('');
  const [derivedIds, setDerivedIds] = useState<DerivedIds | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState('');

  const [form, setForm] = useState({
    name: '', display_name: '', about: '', location: '', country: '',
    currency: 'EUR', language: 'en', orgasmic_profile: '', statement_of_responsibility: '',
  });

  const handleWifSubmit = async (wifInput: string) => {
    const trimmed = wifInput.trim();
    if (!trimmed) return;
    setWif(trimmed);
    setStep('checking');
    setError(null);

    try {
      const ids = await convertWifToIds(trimmed);
      setDerivedIds(ids);

      // Check registration
      const res = await fetch('/api/check-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_id: ids.walletId }),
      });
      const data = await res.json();

      if (data.registered) {
        setStep('registered');
      } else {
        setStep('form');
      }
    } catch (err: any) {
      setError(err.message || t('register.failedToCheck'));
      setStep('scan');
    }
  };

  const handlePublish = async () => {
    if (!derivedIds) return;

    const required = ['name', 'display_name', 'about', 'location', 'country', 'orgasmic_profile', 'statement_of_responsibility'];
    for (const key of required) {
      if (!(form as any)[key]?.trim()) {
        setError(t('register.fieldRequired', { field: key.replace(/_/g, ' ') }));
        return;
      }
    }
    if (form.country.length !== 2) {
      setError(t('register.countryCodeError'));
      return;
    }

    setStep('publishing');
    setError(null);
    setStatusMsg(t('register.publishingProfile'));

    try {
      // Fetch relays from system params
      const spRes = await fetch('/api/system-params');
      const spData = await spRes.json();
      const relays = spData?.relays || ['wss://relay.lanavault.space', 'wss://relay.lanacoin-eternity.com', 'wss://relay.lanaheartvoice.com'];

      // Build KIND 0 profile
      const profileContent = {
        name: form.name.trim(),
        display_name: form.display_name.trim(),
        about: form.about.trim(),
        location: form.location.trim(),
        country: form.country.toUpperCase().trim(),
        currency: form.currency,
        language: form.language,
        lanoshi2lash: '10000',
        lanaWalletID: derivedIds.walletId,
        whoAreYou: 'Human',
        orgasmic_profile: form.orgasmic_profile.trim(),
        statement_of_responsibility: form.statement_of_responsibility.trim(),
      };

      const signedEvent = signNostrEvent(
        derivedIds.nostrPrivateKey,
        0,
        JSON.stringify(profileContent),
        [['lang', form.language]]
      );

      const result = await publishToRelays(signedEvent, relays);
      if (result.success.length === 0) {
        throw new Error(t('register.failedToPublish'));
      }

      setStatusMsg(t('register.profilePublished', { count: result.success.length }));

      // Register wallet
      const regRes = await fetch('/api/register/wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_id: derivedIds.walletId, nostr_id_hex: derivedIds.nostrHexId }),
      });
      const regData = await regRes.json();

      if (regRes.ok) {
        setStatusMsg(t('register.walletRegistered', { message: regData.message || 'success' }));
      } else {
        setStatusMsg(t('register.profilePublishedPending', { status: regData.error || 'registration pending' }));
      }

      setStep('done');
    } catch (err: any) {
      setError(err.message || t('register.registrationFailed'));
      setStep('form');
    }
  };

  // QR Scanner
  if (showScanner) {
    return (
      <QRScanner
        onScan={(value: string) => { setShowScanner(false); handleWifSubmit(value); }}
        onClose={() => setShowScanner(false)}
      />
    );
  }

  // Step: Scan WIF
  if (step === 'scan') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 px-6">
        <div className="w-20 h-20 rounded-2xl bg-secondary flex items-center justify-center">
          <KeyRound className="w-10 h-10 text-primary" />
        </div>
        <div className="text-center space-y-2">
          <h2 className="font-display text-2xl font-bold text-foreground">{t('register.title')}</h2>
          <p className="text-muted-foreground text-sm max-w-[280px]">
            {t('register.subtitle')}
          </p>
        </div>
        {error && <p className="text-destructive text-sm text-center">{error}</p>}
        <div className="w-full max-w-xs space-y-3">
          <Button
            onClick={() => setShowScanner(true)}
            className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground"
          >
            <ScanLine className="w-5 h-5" />
            {t('register.scanWifKey')}
          </Button>
          <div className="relative">
            <input
              type="password"
              placeholder={t('register.pasteWifPlaceholder')}
              value={wif}
              onChange={e => setWif(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleWifSubmit(wif)}
              className="w-full px-4 py-3 rounded-xl border bg-background text-sm"
            />
          </div>
          {wif && (
            <Button onClick={() => handleWifSubmit(wif)} variant="outline" className="w-full rounded-xl">
              {t('register.checkRegistration')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Step: Checking
  if (step === 'checking') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
        <p className="text-muted-foreground">{t('register.checkingRegistration')}</p>
      </div>
    );
  }

  // Step: Already registered
  if (step === 'registered') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-6">
        <CheckCircle className="w-16 h-16 text-emerald-500" />
        <h2 className="text-xl font-bold text-foreground">{t('register.alreadyRegistered')}</h2>
        <p className="text-muted-foreground text-sm text-center max-w-[280px]">
          {t('register.alreadyRegisteredDescription')}
        </p>
        <p className="font-mono text-xs text-muted-foreground">{derivedIds?.walletId}</p>
        <Button onClick={() => { setStep('scan'); setWif(''); }} variant="outline" className="rounded-xl">
          {t('common.checkAnother')}
        </Button>
      </div>
    );
  }

  // Step: Done
  if (step === 'done') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-6">
        <CheckCircle className="w-16 h-16 text-emerald-500" />
        <h2 className="text-xl font-bold text-foreground">{t('register.registrationComplete')}</h2>
        <p className="text-muted-foreground text-sm text-center">{statusMsg}</p>
        <p className="font-mono text-xs text-muted-foreground">{derivedIds?.walletId}</p>
        <Button onClick={() => { setStep('scan'); setWif(''); setDerivedIds(null); }} variant="outline" className="rounded-xl">
          {t('register.registerAnother')}
        </Button>
      </div>
    );
  }

  // Step: Publishing
  if (step === 'publishing') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
        <p className="text-muted-foreground text-sm">{statusMsg}</p>
      </div>
    );
  }

  // Step: Profile form
  return (
    <div className="px-4 py-6 max-w-lg mx-auto space-y-4">
      <button onClick={() => setStep('scan')} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-4 h-4" /> {t('common.back')}
      </button>

      <h2 className="text-xl font-bold">{t('register.createProfile')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('register.walletLabel')} <span className="font-mono">{derivedIds?.walletId.slice(0, 12)}...</span>
      </p>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/10 text-destructive text-sm">
          <XCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      <div className="space-y-3">
        <Field label={`${t('register.nameLabel')} *`} value={form.name} onChange={v => setForm(f => ({...f, name: v}))} placeholder={t('register.namePlaceholder')} />
        <Field label={`${t('register.displayNameLabel')} *`} value={form.display_name} onChange={v => setForm(f => ({...f, display_name: v}))} placeholder={t('register.displayNamePlaceholder')} />
        <Field label={`${t('register.aboutLabel')} *`} value={form.about} onChange={v => setForm(f => ({...f, about: v}))} placeholder={t('register.aboutPlaceholder')} multiline />
        <Field label={`${t('register.locationLabel')} *`} value={form.location} onChange={v => setForm(f => ({...f, location: v}))} placeholder={t('register.locationPlaceholder')} />
        <Field label={`${t('register.countryCodeLabel')} *`} value={form.country} onChange={v => setForm(f => ({...f, country: v.toUpperCase()}))} placeholder={t('register.countryCodePlaceholder')} maxLength={2} />

        <div>
          <label className="text-xs font-medium text-muted-foreground">{t('register.currencyLabel')}</label>
          <select value={form.currency} onChange={e => setForm(f => ({...f, currency: e.target.value}))}
            className="w-full mt-1 px-3 py-2 rounded-lg border bg-background text-sm">
            {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground">{t('register.languageLabel')}</label>
          <select value={form.language} onChange={e => setForm(f => ({...f, language: e.target.value}))}
            className="w-full mt-1 px-3 py-2 rounded-lg border bg-background text-sm">
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </div>

        <Field label={`${t('register.orgasmicLabel')} *`} value={form.orgasmic_profile} onChange={v => setForm(f => ({...f, orgasmic_profile: v}))} placeholder={t('register.orgasmicPlaceholder')} multiline />
        <Field label={`${t('register.statementLabel')} *`} value={form.statement_of_responsibility} onChange={v => setForm(f => ({...f, statement_of_responsibility: v}))} placeholder={t('register.statementPlaceholder')} multiline />
      </div>

      <Button onClick={handlePublish} className="w-full h-12 rounded-xl text-base font-semibold bg-primary text-primary-foreground">
        {t('register.registerWallet')}
      </Button>
    </div>
  );
};

function Field({ label, value, onChange, placeholder, multiline, maxLength }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; maxLength?: number;
}) {
  const cls = "w-full mt-1 px-3 py-2 rounded-lg border bg-background text-sm";
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {multiline ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className={cls + " min-h-[60px]"} />
      ) : (
        <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} maxLength={maxLength} className={cls} />
      )}
    </div>
  );
}

export default RegisterTab;
