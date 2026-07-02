import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { Lock, ShieldCheck } from 'lucide-react';

/**
 * Full-screen HARD lock shown while a Split is in progress. Driven by the
 * admin-toggled `split_happening` flag (mobile app_settings), surfaced on
 * /api/system-params and polled here every 30s.
 *
 * ADMINS ARE NEVER LOCKED — they must be able to keep working and, crucially,
 * reach /admin to turn the lock back OFF. So the overlay only shows for
 * CONFIRMED non-admins. As a belt-and-suspenders escape (e.g. if the admin
 * check is briefly unavailable) it also skips /admin and offers a visible
 * "Admin" button that navigates there (which is never locked).
 *
 * The notice is shown in BOTH English and Slovenian regardless of the selected
 * locale, via the i18n per-call `lng` override.
 */
export function SplitLockOverlay() {
  const { t } = useTranslation();
  const { session } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [locked, setLocked] = useState(false);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null); // null = not yet known

  // Resolve admin status — admins are exempt from the lock.
  useEffect(() => {
    const hex = session?.nostrHexId;
    if (!hex) { setIsAdmin(false); return; }
    let alive = true;
    fetch(`/api/admin/check?hex_id=${hex}`)
      .then(r => r.json())
      .then(d => { if (alive) setIsAdmin(!!d.isAdmin); })
      .catch(() => { if (alive) setIsAdmin(false); });
    return () => { alive = false; };
  }, [session?.nostrHexId]);

  // Poll the split-happening flag.
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch('/api/system-params');
        const json = await res.json();
        if (alive && typeof json?.data?.splitHappening === 'boolean') {
          setLocked(json.data.splitHappening);
        }
      } catch {
        // Keep previous state on error — never spuriously lock or unlock.
      }
    };
    check();
    const id = setInterval(check, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Show ONLY when: the flag is on, the viewer is a confirmed non-admin, and we
  // are not on /admin. While admin status is still unknown (null) we do NOT lock,
  // so an admin never even flashes the overlay.
  if (!locked || isAdmin !== false || location.pathname === '/admin') return null;

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-background/95 backdrop-blur-md p-6">
      <div className="w-full max-w-md rounded-2xl border-2 border-destructive/40 bg-card shadow-2xl p-6 text-center space-y-5">
        <div className="w-16 h-16 mx-auto rounded-full bg-destructive/10 flex items-center justify-center">
          <Lock className="w-8 h-8 text-destructive" />
        </div>

        {/* English */}
        <div className="space-y-1.5">
          <h2 className="text-2xl font-bold text-foreground">{t('split.happening.title', { lng: 'en' })}</h2>
          <p className="text-base text-muted-foreground leading-relaxed">{t('split.happening.body', { lng: 'en' })}</p>
        </div>

        <div className="h-px bg-border" />

        {/* Slovenščina */}
        <div className="space-y-1.5">
          <h2 className="text-2xl font-bold text-foreground">{t('split.happening.title', { lng: 'sl' })}</h2>
          <p className="text-base text-muted-foreground leading-relaxed">{t('split.happening.body', { lng: 'sl' })}</p>
        </div>

        {/* Escape hatch — /admin is never locked, so the operator can always
            reach the toggle even if their admin status wasn't detected here. */}
        <button
          onClick={() => navigate('/admin')}
          className="mx-auto inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-muted text-muted-foreground text-sm font-medium hover:bg-muted/80 hover:text-foreground transition-colors"
        >
          <ShieldCheck className="w-4 h-4" />
          Admin
        </button>
      </div>
    </div>
  );
}
