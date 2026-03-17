import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { createAndSignKind0, type Kind0Content } from '@/lib/nostr-sign';
import {
  Save, Loader2, CheckCircle, AlertCircle, ChevronDown, ChevronUp,
  User, MapPin, Phone, Wallet, Globe, Heart, FileText, Plus, X
} from 'lucide-react';

interface Language {
  code: string;
  name: string;
  nativeName: string;
}

const COUNTRIES = [
  'AD','AE','AF','AG','AI','AL','AM','AO','AR','AT','AU','AZ','BA','BB','BD','BE','BF','BG','BH','BI',
  'BJ','BN','BO','BR','BS','BT','BW','BY','BZ','CA','CD','CF','CG','CH','CI','CL','CM','CN','CO','CR',
  'CU','CV','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','ER','ES','ET','FI','FJ','FM','FR',
  'GA','GB','GD','GE','GH','GM','GN','GQ','GR','GT','GW','GY','HK','HN','HR','HT','HU','ID','IE','IL',
  'IN','IQ','IR','IS','IT','JM','JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KZ','LA','LB',
  'LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MG','MH','MK','ML','MM','MN','MR',
  'MT','MU','MV','MW','MX','MY','MZ','NA','NE','NG','NI','NL','NO','NP','NR','NZ','OM','PA','PE','PG',
  'PH','PK','PL','PT','PW','PY','QA','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SI','SK','SL',
  'SM','SN','SO','SR','SS','ST','SV','SY','SZ','TD','TG','TH','TJ','TL','TM','TN','TO','TR','TT','TV',
  'TW','TZ','UA','UG','US','UY','UZ','VA','VC','VE','VN','VU','WS','YE','ZA','ZM','ZW'
];

const CURRENCIES = ['EUR','USD','GBP','CHF','CAD','AUD','JPY','CNY','INR','BRL','MXN','KRW','SEK','NOK','DKK','PLN','CZK','HUF','RON','BGN','HRK','RSD','BAM','TRY','RUB','UAH'];

