import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Loader2, Leaf, X, ChevronRight } from 'lucide-react';
import { QRScanner } from '@/components/QRScanner';
import LandingSections from '@/components/LandingSections';
import { useAuth } from '@/contexts/AuthContext';
import { changeLanguage } from '@/i18n';
import lanaIconGreen from '@/assets/lana-icon-green.png';
import mandalaGreen from '@/assets/mandala-green-alpha.webp';
import '@/landing.css';

const REGISTER_URL = 'https://shop.lanapays.us/welcome';

const Login = () => {
  const { t, i18n } = useTranslation();
  const { login } = useAuth();
  const [scannerOpen, setScannerOpen]       = useState(false);
  const [isLoggingIn, setIsLoggingIn]       = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [principlesOpen, setPrinciplesOpen] = useState(false);
  const [showManualInput, setShowManualInput] = useState(false);
  const [manualWif, setManualWif]           = useState('');
  const rootRef   = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);

  const lang = i18n.language?.startsWith('sl') ? 'sl' : 'en';
  const registerHref = `${REGISTER_URL}?lang=${lang}`;

  const handleScan = async (data: string) => {
    setIsLoggingIn(true);
    setError(null);
    try {
      await login(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.failed'));
      setIsLoggingIn(false);
    }
  };

  // The page is scrollable (landing sits below the hero), so the full-screen
  // modals need the body held still while they are open.
  useEffect(() => {
    if (!principlesOpen && !scannerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [principlesOpen, scannerOpen]);

  // The feed's soul, ported: the fixed mandala is full-strength in the hero
  // and fades to a whisper once the reader scrolls past it. The same handler
  // gives the fixed header its solid, blurred state.
  useEffect(() => {
    const onScroll = () => {
      // Guard the divisor: innerHeight can be 0 on the very first call (before
      // layout, or in a backgrounded tab), which yields NaN — and a NaN custom
      // property makes the mandala invisible and never recovers on its own.
      const vh = window.innerHeight || 1;
      const heroProgress = Math.min(1, Math.max(0, window.scrollY / (vh * 0.75)));
      const fade = 1 - 0.88 * heroProgress;
      rootRef.current?.style.setProperty('--mandala-fade', String(Number.isFinite(fade) ? fade : 1));
      headerRef.current?.classList.toggle('is-scrolled', window.scrollY > 24);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="pays-landing" ref={rootRef}>

      {/* ── fixed atmosphere: mandala + grain + vignette ─────────────── */}
      <div
        className="pl-mandala-fixed"
        aria-hidden="true"
        style={{ ['--pl-mandala-src' as string]: `url(${mandalaGreen})` }}
      />
      <div className="pl-grain" aria-hidden="true" />
      <div className="pl-vignette" aria-hidden="true" />

      {/* ── fixed header: sign-in and registration always in reach ───── */}
      <header className="pl-header" ref={headerRef}>
        <a className="pl-wordmark" href="/login">Lana Pays.Us</a>
        <div className="pl-header-actions">
          <div className="pl-lang pl-lang-header" role="group" aria-label={t('landing.langLabel')}>
            <button type="button" className={lang === 'sl' ? 'is-active' : ''} onClick={() => changeLanguage('sl')}>SL</button>
            <button type="button" className={lang === 'en' ? 'is-active' : ''} onClick={() => changeLanguage('en')}>EN</button>
          </div>
          <button
            type="button"
            className="pl-btn-ghost"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            {t('landing.headerLogin')}
          </button>
          <a className="pl-btn-solid" href={registerHref} target="_blank" rel="noopener noreferrer">
            {t('landing.headerRegister')}
          </a>
        </div>
      </header>

      <div className="pl-content">

      {/* ══ HERO — the login itself, in the atmosphere it deserved ═════ */}
      <section className="pl-hero" id="vstop">
        <div className="pl-hero-kicker">{t('login.subtitle')}</div>
        <h1 className="pl-hero-title">{t('landing.heroTitle')}</h1>
        <p className="pl-hero-lead">{t('landing.heroLead')}</p>

        <div className="pl-hero-login">

        {/* The rosette around the entry button — kept exactly as merchants
            know it. The big fixed mandala behind is only a distant halo, so
            this crisp one stays the flower that frames the door. */}
        <div className="pl-rosette">
          <img
            src={mandalaGreen}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 w-full h-full object-contain opacity-65 dark:opacity-35 pointer-events-none select-none"
          />

        <button
          onClick={() => setScannerOpen(true)}
          disabled={isLoggingIn}
          className="group relative flex flex-col items-center justify-center w-[170px] h-[170px] rounded-full transition-transform duration-200 active:scale-95 hover:scale-[1.03] disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none z-10"
          style={{
            background: 'radial-gradient(circle at 42% 36%, #34b07a, #155c3e)',
            boxShadow: '0 0 40px rgba(34,160,90,.38), 0 6px 24px rgba(21,92,62,.45), inset 0 1px 0 rgba(255,255,255,.12)',
          }}
        >
          <div className="absolute inset-[-5px] rounded-full opacity-30 group-hover:opacity-50 transition-opacity"
            style={{ background: 'radial-gradient(circle, rgba(52,176,122,.3) 0%, transparent 70%)' }} />

          {isLoggingIn ? (
            <Loader2 className="w-10 h-10 text-white animate-spin" />
          ) : (
            <>
              <img
                src={lanaIconGreen}
                alt=""
                className="w-12 h-12 object-contain mb-1.5"
                style={{ filter: 'brightness(0) invert(1)' }}
              />
              <span className="text-white font-bold text-base leading-tight">{t('login.scanToEnter')}</span>
              <span className="text-white/75 text-[10px] mt-0.5">{t('login.useYourKey')}</span>
            </>
          )}
        </button>
        </div>

        {/* Registration — right where a new merchant first looks, not buried */}
        <p className="pl-hero-register">
          {t('landing.heroRegisterPrompt')}{' '}
          <a href={registerHref} target="_blank" rel="noopener noreferrer">{t('landing.ctaRegister')}</a>
        </p>

        {/* Security note + manual entry + principles — the familiar controls */}
        <div className="px-6 w-full max-w-sm flex flex-col items-center gap-3">

        {/* Security note */}
        <div className="flex items-center gap-2 text-muted-foreground/60">
          <KeyRound className="w-3.5 h-3.5 shrink-0" />
          <span className="text-xs text-center leading-snug">{t('login.keysNeverLeave')}</span>
        </div>

        {/* Manual WIF section */}
        {!showManualInput ? (
          <button
            onClick={() => setShowManualInput(true)}
            className="flex items-center gap-1 text-sm font-medium text-primary hover:underline transition-colors"
          >
            {t('login.enterManually')}
            <ChevronRight className="w-4 h-4" />
          </button>
        ) : (
          <div className="w-full space-y-3">
            <input
              type="password"
              value={manualWif}
              onChange={e => setManualWif(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { const w = manualWif.trim(); if (w && !isLoggingIn) handleScan(w); } }}
              placeholder={t('login.wifPlaceholder')}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary shadow-sm"
              autoFocus
            />
            <button
              onClick={() => { const w = manualWif.trim(); if (w) handleScan(w); }}
              disabled={!manualWif.trim() || isLoggingIn}
              className="w-full h-12 rounded-2xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2 transition-colors shadow-md shadow-primary/25"
            >
              {isLoggingIn
                ? <><Loader2 className="w-4 h-4 animate-spin" /> {t('login.signingIn')}</>
                : <><KeyRound className="w-4 h-4" /> {t('login.signInButton')}</>
              }
            </button>
            <button
              onClick={() => { setShowManualInput(false); setManualWif(''); setError(null); }}
              className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors text-center"
            >
              ✕ {t('login.scanButton')}
            </button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-xl bg-destructive/10 border border-destructive/20 p-3 w-full">
            <p className="text-sm text-destructive text-center">{error}</p>
          </div>
        )}

        {/* Principles banner */}
        <button
          onClick={() => setPrinciplesOpen(true)}
          className="w-full rounded-2xl bg-primary/5 border border-primary/20 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform text-left"
        >
          <Leaf className="w-5 h-5 text-primary shrink-0" />
          <p className="text-xs font-medium text-foreground leading-snug">{t('principles.banner')}</p>
        </button>

        </div>{/* max-w-sm controls */}
        </div>{/* pl-hero-login */}

        <div className="pl-scroll-cue">{t('landing.scrollCue')}</div>
      </section>
      {/* ══ end of hero ═══════════════════════════════════════════════ */}

      {/* ── The landing: what this app is for ────────────────────────── */}
      <LandingSections />

      </div>{/* pl-content */}

      {/* ── QR Scanner modal ─────────────────────────────────────────── */}
      <QRScanner
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={handleScan}
        title={t('login.scanTitle')}
        description={t('login.scanDescription')}
        onManualEntry={() => { setScannerOpen(false); setShowManualInput(true); }}
      />

      {/* ── Principles modal ──────────────────────────────────────────── */}
      {principlesOpen && (
        <>
          <div className="fixed inset-0 bg-foreground/30 backdrop-blur-sm z-[80]" onClick={() => setPrinciplesOpen(false)} />
          <div className="fixed inset-4 z-[90] bg-card rounded-2xl border border-border shadow-xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
              <h2 className="font-display font-bold text-foreground text-lg">{t('principles.title')}</h2>
              <button onClick={() => setPrinciplesOpen(false)} className="w-9 h-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-5 text-sm text-foreground leading-relaxed">
              <p className="text-muted-foreground">{t('principles.subtitle')}</p>
              <div>
                <h3 className="font-bold text-primary mb-2">{t('principles.s1Title')}</h3>
                <p className="text-muted-foreground mb-2">{t('principles.s1Intro')}</p>
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>{t('principles.s1P1')}</li><li>{t('principles.s1P2')}</li>
                  <li>{t('principles.s1P3')}</li><li>{t('principles.s1P4')}</li>
                </ul>
              </div>
              <div>
                <h3 className="font-bold text-primary mb-2">{t('principles.s2Title')}</h3>
                <p className="text-muted-foreground mb-2">{t('principles.s2Intro')}</p>
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>{t('principles.s2P1')}</li><li>{t('principles.s2P2')}</li>
                  <li>{t('principles.s2P3')}</li><li>{t('principles.s2P4')}</li>
                </ul>
                <p className="text-muted-foreground mt-2 mb-2">{t('principles.s2Not')}</p>
                <ul className="list-disc list-inside space-y-1 text-destructive/80">
                  <li>{t('principles.s2N1')}</li><li>{t('principles.s2N2')}</li>
                  <li>{t('principles.s2N3')}</li><li>{t('principles.s2N4')}</li>
                  <li>{t('principles.s2N5')}</li>
                </ul>
              </div>
              <div>
                <h3 className="font-bold text-primary mb-2">{t('principles.s3Title')}</h3>
                <p className="text-muted-foreground mb-2">{t('principles.s3Intro')}</p>
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>{t('principles.s3P1')}</li><li>{t('principles.s3P2')}</li>
                  <li>{t('principles.s3P3')}</li><li>{t('principles.s3P4')}</li>
                </ul>
                <p className="text-muted-foreground mt-2 mb-2">{t('principles.s3Action')}</p>
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>{t('principles.s3A1')}</li><li>{t('principles.s3A2')}</li>
                  <li>{t('principles.s3A3')}</li><li>{t('principles.s3A4')}</li>
                </ul>
                <p className="text-muted-foreground mt-2 italic">{t('principles.s3Responsibility')}</p>
              </div>
              <div>
                <h3 className="font-bold text-primary mb-2">{t('principles.s4Title')}</h3>
                <p className="text-muted-foreground mb-2">{t('principles.s4Intro')}</p>
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>{t('principles.s4P1')}</li><li>{t('principles.s4P2')}</li>
                  <li>{t('principles.s4P3')}</li><li>{t('principles.s4P4')}</li>
                </ul>
                <p className="text-muted-foreground mt-2">{t('principles.s4Restore')}</p>
                <p className="text-muted-foreground mt-1">{t('principles.s4Repeated')}</p>
              </div>
              <div className="rounded-xl bg-primary/5 border border-primary/20 p-4">
                <p className="text-sm font-bold text-primary text-center italic">{t('principles.core')}</p>
                <p className="text-xs text-muted-foreground text-center mt-2">{t('principles.closing')}</p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default Login;
