import { useState } from "react";
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
      setError(err.message || 'Failed to check wallet');
      setStep('scan');
    }
  };

  const handlePublish = async () => {
    if (!derivedIds) return;

    const required = ['name', 'display_name', 'about', 'location', 'country', 'orgasmic_profile', 'statement_of_responsibility'];
    for (const key of required) {
      if (!(form as any)[key]?.trim()) {
        setError(`${key.replace(/_/g, ' ')} is required`);
        return;
      }
    }
    if (form.country.length !== 2) {
      setError('Country must be a 2-letter code (e.g. SI, US, DE)');
      return;
    }

    setStep('publishing');
    setError(null);
    setStatusMsg('Publishing profile...');

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
        throw new Error('Failed to publish to any relay');
      }

      setStatusMsg(`Profile published to ${result.success.length} relay(s). Registering wallet...`);

      // Register wallet
      const regRes = await fetch('/api/register/wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_id: derivedIds.walletId, nostr_id_hex: derivedIds.nostrHexId }),
      });
      const regData = await regRes.json();

      if (regRes.ok) {
        setStatusMsg(`Wallet registered: ${regData.message || 'success'}`);
      } else {
        setStatusMsg(`Profile published. Wallet: ${regData.error || 'registration pending'}`);
      }

      setStep('done');
    } catch (err: any) {
      setError(err.message || 'Registration failed');
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
          <h2 className="font-display text-2xl font-bold text-foreground">Register Wallet</h2>
          <p className="text-muted-foreground text-sm max-w-[280px]">
            Scan your LanaCoin WIF private key to register your wallet on the Lana network
          </p>
        </div>
        {error && <p className="text-destructive text-sm text-center">{error}</p>}
        <div className="w-full max-w-xs space-y-3">
          <Button
            onClick={() => setShowScanner(true)}
            className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground"
          >
            <ScanLine className="w-5 h-5" />
            Scan WIF Key
          </Button>
          <div className="relative">
            <input
              type="password"
              placeholder="Or paste WIF key..."
              value={wif}
              onChange={e => setWif(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleWifSubmit(wif)}
              className="w-full px-4 py-3 rounded-xl border bg-background text-sm"
            />
          </div>
          {wif && (
            <Button onClick={() => handleWifSubmit(wif)} variant="outline" className="w-full rounded-xl">
              Check Registration
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
        <p className="text-muted-foreground">Checking wallet registration...</p>
      </div>
    );
  }

  // Step: Already registered
  if (step === 'registered') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-6">
        <CheckCircle className="w-16 h-16 text-emerald-500" />
        <h2 className="text-xl font-bold text-foreground">Already Registered</h2>
        <p className="text-muted-foreground text-sm text-center max-w-[280px]">
          This wallet is already registered on the Lana network. You can use it to make payments.
        </p>
        <p className="font-mono text-xs text-muted-foreground">{derivedIds?.walletId}</p>
        <Button onClick={() => { setStep('scan'); setWif(''); }} variant="outline" className="rounded-xl">
          Check Another
        </Button>
      </div>
    );
  }

  // Step: Done
  if (step === 'done') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-6">
        <CheckCircle className="w-16 h-16 text-emerald-500" />
        <h2 className="text-xl font-bold text-foreground">Registration Complete</h2>
        <p className="text-muted-foreground text-sm text-center">{statusMsg}</p>
        <p className="font-mono text-xs text-muted-foreground">{derivedIds?.walletId}</p>
        <Button onClick={() => { setStep('scan'); setWif(''); setDerivedIds(null); }} variant="outline" className="rounded-xl">
          Register Another
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
        <ArrowLeft className="w-4 h-4" /> Back
      </button>

      <h2 className="text-xl font-bold">Create Profile</h2>
      <p className="text-sm text-muted-foreground">
        Wallet: <span className="font-mono">{derivedIds?.walletId.slice(0, 12)}...</span>
      </p>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/10 text-destructive text-sm">
          <XCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      <div className="space-y-3">
        <Field label="Name *" value={form.name} onChange={v => setForm(f => ({...f, name: v}))} placeholder="Your name" />
        <Field label="Display Name *" value={form.display_name} onChange={v => setForm(f => ({...f, display_name: v}))} placeholder="Display name" />
        <Field label="About *" value={form.about} onChange={v => setForm(f => ({...f, about: v}))} placeholder="About you..." multiline />
        <Field label="Location *" value={form.location} onChange={v => setForm(f => ({...f, location: v}))} placeholder="City, Country" />
        <Field label="Country Code *" value={form.country} onChange={v => setForm(f => ({...f, country: v.toUpperCase()}))} placeholder="SI" maxLength={2} />

        <div>
          <label className="text-xs font-medium text-muted-foreground">Currency</label>
          <select value={form.currency} onChange={e => setForm(f => ({...f, currency: e.target.value}))}
            className="w-full mt-1 px-3 py-2 rounded-lg border bg-background text-sm">
            {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground">Language</label>
          <select value={form.language} onChange={e => setForm(f => ({...f, language: e.target.value}))}
            className="w-full mt-1 px-3 py-2 rounded-lg border bg-background text-sm">
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </div>

        <Field label="Orgasmic Profile *" value={form.orgasmic_profile} onChange={v => setForm(f => ({...f, orgasmic_profile: v}))} placeholder="What excites you..." multiline />
        <Field label="Statement of Responsibility *" value={form.statement_of_responsibility} onChange={v => setForm(f => ({...f, statement_of_responsibility: v}))} placeholder="I take responsibility..." multiline />
      </div>

      <Button onClick={handlePublish} className="w-full h-12 rounded-xl text-base font-semibold bg-primary text-primary-foreground">
        Register Wallet
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
