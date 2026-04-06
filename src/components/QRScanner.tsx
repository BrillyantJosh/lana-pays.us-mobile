import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import jsQR from 'jsqr';
import { Button } from '@/components/ui/button';
import { X, QrCode, Loader2 } from 'lucide-react';
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

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const hasScannedRef = useRef(false);

  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    hasScannedRef.current = false;
    setError(null);

    // Small delay to let the dialog render the video element
    const timer = setTimeout(() => startCamera(), 150);

    return () => {
      clearTimeout(timer);
      cleanup();
    };
  }, [isOpen]);

  const scanFrame = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2 || hasScannedRef.current) {
      animFrameRef.current = requestAnimationFrame(scanFrame);
      return;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    // Preprocessing: grayscale + high contrast + brightness boost.
    // Neutralises glare and metallic reflections so jsQR sees a clean
    // black/white image regardless of the surface material.
    ctx.filter = 'grayscale(100%) contrast(220%) brightness(115%)';
    ctx.drawImage(video, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // jsQR: pure JavaScript QR decoder — no WASM, no worker, works on
    // all browsers including older Android Chrome and iOS Safari.
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'attemptBoth', // try normal AND inverted (for dark metal)
    });

    if (code && !hasScannedRef.current) {
      hasScannedRef.current = true;
      cleanup();
      onScan(code.data);
      onClose();
      return;
    }

    animFrameRef.current = requestAnimationFrame(scanFrame);
  };

  const startCamera = async () => {
    try {
      // Use constraints instead of listDevices — works on iOS Safari
      // before permission is granted, and picks back camera automatically
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setIsScanning(true);
        setError(null);
        animFrameRef.current = requestAnimationFrame(scanFrame);
      }
    } catch (err) {
      console.error('Camera error:', err);
      setError(t('qrScanner.cameraError'));
    }
  };

  const cleanup = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setIsScanning(false);
  };

  const handleClose = () => {
    cleanup();
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
          <div className="relative aspect-square bg-background rounded-lg overflow-hidden">
            {/* Live video shown to the user */}
            <video
              ref={videoRef}
              className="w-full h-full object-cover"
              playsInline
              muted
            />
            {/* Hidden canvas used for contrast preprocessing before decoding */}
            <canvas ref={canvasRef} className="hidden" />

            {!isScanning && !error && (
              <div className="absolute inset-0 flex items-center justify-center bg-muted/50">
                <Loader2 className="w-8 h-8 animate-spin text-primary" />
              </div>
            )}

            {isScanning && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-0 left-0 w-10 h-10 border-l-4 border-t-4 border-primary rounded-tl-lg" />
                <div className="absolute top-0 right-0 w-10 h-10 border-r-4 border-t-4 border-primary rounded-tr-lg" />
                <div className="absolute bottom-0 left-0 w-10 h-10 border-l-4 border-b-4 border-primary rounded-bl-lg" />
                <div className="absolute bottom-0 right-0 w-10 h-10 border-r-4 border-b-4 border-primary rounded-br-lg" />
              </div>
            )}
          </div>

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
