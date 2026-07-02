import { useEffect, useState } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';

/**
 * Full-screen HARD lock shown while a Split is in progress. Driven by the
 * admin-toggled `split_happening` flag (mobile app_settings), surfaced on
 * /api/system-params and polled here every 30s. Covers every authed route
 * EXCEPT /admin — the operator must still reach the toggle to turn it off.
 *
 * No dismiss control: it clears only when the flag goes false. The notice is
 * shown in BOTH English and Slovenian regardless of the selected locale (the
 * seller could be either), via the i18n per-call `lng` override.
 */
export function SplitLockOverlay() {
  const { t } = useTranslation();
  const location = useLocation();
  const [locked, setLocked] = useState(false);

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

  // Never cover the admin page — the operator needs it to unlock.
  if (!locked || location.pathname === '/admin') return null;

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

        {/* Discreet path back to admin so the operator can unlock. */}
        <Link to="/admin" className="inline-block text-xs text-muted-foreground/50 hover:text-muted-foreground underline">
          Admin
        </Link>
      </div>
    </div>
  );
}
