/**
 * Caretaker tab — one card per business unit, showing the caretaker
 * pulled from KIND 30902 fee policy → KIND 0 profile lookup, with
 * quick-contact buttons (encrypted DM via NIP-04, email, phone, web).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MessageCircle, Phone, Mail, Globe, MapPin, Store, ShieldCheck,
  Loader2, UserCog, Copy, Check, AlertCircle, ShieldAlert,
} from 'lucide-react';
import { CaretakerChat } from '@/components/CaretakerChat';

interface BusinessUnit {
  unit_id: string;
  name: string;
  image: string;
  receiver_city: string;
  category: string;
  currency: string;
  // Merchant Registration Gateway status:
  //   'active' | 'pending' | 'quota_warning_80' | 'quota_blocked' | 'suspended' | 'rejected'
  suspension_status?: string;
  suspension_until?: number | null;
}

const BLOCKING = new Set(['pending', 'quota_blocked', 'suspended', 'rejected']);
function isBlocked(status?: string): boolean { return BLOCKING.has(status || 'active'); }

const STATUS_TONE: Record<string, { cls: string; label: string }> = {
  pending:           { cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',         label: 'Pending' },
  quota_blocked:     { cls: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400',     label: 'Quota blocked' },
  quota_warning_80:  { cls: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-500/15 dark:text-yellow-400',     label: '80% quota' },
  suspended:         { cls: 'bg-destructive/10 text-destructive',                                            label: 'Suspended' },
  rejected:          { cls: 'bg-destructive/10 text-destructive',                                            label: 'Rejected' },
};

interface CaretakerProfile {
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
  nip05?: string;
  email?: string;
  phone?: string;
  phone_country_code?: string;
  website?: string;
  location?: string;
}

interface CaretakerInfo {
  unitId: string;
  hex: string;
  wallet: string | null;
  profile: CaretakerProfile | null;
}

interface CaretakerTabProps {
  businessUnits: BusinessUnit[];
  initialUnitId?: string | null;
}

function resolveImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('/api/uploads/')) return `https://shop.lanapays.us${url}`;
  return url;
}

const CaretakerTab = ({ businessUnits, initialUnitId }: CaretakerTabProps) => {
  const { t } = useTranslation();
  const [data, setData]   = useState<Record<string, CaretakerInfo | 'missing' | 'loading'>>({});
  const [chatFor, setChatFor] = useState<{ hex: string; name: string; picture?: string | null } | null>(null);
  const [copiedHex, setCopiedHex] = useState<string | null>(null);

  // Fetch caretaker info for every unit on mount
  useEffect(() => {
    let cancelled = false;
    setData(prev => {
      const next = { ...prev };
      for (const u of businessUnits) next[u.unit_id] = 'loading';
      return next;
    });

    Promise.all(businessUnits.map(async (u) => {
      try {
        const res = await fetch(`/api/caretaker/${encodeURIComponent(u.unit_id)}`);
        if (res.status === 404) {
          return { unitId: u.unit_id, info: 'missing' as const };
        }
        const json = await res.json();
        return {
          unitId: u.unit_id,
          info: {
            unitId: u.unit_id,
            hex: json.hex,
            wallet: json.wallet,
            profile: json.profile,
          } as CaretakerInfo,
        };
      } catch {
        return { unitId: u.unit_id, info: 'missing' as const };
      }
    })).then(results => {
      if (cancelled) return;
      setData(prev => {
        const next = { ...prev };
        for (const r of results) next[r.unitId] = r.info;
        return next;
      });
    });

    return () => { cancelled = true; };
  }, [businessUnits]);

  // Open the chat panel automatically if a unit was selected
  useEffect(() => {
    if (!initialUnitId) return;
    const entry = data[initialUnitId];
    if (entry && entry !== 'loading' && entry !== 'missing') {
      const name = entry.profile?.name || entry.profile?.display_name || `${entry.hex.slice(0, 8)}…`;
      setChatFor({ hex: entry.hex, name, picture: entry.profile?.picture || null });
    }
  }, [initialUnitId, data]);

  const handleCopyHex = (hex: string) => {
    navigator.clipboard.writeText(hex).then(() => {
      setCopiedHex(hex);
      setTimeout(() => setCopiedHex(null), 2000);
    });
  };

  return (
    <div className="flex flex-col gap-4 px-6 py-4">
      {/* Header (the outer page wrapper already renders a Back button) */}
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center shrink-0">
          <UserCog className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-xl font-bold text-foreground">{t('caretaker.pageTitle')}</h2>
          <p className="text-xs text-muted-foreground">{t('caretaker.pageSubtitle')}</p>
        </div>
      </div>

      {/* Per-unit cards */}
      {businessUnits.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          {t('caretaker.noShops')}
        </div>
      ) : (
        businessUnits.map(unit => {
          const entry = data[unit.unit_id];
          const tone = STATUS_TONE[unit.suspension_status || ''];
          const blocked = isBlocked(unit.suspension_status);
          return (
            <div key={unit.unit_id} className={`rounded-2xl border bg-card overflow-hidden ${blocked ? 'border-destructive/20' : 'border-border'}`}>
              {/* Unit header */}
              <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center gap-3">
                {resolveImageUrl(unit.image) ? (
                  <img src={resolveImageUrl(unit.image)!} alt="" className={`w-9 h-9 rounded-xl object-cover shrink-0 ${blocked ? 'grayscale opacity-70' : ''}`} />
                ) : (
                  <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                    <Store className="w-4 h-4 text-primary" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-semibold text-foreground truncate">{unit.name}</p>
                    {tone && (
                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${tone.cls}`}>
                        {tone.label}
                      </span>
                    )}
                  </div>
                  {unit.receiver_city && (
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                      <MapPin className="w-3 h-3" /> {unit.receiver_city}
                    </p>
                  )}
                </div>
              </div>

              {/* Blocked notice — sits above caretaker info so seller sees status reason first */}
              {blocked && (
                <div className="px-4 py-2.5 bg-destructive/5 border-b border-destructive/10 flex items-start gap-2">
                  <ShieldAlert className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                  <p className="text-xs text-destructive/90">
                    {t('caretaker.blockedHint', { status: tone?.label || unit.suspension_status })}
                  </p>
                </div>
              )}

              {/* Caretaker body */}
              <div className="p-4">
                {entry === 'loading' || entry === undefined ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" /> {t('caretaker.loading')}
                  </div>
                ) : entry === 'missing' ? (
                  <div className="flex items-start gap-2 text-sm text-muted-foreground">
                    <AlertCircle className="w-4 h-4 mt-0.5 text-muted-foreground/60 shrink-0" />
                    <span>{t('caretaker.notAssigned')}</span>
                  </div>
                ) : (
                  <CaretakerCard
                    info={entry}
                    onMessage={() => setChatFor({
                      hex: entry.hex,
                      name: entry.profile?.name || entry.profile?.display_name || `${entry.hex.slice(0, 8)}…`,
                      picture: entry.profile?.picture || null,
                    })}
                    onCopyHex={handleCopyHex}
                    copied={copiedHex === entry.hex}
                  />
                )}
              </div>
            </div>
          );
        })
      )}

      {/* Chat overlay */}
      {chatFor && (
        <CaretakerChat
          recipientHex={chatFor.hex}
          recipientName={chatFor.name}
          recipientPicture={chatFor.picture || undefined}
          onClose={() => setChatFor(null)}
        />
      )}
    </div>
  );
};

// ─── Caretaker contact card ────────────────────────────────────────────

function CaretakerCard({
  info,
  onMessage,
  onCopyHex,
  copied,
}: {
  info: CaretakerInfo;
  onMessage: () => void;
  onCopyHex: (hex: string) => void;
  copied: boolean;
}) {
  const { t } = useTranslation();
  const p = info.profile;
  const displayName = p?.name || p?.display_name || `${info.hex.slice(0, 8)}…`;
  const fullPhone = p?.phone_country_code && p?.phone
    ? `${p.phone_country_code}${p.phone}`
    : p?.phone;

  return (
    <div className="flex flex-col gap-3">
      {/* Identity */}
      <div className="flex items-center gap-3">
        {p?.picture ? (
          <img src={p.picture} alt="" className="w-12 h-12 rounded-full object-cover shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <UserCog className="w-5 h-5 text-primary" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">{displayName}</p>
          {p?.nip05 && <p className="text-xs text-muted-foreground truncate">{p.nip05}</p>}
          {!p?.nip05 && p?.location && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
              <MapPin className="w-3 h-3" /> {p.location}
            </p>
          )}
        </div>
      </div>

      {p?.about && <p className="text-xs text-muted-foreground leading-relaxed">{p.about}</p>}

      {/* Contact actions */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={onMessage}
          className="flex items-center justify-center gap-2 h-11 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors col-span-2"
        >
          <MessageCircle className="w-4 h-4" /> {t('caretaker.messageButton')}
        </button>
        {p?.email && (
          <a
            href={`mailto:${p.email}`}
            className="flex items-center justify-center gap-2 h-11 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-secondary transition-colors"
          >
            <Mail className="w-4 h-4" /> {t('caretaker.emailButton')}
          </a>
        )}
        {fullPhone && (
          <a
            href={`tel:${fullPhone}`}
            className="flex items-center justify-center gap-2 h-11 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-secondary transition-colors"
          >
            <Phone className="w-4 h-4" /> {t('caretaker.callButton')}
          </a>
        )}
        {p?.website && (
          <a
            href={p.website.startsWith('http') ? p.website : `https://${p.website}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 h-11 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-secondary transition-colors"
          >
            <Globe className="w-4 h-4" /> {t('caretaker.webButton')}
          </a>
        )}
      </div>

      {/* Hex id (collapsible-ish, just monospace + copy) */}
      <button
        onClick={() => onCopyHex(info.hex)}
        className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground/70 hover:text-foreground transition-colors w-fit"
        title={t('caretaker.copyHex')}
      >
        <ShieldCheck className="w-3 h-3" />
        {info.hex.slice(0, 12)}…{info.hex.slice(-8)}
        {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}

export default CaretakerTab;
