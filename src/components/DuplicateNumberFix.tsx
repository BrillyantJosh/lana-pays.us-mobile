import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { canContinueAfterHit, type DedupHit } from '@/lib/receiptDedup';

/**
 * Shown under the "already used" banner when the pre-check hit the NUMBER.
 * The reader may simply have misread it (Alaja: a wrapped number read as its
 * first line only), so the seller can type the number printed on this
 * receipt and go on. The brain still checks whatever number is sent.
 */
export function DuplicateNumberFix({ hit, value, onChange, onContinue, checking, disabled }: {
  hit: DedupHit;
  value: string;
  onChange: (value: string) => void;
  onContinue: () => void;
  checking?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const ready = canContinueAfterHit(hit, value) && !checking && !disabled;
  return (
    <div className="glass-card rounded-2xl p-4 space-y-3">
      <div className="space-y-2">
        <Label htmlFor="dedup-fix-number" className="text-sm font-medium text-foreground">{t('cash.fixInvoiceNumber')}</Label>
        <Input
          id="dedup-fix-number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('cash.invoicePlaceholder')}
          className="h-12 rounded-xl bg-background border-input"
        />
        <p className="text-xs text-muted-foreground">{t('cash.fixInvoiceHint')}</p>
      </div>
      <Button
        onClick={onContinue}
        disabled={!ready}
        className="w-full h-14 rounded-2xl text-base font-semibold gap-2 bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/20 disabled:opacity-50"
      >
        {checking && <Loader2 className="w-5 h-5 animate-spin" />}
        {t('cash.continueToInvoice')}
      </Button>
    </div>
  );
}

/** Under the number field after the brain refused this number at payment. */
export function RefusedNumberHint({ refused, current }: { refused: string | null; current: string }) {
  const { t } = useTranslation();
  if (!refused || current.trim() !== refused.trim()) return null;
  return <p className="text-xs text-destructive mt-1">{t('cash.fixInvoiceHint')}</p>;
}
