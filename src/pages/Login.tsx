import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ChevronDown, KeyRound, Leaf, Loader2, LockKeyhole, Menu, QrCode, X } from 'lucide-react';
import { QRScanner } from '@/components/QRScanner';
import LandingSections from '@/components/LandingSections';
import { useAuth } from '@/contexts/AuthContext';
import { changeLanguage } from '@/i18n';
import abundanceHero from '@/assets/abundance-garden-hero.webp';
import abundanceHeroLoop from '@/assets/abundance-garden-breeze-loop.mp4';
import mandalaHeaderWhite from '@/assets/mandala-header-white-v2.png';
import mandalaGreen from '@/assets/mandala-green-alpha.webp';
import '@/landing.css';

const REGISTER_URL = 'https://shop.lanapays.us/welcome';

const Login = () => {
  const { t, i18n } = useTranslation();
  const { login } = useAuth();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [principlesOpen, setPrinciplesOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [manualWif, setManualWif] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);

  const lang = i18n.language?.startsWith('sl') ? 'sl' : 'en';
  const registerHref = `${REGISTER_URL}?lang=${lang}`;
  const copy = lang === 'sl'
    ? {
        eyebrow: 'Najlepše stvari življenja že ustvarjate vi',
        heroLine1: 'Živite v obilju.',
        heroLine2: 'Poslujte v harmoniji.',
        loginLabel: 'Vnesite svoj Lana WIF ali skenirajte',
        scanShort: 'Skeniraj',
        secure: 'Vaša povezava je varna. Ključ nikoli ne zapusti naprave.',
        navHome: 'Domov',
        navAbundance: 'Obilje',
        navServices: 'Možnosti',
        navHow: 'Kako deluje',
        navTrust: 'Zaupanje',
        enter: 'Vstop v Lana Pays',
        discover: 'Odkrijte svet Lana Pays',
        principles: 'Načela sodelovanja',
      }
    : {
        eyebrow: 'You already create the best things in life',
        heroLine1: 'Live in abundance.',
        heroLine2: 'Trade in harmony.',
        loginLabel: 'Enter your Lana WIF or scan it',
        scanShort: 'Scan',
        secure: 'Your connection is secure. Your key never leaves this device.',
        navHome: 'Home',
        navAbundance: 'Abundance',
        navServices: 'Options',
        navHow: 'How it works',
        navTrust: 'Trust',
        enter: 'Enter Lana Pays',
        discover: 'Discover Lana Pays',
        principles: 'Participation principles',
      };

  const handleLogin = async (data: string) => {
    setIsLoggingIn(true);
    setError(null);
    try {
      await login(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.failed'));
      setIsLoggingIn(false);
    }
  };

  const submitManualKey = () => {
    const key = manualWif.trim();
    if (key && !isLoggingIn) handleLogin(key);
  };

  useEffect(() => {
    if (!principlesOpen && !scannerOpen && !mobileNavOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [principlesOpen, scannerOpen, mobileNavOpen]);

  useEffect(() => {
    const onScroll = () => {
      headerRef.current?.classList.toggle('is-scrolled', window.scrollY > 28);
      rootRef.current?.style.setProperty('--pl-scroll', String(Math.min(1, window.scrollY / 900)));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const scrollToLogin = () => {
    setMobileNavOpen(false);
    document.getElementById('vstop')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="pays-landing" ref={rootRef}>
      <div className="pl-grain" aria-hidden="true" />
      <div className="pl-vignette" aria-hidden="true" />

      <header className="pl-header" ref={headerRef}>
        <a className="pl-brand" href="#domov" aria-label="Lana Pays.Us">
          <span className="pl-brand-mark" aria-hidden="true">
            <img src={mandalaHeaderWhite} alt="" />
          </span>
          <span>
            <strong>Lana Pays.Us</strong>
            <small>{t('landing.heroTitle')}</small>
          </span>
        </a>

        <nav className={`pl-nav ${mobileNavOpen ? 'is-open' : ''}`} aria-label="Primary">
          <a href="#domov" onClick={() => setMobileNavOpen(false)}>{copy.navHome}</a>
          <a href="#obilje" onClick={() => setMobileNavOpen(false)}>{copy.navAbundance}</a>
          <a href="#moznosti" onClick={() => setMobileNavOpen(false)}>{copy.navServices}</a>
          <a href="#kako" onClick={() => setMobileNavOpen(false)}>{copy.navHow}</a>
          <a href="#zaupanje" onClick={() => setMobileNavOpen(false)}>{copy.navTrust}</a>
        </nav>

        <div className="pl-header-actions">
          <div className="pl-lang" role="group" aria-label={t('landing.langLabel')}>
            <button type="button" className={lang === 'sl' ? 'is-active' : ''} onClick={() => changeLanguage('sl')}>SL</button>
            <button type="button" className={lang === 'en' ? 'is-active' : ''} onClick={() => changeLanguage('en')}>EN</button>
          </div>
          <button type="button" className="pl-btn-gold" onClick={scrollToLogin}>{copy.enter}</button>
          <button
            type="button"
            className="pl-menu-button"
            onClick={() => setMobileNavOpen(open => !open)}
            aria-expanded={mobileNavOpen}
            aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
          >
            {mobileNavOpen ? <X /> : <Menu />}
          </button>
        </div>
      </header>

      <main>
        <section className="pl-hero" id="domov" aria-labelledby="pl-hero-title">
          <div className="pl-hero-scene" aria-hidden="true">
            <img src={abundanceHero} alt="" className="pl-hero-image" />
            <video className="pl-hero-video" autoPlay muted loop playsInline preload="auto" poster={abundanceHero}>
              <source src={abundanceHeroLoop} type="video/mp4" />
            </video>
            <div className="pl-light-rays" />
            <div className="pl-lake-shimmer" />
            <div className="pl-fine-rain" />
          </div>

          <div className="pl-mandala-veil" aria-hidden="true">
            <img src={mandalaGreen} alt="" />
          </div>

          <div className="pl-floating-petals" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => (
              <i key={index} style={{ '--i': index } as CSSProperties} />
            ))}
          </div>

          <div className="pl-hero-content">
            <p className="pl-hero-kicker">{copy.eyebrow}</p>
            <h1 id="pl-hero-title">
              <span>{copy.heroLine1}</span>
              <span>{copy.heroLine2}</span>
            </h1>
            <div className="pl-gold-divider" aria-hidden="true"><span>✦</span></div>
            <p className="pl-hero-lead">{t('landing.heroLead')}</p>

            <div className="pl-entry-card" id="vstop">
              <div className="pl-entry-title">
                <span>{copy.loginLabel}</span>
                <LockKeyhole aria-hidden="true" />
              </div>
              <div className="pl-entry-row">
                <input
                  type="password"
                  value={manualWif}
                  onChange={event => setManualWif(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') submitManualKey(); }}
                  placeholder={t('login.wifPlaceholder')}
                  aria-label={copy.loginLabel}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="pl-entry-submit"
                  onClick={submitManualKey}
                  disabled={!manualWif.trim() || isLoggingIn}
                >
                  {isLoggingIn ? <Loader2 className="pl-spin" /> : <ArrowRight />}
                  <span>{t('login.signInButton')}</span>
                </button>
                <span className="pl-entry-or">{lang === 'sl' ? 'ali' : 'or'}</span>
                <button type="button" className="pl-entry-scan" onClick={() => setScannerOpen(true)}>
                  <QrCode />
                  <span>{copy.scanShort}</span>
                </button>
              </div>
              <p className="pl-security-note"><KeyRound /> {copy.secure}</p>
              {error && <p className="pl-entry-error" role="alert">{error}</p>}
            </div>

            <div className="pl-hero-links">
              <a href={registerHref} target="_blank" rel="noopener noreferrer">
                {t('landing.heroRegisterPrompt')} <strong>{t('landing.ctaRegister')}</strong>
              </a>
              <button type="button" onClick={() => setPrinciplesOpen(true)}>
                <Leaf /> {copy.principles}
              </button>
            </div>
          </div>

          <a className="pl-scroll-cue" href="#obilje">
            <span>{copy.discover}</span>
            <ChevronDown />
          </a>
        </section>

        <LandingSections />
      </main>

      <QRScanner
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={handleLogin}
        title={t('login.scanTitle')}
        description={t('login.scanDescription')}
        onManualEntry={() => setScannerOpen(false)}
      />

      {principlesOpen && (
        <>
          <div className="pl-modal-backdrop" onClick={() => setPrinciplesOpen(false)} />
          <div className="pl-principles-modal" role="dialog" aria-modal="true" aria-labelledby="principles-title">
            <div className="pl-modal-head">
              <div>
                <span>{t('landing.trustEyebrow')}</span>
                <h2 id="principles-title">{t('principles.title')}</h2>
              </div>
              <button type="button" onClick={() => setPrinciplesOpen(false)} aria-label="Close"><X /></button>
            </div>
            <div className="pl-modal-body">
              <p>{t('principles.subtitle')}</p>
              {[1, 2, 3, 4].map(section => (
                <section key={section}>
                  <h3>{t(`principles.s${section}Title`)}</h3>
                  <p>{t(`principles.s${section}Intro`)}</p>
                  <ul>
                    {[1, 2, 3, 4].map(item => <li key={item}>{t(`principles.s${section}P${item}`)}</li>)}
                  </ul>
                </section>
              ))}
              <blockquote>{t('principles.core')}</blockquote>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default Login;
