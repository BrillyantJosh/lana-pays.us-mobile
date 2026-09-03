/**
 * OrderDetailSheet — one Lana Online Shop order, the buyer's delivery details
 * (decrypted HERE, in the browser, on demand) and the fulfillment actions.
 *
 * Every action signs a KIND 36521 with the merchant's session key
 * (signNostrEvent) and posts it to /api/orders/:id/fulfillment, where the
 * server verifies the signature + authorization, records it atomically and
 * broadcasts it to the relays. Tags follow SPEC §3 exactly.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, Eye, EyeOff, Truck, PackageCheck, XCircle, Undo2, AlertTriangle, Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAuth } from '@/contexts/AuthContext';
import { currencySymbol, formatLanoshis } from '@/lib/format';
import { signNostrEvent } from '@/lib/nostrSigning';
import { decryptDeliveryDetails, type DeliveryDetails } from '@/lib/orderCrypto';
import { type OrderRow, statusKey, statusStyle, localTime, shortHex } from '@/components/OrderList';

type Action = 'shipped' | 'delivered' | 'rejected' | 'refunded';

const CAN_SHIP = new Set(['paid', 'received', 'confirmed', 'packed']);
const CAN_REFUND = new Set(['rejected', 'shipped', 'delivered']);

interface Props {
  order: OrderRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  merchantHex: string;
  /** Fired after a status was accepted by the server (list refresh). */
  onChanged?: () => void;
}

