/**
 * PaymentRequestList — shared list of Lana-online payment requests.
 * Used by the LanaOnlineTab (last 10) and the /lana-online/history page
 * (paginated). Pure display + copy-link + cancel; data loading stays in
 * the parent so each surface controls its own polling/pagination.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check, ExternalLink, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { currencySymbol, formatLanoshis } from '@/lib/format';

export interface PaymentRequestRow {
  id: string;
  token: string;
  unit_id: string;
  unit_name: string;
  status: 'pending' | 'paid' | 'cancelled' | 'expired';
  amount_fiat: number;
  currency: string;
  invoice_number: string;
  created_at: string;
  expires_at: string | null;
  paid_at: string | null;
  tx_hash: string | null;
  paid_lana_lanoshis: number | null;
  customer_name: string | null;
}

export function payUrlFor(row: { token: string }): string {
  return `${window.location.origin}/pay/${row.token}`;
}

const STATUS_STYLE: Record<PaymentRequestRow['status'], string> = {
  pending: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
  paid: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  cancelled: 'bg-muted text-muted-foreground border-border',
  expired: 'bg-muted text-muted-foreground border-border',
};

/** SQLite datetime('now') is UTC without a zone suffix — normalize for Date. */
function localTime(sqliteUtc: string | null): string {
  if (!sqliteUtc) return '';
  try { return new Date(sqliteUtc.replace(' ', 'T') + 'Z').toLocaleString(); } catch { return sqliteUtc; }
}

interface Props {
  rows: PaymentRequestRow[];
  onCancelled?: () => void;
  merchantHex?: string;
}

export function PaymentRequestList({ rows, onCancelled, merchantHex }: Props) {
  const { t } = useTranslation();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<PaymentRequestRow | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const statusLabel = (s: PaymentRequestRow['status']) => t(`lanaOnline.status${s.charAt(0).toUpperCase()}${s.slice(1)}`);

  const copyLink = async (row: PaymentRequestRow) => {
    try {
      await navigator.clipboard.writeText(payUrlFor(row));
      setCopiedId(row.id);
      setTimeout(() => setCopiedId(c => (c === row.id ? null : c)), 2000);
    } catch { /* clipboard denied — ignore */ }
  };

  const doCancel = async () => {
    if (!cancelTarget || !merchantHex) return;
    setCancelling(true);
    try {
      await fetch(`/api/payment-requests/${encodeURIComponent(cancelTarget.id)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merchant_hex: merchantHex }),
      });
      onCancelled?.();
    } catch { /* list refresh will show the truth */ }
    setCancelling(false);
    setCancelTarget(null);
  };

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-6">{t('lanaOnline.noRequests')}</p>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {rows.map(row => (
        <div key={row.id} className="glass-card rounded-2xl border p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${STATUS_STYLE[row.status]}`}>
              {statusLabel(row.status)}
            </span>
            <span className="text-base font-bold text-foreground shrink-0">
              {currencySymbol(row.currency)}{row.amount_fiat.toFixed(2)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate">{t('cash.invoiceLabel', { number: row.invoice_number })}</span>
            <span className="shrink-0">{localTime(row.status === 'paid' ? row.paid_at : row.created_at)}</span>
          </div>

          {row.status === 'paid' && (
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-border">
              <span className="text-sm font-semibold text-primary">
                {row.paid_lana_lanoshis ? `${formatLanoshis(row.paid_lana_lanoshis)} LANA` : ''}
                {row.customer_name ? <span className="text-xs text-muted-foreground font-normal"> · {row.customer_name}</span> : null}
              </span>
              {row.tx_hash && row.tx_hash.length === 64 && (
                <a href={`https://chainz.cryptoid.info/lana/tx.dws?${row.tx_hash}`} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary underline shrink-0">
                  <ExternalLink className="w-3.5 h-3.5" /> TX
                </a>
              )}
            </div>
          )}

          {row.status === 'pending' && (
            <div className="flex items-center gap-2 pt-1 border-t border-border">
              <Button variant="outline" size="sm" className="h-9 rounded-xl flex-1 gap-1.5 text-xs"
                onClick={() => copyLink(row)}>
                {copiedId === row.id ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedId === row.id ? t('lanaOnline.linkCopied') : t('lanaOnline.copyLink')}
              </Button>
              <Button variant="outline" size="sm" className="h-9 rounded-xl gap-1.5 text-xs text-destructive hover:text-destructive"
                onClick={() => setCancelTarget(row)}>
                <XCircle className="w-3.5 h-3.5" />
                {t('lanaOnline.cancelRequest')}
              </Button>
            </div>
          )}
        </div>
      ))}

      <AlertDialog open={!!cancelTarget} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('lanaOnline.cancelRequest')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('lanaOnline.cancelConfirm', {
                amount: cancelTarget ? `${currencySymbol(cancelTarget.currency)}${cancelTarget.amount_fiat.toFixed(2)}` : '',
                invoice: cancelTarget?.invoice_number || '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelling}>{t('common.back')}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); doCancel(); }} disabled={cancelling}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {cancelling ? <Loader2 className="w-4 h-4 animate-spin" /> : t('lanaOnline.cancelRequest')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