const EditProfile = () => {
  const { session } = useAuth();

  // Form state
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [about, setAbout] = useState('');
  const [picture, setPicture] = useState('');
  const [website, setWebsite] = useState('');
  const [nip05, setNip05] = useState('');
  const [location, setLocation] = useState('');
  const [country, setCountry] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [currency, setCurrency] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneCountryCode, setPhoneCountryCode] = useState('');
  const [lanoshi2lash, setLanoshi2lash] = useState('10000');
  const [lanaWalletID, setLanaWalletID] = useState('');
  const [whoAreYou, setWhoAreYou] = useState('Human');
  const [orgasmicProfile, setOrgasmicProfile] = useState('');
  const [statementOfResponsibility, setStatementOfResponsibility] = useState('');
  const [lang, setLang] = useState('');
  const [tTags, setTTags] = useState<string[]>([]);
  const [oTags, setOTags] = useState<string[]>([]);
  const [newTTag, setNewTTag] = useState('');
  const [newOTag, setNewOTag] = useState('');

  // UI state
  const [languages, setLanguages] = useState<Language[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    basic: true, location: false, contact: false, lana: false, tags: false, responsibility: false
  });

  // Preserve unknown fields from existing profile
  const [preservedFields, setPreservedFields] = useState<Record<string, any>>({});
  const [existingTags, setExistingTags] = useState<string[][]>([]);

  // Fetch languages + existing profile
  useEffect(() => {
    fetch('/i18n/languages').then(r => r.json()).then(setLanguages).catch(() => {});

    if (!session?.nostrHexId) { setLoading(false); return; }

    fetch(`/api/profile-full/${session.nostrHexId}`)
      .then(r => r.json())
      .then(data => {
        if (data.profile?.content) {
          const c = data.profile.content;
          setName(c.name || '');
          setDisplayName(c.display_name || '');
          setAbout(c.about || '');
          setPicture(c.picture || '');
          setWebsite(c.website || '');
          setNip05(c.nip05 || '');
          setLocation(c.location || '');
          setCountry(c.country || '');
          setLatitude(c.latitude != null ? String(c.latitude) : '');
          setLongitude(c.longitude != null ? String(c.longitude) : '');
          setCurrency(c.currency || '');
          setEmail(c.email || '');
          setPhone(c.phone || '');
          setPhoneCountryCode(c.phone_country_code || '');
          setLanoshi2lash(c.lanoshi2lash || '10000');
          setLanaWalletID(c.lanaWalletID || '');
          setWhoAreYou(c.whoAreYou || 'Human');
          setOrgasmicProfile(c.orgasmic_profile || '');
          setStatementOfResponsibility(c.statement_of_responsibility || '');

          // Preserve fields we don't edit
          const knownFields = new Set([
            'name','display_name','about','picture','website','nip05','language',
            'location','country','latitude','longitude','currency',
            'email','phone','phone_country_code',
            'lanoshi2lash','lanaWalletID','whoAreYou','orgasmic_profile',
            'statement_of_responsibility','payment_methods','preferred_payout','preferred_collect',
            'bankName','bankAddress','bankSWIFT','bankAccount'
          ]);
          const preserved: Record<string, any> = {};
          for (const [key, value] of Object.entries(c)) {
            if (!knownFields.has(key)) preserved[key] = value;
          }
          setPreservedFields(preserved);

          // Payment methods and legacy banking are preserved as-is
          if (c.payment_methods) preserved.payment_methods = c.payment_methods;
          if (c.preferred_payout) preserved.preferred_payout = c.preferred_payout;
          if (c.preferred_collect) preserved.preferred_collect = c.preferred_collect;
          if (c.bankName) preserved.bankName = c.bankName;
          if (c.bankAddress) preserved.bankAddress = c.bankAddress;
          if (c.bankSWIFT) preserved.bankSWIFT = c.bankSWIFT;
          if (c.bankAccount) preserved.bankAccount = c.bankAccount;
          setPreservedFields(preserved);
        }

        if (data.profile?.tags) {
          const tags: string[][] = data.profile.tags;
          const langTag = tags.find(t => t[0] === 'lang');
          if (langTag) setLang(langTag[1]);

          const tValues = tags.filter(t => t[0] === 't').map(t => t[1]);
          setTTags(tValues);

          const oValues = tags.filter(t => t[0] === 'o').map(t => t[1]);
          setOTags(oValues);

          // Preserve non-standard tags
          const knownTagTypes = new Set(['lang', 't', 'o']);
          setExistingTags(tags.filter(t => !knownTagTypes.has(t[0])));
        }
      })
      .catch(e => console.warn('Failed to load profile:', e))
      .finally(() => setLoading(false));
  }, [session?.nostrHexId]);

  // Auto-fill lanaWalletID from session
  useEffect(() => {
    if (!lanaWalletID && session?.walletId) {
      setLanaWalletID(session.walletId);
    }
  }, [session?.walletId, lanaWalletID]);

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const validate = (): string | null => {
    if (!name.trim()) return 'Name is required';
    if (!displayName.trim()) return 'Display name is required';
    if (!about.trim()) return 'About is required';
    if (!location.trim()) return 'Location is required';
    if (!country.trim()) return 'Country is required';
    if (!currency.trim()) return 'Currency is required';
    if (!lang) return 'Language is required';
    if (!whoAreYou) return 'Who Are You is required';
    if (!orgasmicProfile.trim()) return 'Orgasmic Profile is required';
    if (!statementOfResponsibility.trim()) return 'Statement of Responsibility is required';

    if (latitude) {
      const lat = parseFloat(latitude);
      if (isNaN(lat) || lat < -90 || lat > 90) return 'Latitude must be between -90 and 90';
    }
    if (longitude) {
      const lng = parseFloat(longitude);
      if (isNaN(lng) || lng < -180 || lng > 180) return 'Longitude must be between -180 and 180';
    }
    if (email && !email.includes('@')) return 'Invalid email format';
    if (phone && !phoneCountryCode) return 'Phone country code is required when phone is provided';
    if (phoneCountryCode && !phoneCountryCode.startsWith('+')) return 'Phone country code must start with +';
    if (phone && !/^\d+$/.test(phone)) return 'Phone must contain digits only';

    return null;
  };

  const handleSave = async () => {
    if (!session?.privateKeyHex) {
      setSaveResult({ ok: false, message: 'No signing key available. Please re-login.' });
      return;
    }

    const error = validate();
    if (error) {
      setSaveResult({ ok: false, message: error });
      // Open the section containing the error
      if (['Name','Display name','About'].some(f => error.includes(f))) setExpandedSections(p => ({ ...p, basic: true }));
      if (['Location','Country','Currency','Latitude','Longitude'].some(f => error.includes(f))) setExpandedSections(p => ({ ...p, location: true }));
      if (['email','Phone'].some(f => error.includes(f))) setExpandedSections(p => ({ ...p, contact: true }));
      if (['Who Are You','Orgasmic','Wallet'].some(f => error.includes(f))) setExpandedSections(p => ({ ...p, lana: true }));
      if (error.includes('Language')) setExpandedSections(p => ({ ...p, basic: true }));
      if (error.includes('Statement')) setExpandedSections(p => ({ ...p, responsibility: true }));
      return;
    }

    setSaving(true);
    setSaveResult(null);

    try {
      const content: Kind0Content = {
        name: name.trim(),
        display_name: displayName.trim(),
        about: about.trim(),
        picture: picture.trim() || undefined,
        website: website.trim() || undefined,
        nip05: nip05.trim() || undefined,
        language: lang,
        location: location.trim(),
        country: country.trim(),
        latitude: latitude ? parseFloat(latitude) : undefined,
        longitude: longitude ? parseFloat(longitude) : undefined,
        currency: currency.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        phone_country_code: phoneCountryCode.trim() || undefined,
        lanoshi2lash: lanoshi2lash || '10000',
        lanaWalletID: lanaWalletID.trim() || undefined,
        whoAreYou,
        orgasmic_profile: orgasmicProfile.trim(),
        statement_of_responsibility: statementOfResponsibility.trim(),
        ...preservedFields,
      };

      // Build tags
      const tags: string[][] = [
        ['lang', lang],
        ...tTags.filter(t => t.trim()).map(t => ['t', t.trim()]),
        ...oTags.filter(o => o.trim()).map(o => ['o', o.trim()]),
        ...existingTags,
      ];

      const signedEvent = createAndSignKind0(session.privateKeyHex, content, tags);

      const res = await fetch('/api/broadcast-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: signedEvent }),
      });

      const result = await res.json();

      if (result.success?.length > 0) {
        setSaveResult({ ok: true, message: `Profile saved to ${result.success.length} relay(s)` });
      } else {
        setSaveResult({ ok: false, message: 'Failed to broadcast to any relay' });
      }
    } catch (e: any) {
      setSaveResult({ ok: false, message: e.message || 'Failed to save profile' });
    } finally {
      setSaving(false);
    }
  };

  const addTTag = () => {
    if (newTTag.trim() && !tTags.includes(newTTag.trim())) {
      setTTags(prev => [...prev, newTTag.trim()]);
      setNewTTag('');
    }
  };

  const addOTag = () => {
    if (newOTag.trim() && !oTags.includes(newOTag.trim())) {
      setOTags(prev => [...prev, newOTag.trim()]);
      setNewOTag('');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  const SectionHeader = ({ id, icon: Icon, title }: { id: string; icon: any; title: string }) => (
    <button
      onClick={() => toggleSection(id)}
      className="flex items-center justify-between w-full px-4 py-3 bg-card rounded-xl border border-border"
    >
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">{title}</span>
      </div>
      {expandedSections[id] ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
    </button>
  );

  const Field = ({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) => (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label} {required && <span className="text-destructive">*</span>}
      </label>
      {children}
    </div>
  );

  const inputClass = "w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary";
  const selectClass = "w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary";

  return (
    <div className="px-4 pb-8 space-y-3">
      {/* ─── Basic Info ─── */}
      <SectionHeader id="basic" icon={User} title="Basic Information" />
      {expandedSections.basic && (
        <div className="space-y-4 px-1">
          <Field label="Language" required>
            <select value={lang} onChange={e => setLang(e.target.value)} className={selectClass}>
              <option value="">Select language...</option>
              {languages.map(l => (
                <option key={l.code} value={l.code}>{l.nativeName} ({l.code})</option>
              ))}
            </select>
          </Field>
          <Field label="Name" required>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" className={inputClass} />
          </Field>
          <Field label="Display Name" required>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Display name" className={inputClass} />
          </Field>
          <Field label="About" required>
            <textarea value={about} onChange={e => setAbout(e.target.value)} placeholder="Tell us about yourself..." rows={3} className={inputClass + ' resize-none'} />
          </Field>
          <Field label="Profile Picture URL">
            <input value={picture} onChange={e => setPicture(e.target.value)} placeholder="https://..." className={inputClass} />
            {picture && (
              <div className="mt-2 flex items-center gap-3">
                <img src={picture} alt="" className="w-12 h-12 rounded-xl object-cover" onError={e => (e.currentTarget.style.display = 'none')} />
              </div>
            )}
          </Field>
          <Field label="Website">
            <input value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://..." className={inputClass} />
          </Field>
          <Field label="NIP-05 Verification">
            <input value={nip05} onChange={e => setNip05(e.target.value)} placeholder="user@domain.com" className={inputClass} />
          </Field>
        </div>
      )}

      {/* ─── Location & Currency ─── */}
      <SectionHeader id="location" icon={MapPin} title="Location & Currency" />
      {expandedSections.location && (
        <div className="space-y-4 px-1">
          <Field label="Location" required>
            <input value={location} onChange={e => setLocation(e.target.value)} placeholder="City, Country" className={inputClass} />
          </Field>
          <Field label="Country" required>
            <select value={country} onChange={e => setCountry(e.target.value)} className={selectClass}>
              <option value="">Select country...</option>
              {COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Currency" required>
            <select value={currency} onChange={e => setCurrency(e.target.value)} className={selectClass}>
              <option value="">Select currency...</option>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Latitude">
              <input value={latitude} onChange={e => setLatitude(e.target.value)} placeholder="-90 to 90" type="text" inputMode="decimal" className={inputClass} />
            </Field>
            <Field label="Longitude">
              <input value={longitude} onChange={e => setLongitude(e.target.value)} placeholder="-180 to 180" type="text" inputMode="decimal" className={inputClass} />
            </Field>
          </div>
        </div>
      )}

      {/* ─── Contact Info ─── */}
      <SectionHeader id="contact" icon={Phone} title="Contact Information" />
      {expandedSections.contact && (
        <div className="space-y-4 px-1">
          <Field label="Email">
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="user@example.com" type="email" className={inputClass} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Country Code">
              <input value={phoneCountryCode} onChange={e => setPhoneCountryCode(e.target.value)} placeholder="+386" className={inputClass} />
            </Field>
            <div className="col-span-2">
              <Field label="Phone">
                <input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, ''))} placeholder="41123456" inputMode="tel" className={inputClass} />
              </Field>
            </div>
          </div>
        </div>
      )}

      {/* ─── Lana Fields ─── */}
      <SectionHeader id="lana" icon={Wallet} title="LanaCoins Settings" />
      {expandedSections.lana && (
        <div className="space-y-4 px-1">
          <Field label="Who Are You" required>
            <select value={whoAreYou} onChange={e => setWhoAreYou(e.target.value)} className={selectClass}>
              <option value="Human">Human</option>
              <option value="EI">EI (Enlightened Intelligence)</option>
            </select>
          </Field>
          <Field label="Lana Wallet ID">
            <input value={lanaWalletID} onChange={e => setLanaWalletID(e.target.value)} placeholder="L..." className={inputClass} />
          </Field>
          <Field label="Lanoshi to Lash (exchange rate)">
            <input value={lanoshi2lash} onChange={e => setLanoshi2lash(e.target.value)} placeholder="10000" className={inputClass} />
          </Field>
          <Field label="Orgasmic Profile" required>
            <textarea value={orgasmicProfile} onChange={e => setOrgasmicProfile(e.target.value)} placeholder="Things that bring you joy — activities and passions that make you happy..." rows={3} className={inputClass + ' resize-none'} />
          </Field>
        </div>
      )}

      {/* ─── Tags ─── */}
      <SectionHeader id="tags" icon={Heart} title="Interests & Tags" />
      {expandedSections.tags && (
        <div className="space-y-4 px-1">
          <Field label='Interests (t tags)'>
            <div className="flex flex-wrap gap-2 mb-2">
              {tTags.map((tag, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary/10 text-primary text-xs font-medium">
                  {tag}
                  <button onClick={() => setTTags(prev => prev.filter((_, j) => j !== i))} className="hover:text-destructive">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input value={newTTag} onChange={e => setNewTTag(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addTTag())} placeholder="Add interest..." className={inputClass} />
              <button onClick={addTTag} className="shrink-0 w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary hover:bg-primary/20">
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </Field>
          <Field label='Intimacy Interests (o tags)'>
            <div className="flex flex-wrap gap-2 mb-2">
              {oTags.map((tag, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-pink-500/10 text-pink-600 dark:text-pink-400 text-xs font-medium">
                  {tag}
                  <button onClick={() => setOTags(prev => prev.filter((_, j) => j !== i))} className="hover:text-destructive">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input value={newOTag} onChange={e => setNewOTag(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addOTag())} placeholder="Add intimacy interest..." className={inputClass} />
              <button onClick={addOTag} className="shrink-0 w-10 h-10 rounded-xl bg-pink-500/10 flex items-center justify-center text-pink-600 dark:text-pink-400 hover:bg-pink-500/20">
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </Field>
        </div>
      )}

      {/* ─── Statement of Responsibility ─── */}
      <SectionHeader id="responsibility" icon={FileText} title="Statement of Responsibility" />
      {expandedSections.responsibility && (
        <div className="space-y-4 px-1">
          <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 p-3">
            <p className="text-xs text-amber-700 dark:text-amber-400">
              <strong>Mandatory.</strong> Write in your own words that you accept unconditional self-responsibility.
              This is a legally-significant personal declaration. No templates — it must be written by you.
            </p>
          </div>
          <Field label="Your Statement" required>
            <textarea
              value={statementOfResponsibility}
              onChange={e => setStatementOfResponsibility(e.target.value)}
              placeholder="I accept full and unconditional self-responsibility for everything I do or don't do inside the Lana World."
              rows={4}
              className={inputClass + ' resize-none'}
            />
          </Field>
        </div>
      )}

      {/* ─── Save Result ─── */}
      {saveResult && (
        <div className={`flex items-start gap-2 rounded-xl p-3 ${
          saveResult.ok ? 'bg-green-500/10 border border-green-500/20' : 'bg-destructive/10 border border-destructive/20'
        }`}>
          {saveResult.ok ? (
            <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          )}
          <p className={`text-xs ${saveResult.ok ? 'text-green-700 dark:text-green-400' : 'text-destructive'}`}>
            {saveResult.message}
          </p>
        </div>
      )}

      {/* ─── Save Button ─── */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full rounded-xl bg-primary text-primary-foreground py-3 font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.98] transition-transform"
      >
        {saving ? (
          <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>
        ) : (
          <><Save className="w-4 h-4" /> Save Profile</>
        )}
      </button>
    </div>
  );
};

export default EditProfile;
