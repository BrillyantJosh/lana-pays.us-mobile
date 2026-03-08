import { useState } from 'react';
import { ScanLine, KeyRound, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { QRScanner } from '@/components/QRScanner';
import { useAuth } from '@/contexts/AuthContext';
import lanaIconGreen from '@/assets/lana-icon-green.png';

const Login = () => {
  const { login } = useAuth();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleScan = async (data: string) => {
    setIsLoggingIn(true);
    setError(null);

    try {
      await login(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      setIsLoggingIn(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6">
      <div className="flex flex-col items-center gap-8 max-w-sm w-full">
        <div className="flex flex-col items-center gap-4">
          <div className="w-20 h-20 rounded-2xl bg-secondary flex items-center justify-center">
            <img src={lanaIconGreen} alt="Lana" className="w-12 h-12 object-contain" />
          </div>
          <div className="text-center space-y-2">
            <h1 className="font-display text-3xl font-bold text-foreground">Lana Pays.Us</h1>
            <p className="text-muted-foreground text-sm max-w-[280px]">
              Scan your Lana WIF Private Key to sign in
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
                Signing in...
              </>
            ) : (
              <>
                <ScanLine className="w-5 h-5" />
                Scan WIF Key
              </>
            )}
          </Button>

          {error && (
            <div className="rounded-xl bg-destructive/10 border border-destructive/20 p-3">
              <p className="text-sm text-destructive text-center">{error}</p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 text-muted-foreground/60">
          <KeyRound className="w-4 h-4" />
          <span className="text-xs">Your keys never leave your device</span>
        </div>
      </div>

      <QRScanner
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={handleScan}
        title="Scan WIF Key"
        description="Scan your Lana WIF Private Key QR code to sign in"
      />
    </div>
  );
};

export default Login;
