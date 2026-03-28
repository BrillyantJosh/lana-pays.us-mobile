import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Shield, Save, Loader2, ShieldAlert } from 'lucide-react';

const Admin = () => {
  const { session } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [defaultMaxTx, setDefaultMaxTx] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Check admin status
  useEffect(() => {
    if (!session?.nostrHexId) return;
    fetch(`/api/admin/check?hex_id=${session.nostrHexId}`)
      .then(r => r.json())
      .then(d => setIsAdmin(d.isAdmin))
      .catch(() => setIsAdmin(false));
  }, [session?.nostrHexId]);

  // Load settings
  useEffect(() => {
    if (!isAdmin || !session?.nostrHexId) return;
    fetch('/api/admin/settings', {
      headers: { 'x-admin-hex-id': session.nostrHexId },
    })
      .then(r => r.json())
      .then(d => {
        setSettings(d.settings || {});
        setDefaultMaxTx(d.settings?.default_max_tx_amount || '0');
      })
      .catch(() => {});
  }, [isAdmin, session?.nostrHexId]);

  const handleSave = async () => {
    if (!session?.nostrHexId) return;
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-hex-id': session.nostrHexId,
        },
        body: JSON.stringify({
          settings: {
            default_max_tx_amount: defaultMaxTx || '0',
          },
        }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch {}
    setSaving(false);
  };

  // Loading state
  if (isAdmin === null) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Access denied
  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 px-6">
        <ShieldAlert className="w-16 h-16 text-destructive" />
        <h1 className="text-xl font-bold text-foreground">Access Denied</h1>
        <p className="text-sm text-muted-foreground text-center">You do not have admin privileges.</p>
        <button
          onClick={() => navigate('/')}
          className="px-6 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium"
        >
          {t('common.back')}
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 bg-card border-b border-border z-10">
        <div className="flex items-center gap-3 px-4 py-3">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors text-sm font-medium"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            <h1 className="font-display text-lg font-bold text-foreground">Admin Settings</h1>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
        {/* Transaction Limits */}
        <div className="rounded-2xl bg-card border border-border p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Default Transaction Limit</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Global maximum per transaction. Applies when a shop has no specific limit, or when this limit is lower.
              Set to 0 to disable (no global limit).
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Max Amount (all currencies)</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="decimal"
                value={defaultMaxTx}
                onChange={(e) => setDefaultMaxTx(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="0"
                className="flex-1 h-11 rounded-xl bg-background border border-input px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <span className="text-sm text-muted-foreground shrink-0">FIAT</span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {parseFloat(defaultMaxTx || '0') > 0
                ? `Limit active: max ${parseFloat(defaultMaxTx).toLocaleString(undefined, { minimumFractionDigits: 2 })} per transaction`
                : 'No global limit \u2014 uses shop or fund limits only'}
            </p>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full h-11 rounded-xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-2 hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> {t('common.saving')}</>
            ) : saved ? (
              <>{t('common.save')}d</>
            ) : (
              <><Save className="w-4 h-4" /> {t('common.save')}</>
            )}
          </button>
        </div>

        {/* Current limits info */}
        <div className="rounded-2xl bg-card border border-border p-5 space-y-3">
          <h2 className="text-sm font-semibold text-foreground">How Limits Work</h2>
          <div className="space-y-2 text-xs text-muted-foreground">
            <p><strong className="text-foreground">Priority:</strong> The lowest available limit applies.</p>
            <div className="space-y-1 pl-3">
              <p>1. <strong>Shop limit</strong> \u2014 set per shop in KIND 30902 fee policy</p>
              <p>2. <strong>Fund limit</strong> \u2014 largest available investor budget</p>
              <p>3. <strong>Default limit</strong> \u2014 this global setting</p>
            </div>
            <p>Example: Shop limit = 200, Fund = 100, Default = 150 \u2192 Max Invoice = 100 (fund is lowest)</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Admin;
