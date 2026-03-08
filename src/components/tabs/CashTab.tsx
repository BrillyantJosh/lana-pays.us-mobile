import { useState, useEffect, useRef } from "react";
import { Camera, PoundSterling, DollarSign, Euro, Loader2, AlertCircle, ExternalLink, CheckCircle2, X, ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QRScanner } from "@/components/QRScanner";
import { useAuth } from "@/contexts/AuthContext";

const currencyIcons: Record<string, typeof PoundSterling> = {
  GBP: PoundSterling,
  USD: DollarSign,
  EUR: Euro,
};

const CURRENCY_SYMBOL: Record<string, string> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
};

interface UploadedImage {
  url: string;
  preview: string; // local blob URL for thumbnail
}

interface CashTabProps {
  selectedWallet?: string | null;
  onClearWallet?: () => void;
}

const CashTab = ({ selectedWallet, onClearWallet }: CashTabProps) => {
  const { session } = useAuth();
  const currency = session?.currency || 'GBP';
  const CurrencyIcon = currencyIcons[currency] || PoundSterling;
  const currencySymbol = CURRENCY_SYMBOL[currency] || '£';
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step state
  const [step, setStep] = useState<1 | 2>(1);
  const [walletId, setWalletId] = useState<string | null>(null);

  // Step 1 state
  const [scannerOpen, setScannerOpen] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [isFrozen, setIsFrozen] = useState(false);

  // Step 2 state
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  // Cross-tab entry: if selectedWallet is set, skip to step 2
  useEffect(() => {
    if (selectedWallet) {
      setWalletId(selectedWallet);
      setStep(2);
      setCheckError(null);
      setIsFrozen(false);
    }
  }, [selectedWallet]);

  // Auto-open scanner on step 1 entry (only when no wallet set)
  useEffect(() => {
    if (step === 1 && !walletId && !checkError && !isChecking && !isFrozen) {
      setScannerOpen(true);
    }
  }, [step]);

  const resetToStep1 = () => {
    setStep(1);
    setWalletId(null);
    setCheckError(null);
    setIsFrozen(false);
    setInvoiceNumber("");
    setAmount("");
    // Revoke blob URLs
    images.forEach(img => URL.revokeObjectURL(img.preview));
    setImages([]);
    setUploadError(null);
    setSubmitted(false);
    onClearWallet?.();
    setScannerOpen(true);
  };

  // Validate and check wallet registration
  const handleWalletScan = async (data: string) => {
    const trimmed = data.trim();

    if (!trimmed.startsWith('L') || trimmed.length < 26 || trimmed.length > 35) {
      setCheckError('Invalid Wallet ID. A valid Lana wallet address starts with "L" and is 26-35 characters long.');
      return;
    }

    setIsChecking(true);
    setCheckError(null);
    setIsFrozen(false);

    try {
      const res = await fetch('/api/check-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_id: trimmed }),
      });
      const json = await res.json();

      if (json.success) {
        if (!json.registered) {
          setCheckError('This wallet is not registered. Only registered wallets can be used for cash payments.');
          return;
        }
        if (json.wallet?.frozen) {
          setIsFrozen(true);
          return;
        }
        // Registered and not frozen — advance to step 2
        setWalletId(trimmed);
        setStep(2);
      } else {
        setCheckError(json.message || 'Failed to verify wallet registration.');
      }
    } catch {
      setCheckError('Failed to check wallet registration. Please try again.');
    } finally {
      setIsChecking(false);
    }
  };

  // Handle file selection and upload
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);
    setUploadError(null);

    try {
      const formData = new FormData();
      for (let i = 0; i < files.length; i++) {
        formData.append('images', files[i]);
      }

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      const json = await res.json();

      if (!res.ok) {
        throw new Error(json.error || 'Upload failed');
      }

      // Create local preview URLs and pair with server URLs
      const newImages: UploadedImage[] = [];
      for (let i = 0; i < files.length; i++) {
        newImages.push({
          url: json.urls[i],
          preview: URL.createObjectURL(files[i]),
        });
      }

      setImages(prev => [...prev, ...newImages]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to upload images');
    } finally {
      setIsUploading(false);
      // Reset file input so same file can be selected again
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const removeImage = (index: number) => {
    setImages(prev => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  const canConfirm = invoiceNumber.trim() && amount.trim() && images.length > 0;

  const handleConfirm = () => {
    if (!canConfirm || !walletId) return;

    console.log('Cash payment (mock):', {
      walletId,
      invoiceNumber: invoiceNumber.trim(),
      amount: parseFloat(amount),
      currency,
      imageUrls: images.map(img => img.url),
    });

    setSubmitted(true);
  };

  // ─── Frozen Banner ──────────────────────────
  const FrozenBanner = () => (
    <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4 space-y-3">
      <div className="flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0" />
        <p className="text-sm font-medium text-destructive">This wallet is frozen</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Spending is disabled for this wallet. Visit the unfreeze portal to resolve this.
      </p>
      <a
        href="https://unfreeze.lanapays.us"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 w-full h-11 rounded-xl bg-destructive/10 text-destructive text-sm font-semibold hover:bg-destructive/20 transition-colors"
      >
        <ExternalLink className="w-4 h-4" />
        Go to Unfreeze Portal
      </a>
      <Button
        onClick={resetToStep1}
        variant="ghost"
        className="w-full h-10 rounded-xl text-sm text-muted-foreground"
      >
        Scan Another Wallet
      </Button>
    </div>
  );

  // ─── STEP 1: Scan Wallet ────────────────────
  if (step === 1) {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <CurrencyIcon className="w-7 h-7 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">Cash Payment</h2>
            <p className="text-muted-foreground text-sm">Scan customer wallet to begin</p>
          </div>
        </div>

        {/* Loading */}
        {isChecking && (
          <div className="flex flex-col items-center gap-3 py-12">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Checking wallet registration...</p>
          </div>
        )}

        {/* Error */}
        {checkError && !isChecking && (
          <div className="space-y-4">
            <div className="rounded-2xl bg-destructive/10 border border-destructive/20 p-4">
              <p className="text-sm text-destructive text-center">{checkError}</p>
            </div>
            <Button
              onClick={() => { setCheckError(null); setScannerOpen(true); }}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Camera className="w-5 h-5" />
              Scan Again
            </Button>
          </div>
        )}

        {/* Frozen */}
        {isFrozen && !isChecking && <FrozenBanner />}

        {/* Idle — show scan button */}
        {!isChecking && !checkError && !isFrozen && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Button
              onClick={() => setScannerOpen(true)}
              className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
            >
              <Camera className="w-5 h-5" />
              Scan Wallet ID
            </Button>
          </div>
        )}

        <QRScanner
          isOpen={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onScan={handleWalletScan}
          title="Scan Wallet ID"
          description="Scan a customer's Lana Wallet ID for cash payment"
        />
      </div>
    );
  }

  // ─── STEP 2: Submitted ──────────────────────
  if (submitted) {
    return (
      <div className="flex flex-col gap-5 px-6 py-4">
        <div className="flex flex-col items-center gap-3 py-8">
          <CheckCircle2 className="w-12 h-12 text-primary" />
          <h2 className="text-xl font-bold text-foreground">Payment Confirmed</h2>
          <p className="text-sm text-muted-foreground text-center">
            Invoice #{invoiceNumber} — {currencySymbol}{amount}
          </p>
          <p className="text-xs text-muted-foreground truncate max-w-full">
            Wallet: {walletId}
          </p>
          <p className="text-xs text-muted-foreground">
            {images.length} invoice image{images.length !== 1 ? 's' : ''} attached
          </p>
        </div>

        <Button
          onClick={resetToStep1}
          className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20"
        >
          New Payment
        </Button>
      </div>
    );
  }

  // ─── STEP 2: Invoice Details ─────────────────
  return (
    <div className="flex flex-col gap-5 px-6 py-4">
      {/* Header with wallet info */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center shrink-0">
            <CurrencyIcon className="w-7 h-7 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">Cash Payment</h2>
            <p className="text-muted-foreground text-xs font-mono truncate max-w-[180px]">
              {walletId}
            </p>
          </div>
        </div>
        <button
          onClick={resetToStep1}
          className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
        >
          Change
        </button>
      </div>

      {/* Invoice form */}
      <div className="glass-card rounded-2xl p-5 space-y-4">
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">
            Invoice Number <span className="text-destructive">*</span>
          </Label>
          <Input
            placeholder="e.g. 2024-001234"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            className="h-12 rounded-xl bg-background border-input"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">
            Amount ({currencySymbol}) <span className="text-destructive">*</span>
          </Label>
          <Input
            type="number"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-12 rounded-xl bg-background border-input"
          />
        </div>
      </div>

      {/* Invoice images */}
      <div className="space-y-3">
        <Label className="text-sm font-medium text-foreground">
          Invoice Photos <span className="text-destructive">*</span>
        </Label>

        {/* Image thumbnails */}
        {images.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {images.map((img, i) => (
              <div key={i} className="relative aspect-square rounded-xl overflow-hidden border border-border">
                <img
                  src={img.preview}
                  alt={`Invoice ${i + 1}`}
                  className="w-full h-full object-cover"
                />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute top-1 right-1 w-6 h-6 rounded-full bg-destructive/90 text-white flex items-center justify-center"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Upload error */}
        {uploadError && (
          <div className="rounded-xl bg-destructive/10 border border-destructive/20 p-3">
            <p className="text-xs text-destructive text-center">{uploadError}</p>
          </div>
        )}

        {/* Add photo button */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={handleFileChange}
          className="hidden"
        />

        <Button
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          variant="outline"
          className="w-full h-14 rounded-2xl text-base font-semibold gap-3 border-2"
        >
          {isUploading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Uploading...
            </>
          ) : (
            <>
              <ImagePlus className="w-5 h-5" />
              {images.length === 0 ? 'Scan Invoice' : 'Add Another Photo'}
            </>
          )}
        </Button>
      </div>

      {/* Confirm button */}
      <Button
        onClick={handleConfirm}
        disabled={!canConfirm}
        className="w-full h-14 rounded-2xl text-base font-semibold gap-3 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 disabled:opacity-50"
      >
        Confirm Payment
      </Button>
    </div>
  );
};

export default CashTab;
