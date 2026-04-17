import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanLine, KeyRound, Loader2, Leaf, X, Keyboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { QRScanner } from '@/components/QRScanner';
import { useAuth } from '@/contexts/AuthContext';
import lanaIconGreen from '@/assets/lana-icon-green.png';

const Login = () => {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [principlesOpen, setPrinciplesOpen] = useState(false);
  const [showManualInput, setShowManualInput] = useState(false);
  const [manualWif, setManualWif] = useState('');

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

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6">
      <div className="flex flex-col items-center gap-8 max-w-sm w-full">
        <div className="flex flex-col items-center gap-4">
          <div className="w-20 h-20 rounded-2xl bg-secondary flex items-center justify-center">
            <img src={lanaIconGreen} alt="Lana" className="w-12 h-12 object-contain dark:brightness-125" />
          </div>
          <div className="text-center space-y-2">
            <h1 className="font-display text-3xl font-bold text-foreground">Lana Pays.Us</h1>
            <p className="text-muted-foreground text-sm max-w-[280px]">
              {t('login.subtitle')}
            </p>
          </div>
        </div>

        <div className="w-full space-y-4">
          <Button
            onClick={() => setScannerOpen(true)}
            disabled={isLoggingIn}
            className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
          >
            {isLoggingIn ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                {t('login.signingIn')}
              </>
            ) : (
              <>
                <ScanLine className="w-5 h-5" />
                {t('login.scanButton')}
              </>
            )}
          </Button>

          {/* Manual WIF input toggle */}
          {!showManualInput ? (
            <button
              onClick={() => setShowManualInput(true)}
              className="w-full h-12 rounded-2xl text-sm font-medium gap-2 border-2 border-border text-foreground hover:bg-secondary transition-colors flex items-center justify-center"
            >
              <Keyboard className="w-4 h-4" />
              {t('login.enterManually')}
            </button>
          ) : (
            <div className="space-y-3">
              <textarea
                value={manualWif}
                onChange={e => setManualWif(e.target.value)}
                placeholder={t('login.wifPlaceholder')}
                rows={3}
                className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary resize-none"
                autoFocus
              />
              <Button
                onClick={() => {
                  const trimmed = manualWif.trim();
                  if (trimmed) handleScan(trimmed);
                }}
                disabled={!manualWif.trim() || isLoggingIn}
                className="w-full h-12 rounded-2xl text-sm font-semibold gap-2 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {isLoggingIn ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> {t('login.signingIn')}</>
                ) : (
                  <><KeyRound className="w-4 h-4" /> {t('login.signInButton')}</>
                )}
              </Button>
            </div>
          )}

          {error && (
            <div className="rounded-xl bg-destructive/10 border border-destructive/20 p-3">
              <p className="text-sm text-destructive text-center">{error}</p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 text-muted-foreground/60">
          <KeyRound className="w-4 h-4" />
          <span className="text-xs">{t('login.keysNeverLeave')}</span>
        </div>

        <button
          onClick={() => setPrinciplesOpen(true)}
          className="w-full rounded-2xl bg-primary/5 border border-primary/20 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform text-left mt-2"
        >
          <Leaf className="w-6 h-6 text-primary shrink-0" />
          <p className="text-sm font-medium text-foreground leading-snug">{t('principles.banner')}</p>
        </button>
      </div>

      {/* Principles Modal */}
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
                  <li>{t('principles.s1P1')}</li><li>{t('principles.s1P2')}</li><li>{t('principles.s1P3')}</li><li>{t('principles.s1P4')}</li>
                </ul>
              </div>
              <div>
                <h3 className="font-bold text-primary mb-2">{t('principles.s2Title')}</h3>
                <p className="text-muted-foreground mb-2">{t('principles.s2Intro')}</p>
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>{t('principles.s2P1')}</li><li>{t('principles.s2P2')}</li><li>{t('principles.s2P3')}</li><li>{t('principles.s2P4')}</li>
                </ul>
                <p className="text-muted-foreground mt-2 mb-2">{t('principles.s2Not')}</p>
                <ul className="list-disc list-inside space-y-1 text-destructive/80">
                  <li>{t('principles.s2N1')}</li><li>{t('principles.s2N2')}</li><li>{t('principles.s2N3')}</li><li>{t('principles.s2N4')}</li><li>{t('principles.s2N5')}</li>
                </ul>
              </div>
              <div>
                <h3 className="font-bold text-primary mb-2">{t('principles.s3Title')}</h3>
                <p className="text-muted-foreground mb-2">{t('principles.s3Intro')}</p>
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>{t('principles.s3P1')}</li><li>{t('principles.s3P2')}</li><li>{t('principles.s3P3')}</li><li>{t('principles.s3P4')}</li>
                </ul>
                <p className="text-muted-foreground mt-2 mb-2">{t('principles.s3Action')}</p>
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>{t('principles.s3A1')}</li><li>{t('principles.s3A2')}</li><li>{t('principles.s3A3')}</li><li>{t('principles.s3A4')}</li>
                </ul>
                <p className="text-muted-foreground mt-2 italic">{t('principles.s3Responsibility')}</p>
              </div>
              <div>
                <h3 className="font-bold text-primary mb-2">{t('principles.s4Title')}</h3>
                <p className="text-muted-foreground mb-2">{t('principles.s4Intro')}</p>
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>{t('principles.s4P1')}</li><li>{t('principles.s4P2')}</li><li>{t('principles.s4P3')}</li><li>{t('principles.s4P4')}</li>
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

      <QRScanner
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={handleScan}
        title={t('login.scanTitle')}
        description={t('login.scanDescription')}
      />
    </div>
  );
};

export default Login;
