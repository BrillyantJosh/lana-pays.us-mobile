/**
 * DirectLinkRequestList — the recent LANA neposredno payment links of a shop
 * without a company, in the Lana-online tab (Brilly, 26 Nov 2026). The same
 * links the till's "LANA direct" tab lists (GET /api/direct-lana/links), drawn
 * like the Lana-online requests above them: status, amount, invoice number,
 * time, note; copy and cancel while a link is open.
 *
 * Cancel is the seller's signed POST /api/direct-lana/links/:id/cancel, the
 * same call the "LANA direct" tab makes. The server refuses it while a payment
 * of the link may still be mined, and says so.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check, ExternalLink, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAuth } from '@/contexts/AuthContext';
import { centsText } from '@/lib/directLanaCore';
import { formatMoney } from '@/lib/directLanaFormat';
import { cancelDirectLink, directLinkUrl, directReasonKey, answerCode } from '@/lib/directLanaApi';
import type { DirectLink } from '@/components/tabs/DirectLanaTab';

const STATUS_STYLE: Record<DirectLink['status'], string> = {
  open: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
  paying: 'bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30',
  paid: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  cancelled: 'bg-muted text-muted-foreground border-border',
  expired: 'bg-muted text-muted-foreground border-border',
};

/** An amount the till cannot read is shown as a dash, never as a crash. */
export function linkMoney(cents: string, currency: string, locale: string): string {
  try {
    return formatMoney(centsText(BigInt(cents)), currency, locale);
  } catch {
    return '–';
  }
}

interface Props {
  links: DirectLink[];
  /** A link changed here (cancelled): the parent reads the list again. */
  onChanged?: () => void;
}

export function DirectLinkRequestList({ links, onChanged }: Props) {
  const { t, i18n } = useTranslation();
  const { session } = useAuth();
  const locale = i18n.language || 'en';
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<DirectLink | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const copyLink = async (l: DirectLink) => {
    try {
      await navigator.clipboard.writeText(directLinkUrl(l));
      setCopiedId(l.id);
      setTimeout(() => setCopiedId(c => (c === l.id ? null : c)), 2000);
    } catch { /* clipboard denied — ignore */ }
  };

  const doCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    setRefusal(null);
    try {
      const { status, data } = await cancelDirectLink(session, cancelTarget.id);
      if (status !== 200) {
        const { key, sentence } = directReasonKey(answerCode(data) || 'GENERIC');
        setRefusal(sentence ? t(key) : t('directLana.cancelLinkRefused', { reason: t(key) }));
      }
    } catch {
      setRefusal(t('directLana.cancelLinkRefused', { reason: t(directReasonKey('NETWORK').key) }));
    }
    onChanged?.();
    setCancelling(false);
    setCancelTarget(null);
  };

  if (links.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-6">{t('directLana.linksEmpty')}</p>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {refusal && (
        <div data-testid="online-direct-cancel-refusal" className="rounded-2xl bg-destructive/10 border border-destructive/20 p-3">
          <p className="text-sm text-destructive text-center">{refusal}</p>
        </div>
      )}
      {links.map(l => (
        <div key={l.id} data-testid="online-direct-link-row" className="glass-card rounded-2xl border p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span data-testid="online-direct-link-row-status"
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${STATUS_STYLE[l.status] || STATUS_STYLE.expired}`}>
              {t(`directLana.linkStatus.${l.status}`)}
            </span>
            <span className="text-base font-bold text-foreground shrink-0">{linkMoney(l.pay_cents, l.currency, locale)}</span>
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate">{l.invoice_number ? t('cash.invoiceLabel', { number: l.invoice_number }) : ''}</span>
            <span className="shrink-0">{new Date(l.created_at * 1000).toLocaleString(locale)}</span>
          </div>
          {l.note && (
            <p className="text-sm text-foreground/85 break-words">
              <span className="text-xs text-muted-foreground">{t('lanaOnline.noteLabel')}: </span>{l.note}
            </p>
          )}
          {l.payment?.txid && (l.status === 'paid' || l.status === 'paying') && (
            <div className="flex items-center justify-end gap-2 pt-1 border-t border-border">
              <a href={`https://chainz.cryptoid.info/lana/tx.dws?${l.payment.txid}`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary underline shrink-0">
                <ExternalLink className="w-3.5 h-3.5" /> TX
              </a>
            </div>
          )}
          {l.status === 'open' && (
            <div className="flex items-center gap-2 pt-1 border-t border-border">
              <Button variant="outline" size="sm" className="h-9 rounded-xl flex-1 gap-1.5 text-xs" onClick={() => copyLink(l)}>
                {copiedId === l.id ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedId === l.id ? t('lanaOnline.linkCopied') : t('lanaOnline.copyLink')}
              </Button>
              <Button data-testid="online-direct-link-cancel" variant="outline" size="sm"
                className="h-9 rounded-xl gap-1.5 text-xs text-destructive hover:text-destructive"
                onClick={() => { setRefusal(null); setCancelTarget(l); }}>
                <XCircle className="w-3.5 h-3.5" />
                {t('directLana.cancelLink')}
              </Button>
            </div>
          )}
        </div>
      ))}

      <AlertDialog open={!!cancelTarget} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('directLana.cancelLink')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('directLana.cancelLinkConfirm', { amount: cancelTarget ? linkMoney(cancelTarget.pay_cents, cancelTarget.currency, locale) : '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelling}>{t('common.back')}</AlertDialogCancel>
            <AlertDialogAction data-testid="online-direct-link-cancel-yes" onClick={(e) => { e.preventDefault(); doCancel(); }} disabled={cancelling}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {cancelling ? <Loader2 className="w-4 h-4 animate-spin" /> : t('directLana.cancelLink')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
