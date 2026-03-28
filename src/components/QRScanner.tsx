import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Html5Qrcode } from 'html5-qrcode';
import { Button } from '@/components/ui/button';
import { X, QrCode } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

interface QRScannerProps {
  isOpen: boolean;
  onClose: () => void;
  onScan: (data: string) => void;
  title?: string;
  description?: string;
  children?: React.ReactNode;
}

export function QRScanner({ isOpen, onClose, onScan, title, description, children }: QRScannerProps) {
  const { t } = useTranslation();
  const resolvedTitle = title || t('qrScanner.defaultTitle');
  const resolvedDescription = description || t('qrScanner.defaultDescription');
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasScannedRef = useRef(false);

  useEffect(() => {
    if (isOpen && !isScanning) {
      hasScannedRef.current = false;

      const timer = setTimeout(() => {
        startScanner();
      }, 100);

      return () => clearTimeout(timer);
    }

    return () => {
      if (scannerRef.current && isScanning) {
        stopScanner();
      }
    };
  }, [isOpen]);

  const startScanner = async () => {
    try {
      const cameras = await Html5Qrcode.getCameras();

      if (!cameras || cameras.length === 0) {
        setError(t('qrScanner.noCamera'));
        return;
      }

      let selectedCamera = cameras[0];
      if (cameras.length > 1) {
        const backCamera = cameras.find(camera =>
          camera.label.toLowerCase().includes('back') ||
          camera.label.toLowerCase().includes('rear')
        );
        if (backCamera) {
          selectedCamera = backCamera;
        }
      }

      const scanner = new Html5Qrcode('qr-reader');
      scannerRef.current = scanner;

      await scanner.start(
        selectedCamera.id,
        {
          fps: 10,
          qrbox: { width: 250, height: 250 }
        },
        (decodedText) => {
          if (hasScannedRef.current) return;
          hasScannedRef.current = true;

          onScan(decodedText);
          stopScanner();
          onClose();
        },
        () => {
          // Ignore scan errors during scanning
        }
      );

      setIsScanning(true);
      setError(null);
    } catch (err) {
      console.error('Failed to start scanner:', err);
      setError(t('qrScanner.cameraError'));
    }
  };

  const stopScanner = async () => {
    if (scannerRef.current && isScanning) {
      try {
        await scannerRef.current.stop();
        scannerRef.current = null;
        setIsScanning(false);
      } catch (err) {
        console.error('Failed to stop scanner:', err);
      }
    }
  };

  const handleClose = async () => {
    await stopScanner();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="w-5 h-5" />
            {resolvedTitle}
          </DialogTitle>
          <DialogDescription>
            {resolvedDescription}
          </DialogDescription>
        </DialogHeader>

        {children}

        <div className="space-y-4">
          <div id="qr-reader" className="w-full rounded-lg overflow-hidden" />

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <Button onClick={handleClose} variant="outline" className="w-full">
            <X className="w-4 h-4 mr-2" />
            {t('common.cancel')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