export function OrderDetailSheet({ order, open, onOpenChange, merchantHex, onChanged }: Props) {
  const { t } = useTranslation();
  const { session } = useAuth();

  // Plaintext delivery details live ONLY here, and are dropped when the sheet
  // closes or another order is opened.
  const [details, setDetails] = useState<DeliveryDetails | null>(null);
  const [decryptError, setDecryptError] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDetails(null);
    setDecryptError(false);
    setAction(null);
    setCarrier('');
    setTracking('');
  }, [order?.order_id, open]);

  if (!order) return null;

  const sym = currencySymbol(order.currency);
  const amountLabel = `${sym}${order.total}`;
  const status = order.effectiveStatus;
  const paid = order.paymentState === 'paid';
  const canShip = paid && CAN_SHIP.has(status) && order.fulfillment === 'shipping';
  const canDeliver = paid && (status === 'shipped' || (order.fulfillment === 'pickup' && CAN_SHIP.has(status)));
  const canReject = paid && CAN_SHIP.has(status);
  const canRefund = paid && CAN_REFUND.has(status);

  const toggleDetails = () => {
    if (details) { setDetails(null); return; }
    if (!order.delivery_event || !session?.privateKeyHex) { setDecryptError(true); return; }
    try {
      setDetails(decryptDeliveryDetails(session.privateKeyHex, order.delivery_event));
      setDecryptError(false);
    } catch {
      setDetails(null);
      setDecryptError(true);
    }
  };

  const publish = async () => {
    if (!action || !session?.privateKeyHex || !merchantHex) return;
    setBusy(true);
    try {
      const nowIso = new Date().toISOString();
      const tags: string[][] = [
        ['d', order.order_id],
        ['a', `36520:${order.buyer_pubkey}:${order.order_id}`],
        ['a', `30901:${order.unit_owner_hex}:${order.unit_id}`],
        ['p', order.buyer_pubkey],
        ['unit_id', order.unit_id],
        ['status', action],
        ['payment', `30933:${order.paid_signer_hex || ''}:${order.paid_tx_id || ''}`],
      ];
      if (action === 'shipped') {
        if (carrier.trim()) tags.push(['carrier', carrier.trim().slice(0, 80)]);
        if (tracking.trim()) tags.push(['tracking', tracking.trim().slice(0, 120)]);
        tags.push(['shipped_at', nowIso]);
      }
      if (action === 'delivered') tags.push(['delivered_at', nowIso]);
      if (action === 'refunded') tags.push(['refund', order.total, order.currency, '', nowIso]);
      tags.push(['v', '1']);

      const event = signNostrEvent(session.privateKeyHex, 36521, '', tags);
      const res = await fetch(`/api/orders/${encodeURIComponent(order.order_id)}/fulfillment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hex: merchantHex, event }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        // 409 = the status already moved (double tap / another device): just refresh.
        if (res.status !== 409) toast.error(t('orders.publishFailed'));
      } else {
        toast.success(t(statusKey(action)));
      }
      setAction(null);
      onChanged?.();
      if (res.ok) onOpenChange(false);
    } catch {
      toast.error(t('orders.publishFailed'));
    }
    setBusy(false);
  };

  const confirmText = (a: Action) => {
    switch (a) {
      case 'shipped': return t('orders.confirmShipped', { amount: amountLabel });
      case 'delivered': return t('orders.confirmDelivered', { amount: amountLabel });
      case 'rejected': return t('orders.confirmReject', { amount: amountLabel });
      case 'refunded': return t('orders.confirmRefunded', { amount: amountLabel });
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-3xl max-h-[92vh] overflow-y-auto pb-8">
        <SheetHeader className="text-left">
          <div className="flex items-center justify-between gap-2 pr-6">
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${statusStyle(status)}`}>
              {t(statusKey(status))}
            </span>
            <span className="text-xl font-bold text-foreground">{amountLabel}</span>
          </div>
          <SheetTitle className="text-base">{order.unit_name}</SheetTitle>
          <SheetDescription className="flex items-center gap-1.5 text-xs">
            {order.fulfillment === 'pickup' ? <Store className="w-3.5 h-3.5" /> : <Truck className="w-3.5 h-3.5" />}
            {order.fulfillment === 'pickup' ? t('orders.fulfillmentPickup') : t('orders.fulfillmentShipping')}
            <span>· {localTime(order.paid_at ?? order.created_at)}</span>
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {/* Items */}
          <div className="glass-card rounded-2xl border p-4 space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t('orders.items')}</p>
            {order.items.map((it, i) => (
              <div key={i} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">
                  <span className="font-semibold">{it.qty}</span> × {it.saleUnit || ''}
                  <span className="text-xs text-muted-foreground font-mono"> · {it.a.split(':').pop()}</span>
                </span>
                <span className="shrink-0">{sym}{it.unitPrice}</span>
              </div>
            ))}
            <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground pt-1 border-t border-border">
              <span>{t('orders.shippingFee')}</span>
              <span>{sym}{order.shipping}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-sm font-bold">
              <span>{t('orders.total')}</span>
              <span>{amountLabel}</span>
            </div>
            {order.paymentState === 'amount_mismatch' && order.expected_total && (
              <p className="text-xs text-destructive flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {t('orders.statusAmountMismatch')}: {sym}{order.paid_amount} ≠ {sym}{order.expected_total}
              </p>
            )}
            {order.price_changed && (
              <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />{t('orders.priceChanged')}
              </p>
            )}
          </div>

          {/* Buyer + payment */}
          <div className="glass-card rounded-2xl border p-4 space-y-2 text-xs text-muted-foreground">
            <p><span className="font-semibold text-foreground">{t('orders.buyer')}</span>: <span className="font-mono">{shortHex(order.buyer_pubkey, 12)}</span></p>
            {order.paid_customer_hex && (
              <p>LANA: <span className="font-mono">{shortHex(order.paid_customer_hex, 12)}</span>
                {/* 30933 lana_amount is in lanoshis (brain orchestrator) */}
                {order.paid_lana_amount && Number.isFinite(Number(order.paid_lana_amount))
                  ? <span> · {formatLanoshis(Number(order.paid_lana_amount))} LANA</span> : null}</p>
            )}
            {order.paid_tx_id && <p>TX: <span className="font-mono break-all">{order.paid_tx_id}</span></p>}
            {order.fulfillment_carrier && <p>{t('orders.carrier')}: {order.fulfillment_carrier}</p>}
            {order.fulfillment_tracking && <p>{t('orders.tracking')}: <span className="break-all">{order.fulfillment_tracking}</span></p>}

            {order.delivery_event && (
              <Button variant="outline" size="sm" className="h-9 rounded-xl gap-1.5 text-xs w-full mt-1" onClick={toggleDetails}>
                {details ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                {details ? t('orders.hideDetails') : t('orders.showDetails')}
              </Button>
            )}
            {decryptError && <p className="text-destructive">{t('orders.decryptFailed')}</p>}
            {details && (
              <div className="rounded-xl bg-secondary p-3 text-sm text-foreground space-y-0.5">
                <p className="font-semibold">{details.name}</p>
                {details.phone && <p>{details.phone}</p>}
                {details.email && <p>{details.email}</p>}
                <p>{details.address.line1}</p>
                {details.address.line2 && <p>{details.address.line2}</p>}
                <p>{details.address.postcode} {details.address.city}</p>
                <p>{details.address.country}</p>
                {details.pickup_slot && <p className="text-muted-foreground">{details.pickup_slot}</p>}
                {details.note && <p className="text-muted-foreground whitespace-pre-wrap">{details.note}</p>}
              </div>
            )}
          </div>

          {/* Actions */}
          {(canShip || canDeliver || canReject || canRefund) && (
            <div className="grid grid-cols-2 gap-2">
              {canShip && (
                <Button className="h-12 rounded-xl gap-2 col-span-2 bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setAction('shipped')}>
                  <Truck className="w-4 h-4" /> {t('orders.markShipped')}
                </Button>
              )}
              {canDeliver && (
                <Button className="h-12 rounded-xl gap-2 col-span-2 bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setAction('delivered')}>
                  <PackageCheck className="w-4 h-4" /> {t('orders.markDelivered')}
                </Button>
              )}
              {canReject && (
                <Button variant="outline" className="h-11 rounded-xl gap-2 text-destructive hover:text-destructive" onClick={() => setAction('rejected')}>
                  <XCircle className="w-4 h-4" /> {t('orders.reject')}
                </Button>
              )}
              {canRefund && (
                <Button variant="outline" className="h-11 rounded-xl gap-2" onClick={() => setAction('refunded')}>
                  <Undo2 className="w-4 h-4" /> {t('orders.statusRefunded')}
                </Button>
              )}
            </div>
          )}
        </div>

        <AlertDialog open={!!action} onOpenChange={(o) => !o && !busy && setAction(null)}>
          <AlertDialogContent className="rounded-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle>{action ? t(statusKey(action)) : ''}</AlertDialogTitle>
              <AlertDialogDescription>{action ? confirmText(action) : ''}</AlertDialogDescription>
            </AlertDialogHeader>
            {action === 'shipped' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-sm">{t('orders.carrier')}</Label>
                  <Input value={carrier} onChange={(e) => setCarrier(e.target.value)} className="h-11 rounded-xl" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm">{t('orders.tracking')}</Label>
                  <Input value={tracking} onChange={(e) => setTracking(e.target.value)} className="h-11 rounded-xl" />
                </div>
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>{t('common.back')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); publish(); }}
                disabled={busy}
                className={action === 'rejected' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : (action ? t(statusKey(action)) : '')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
