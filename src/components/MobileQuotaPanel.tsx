/**
 * Quota detail panel rendered under the selected unit card on the home
 * screen. Shows volume + transaction usage in the merchant's quota currency
 * with proportional progress bars. Reusable across the 1-unit / 2-unit /
 * dropdown selector layouts. Source data comes from
 * `business_units.quota_*` columns populated by the heartbeat KIND 30903
 * ingest.
 */
import { Calendar } from 'lucide-react';

interface QuotaUnit {
  quota_volume_used?: number;
  quota_volume_limit?: number;
  quota_tx_used?: number;
  quota_tx_limit?: number;
  quota_currency?: string;
  quota_period?: string;
}

interface Props {
  unit: QuotaUnit;
  /** When true, render with a softer surface so it sits inside warning/blocked panels. */
  inset?: boolean;
}

function nextMonthLabel(): string {
  const now = new Date();
  const nm = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return nm.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

function barColour(pct: number): string {
  if (pct >= 100) return 'bg-destructive';
  if (pct >= 80) return 'bg-yellow-500';
  return 'bg-emerald-500';
}

export default function MobileQuotaPanel({ unit, inset = false }: Props) {
  const volLimit = unit.quota_volume_limit ?? 0;
  const volUsed = unit.quota_volume_used ?? 0;
  const txLimit = unit.quota_tx_limit ?? 0;
  const txUsed = unit.quota_tx_used ?? 0;
  const currency = unit.quota_currency || 'EUR';
  const period = unit.quota_period || new Date().toISOString().slice(0, 7);

  const pctVol = volLimit > 0 ? Math.min(100, (volUsed / volLimit) * 100) : 0;
  const pctTx = txLimit > 0 ? Math.min(100, (txUsed / txLimit) * 100) : 0;

  return (
    <div className={`rounded-xl ${inset ? 'bg-white/40 dark:bg-black/20' : 'bg-secondary/40'} px-3 py-3 space-y-2.5`}>
      {/* Volume */}
      <div>
        <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground mb-1">
          <span>Volume this month</span>
          <span className="text-foreground tabular-nums">
            {volUsed.toFixed(2)} / {volLimit.toFixed(2)} {currency}
            {volLimit > 0 && (
              <span className="ml-1 text-muted-foreground">({pctVol.toFixed(0)}%)</span>
            )}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
          <div className={`h-full ${barColour(pctVol)}`} style={{ width: `${pctVol}%` }} />
        </div>
      </div>

      {/* Transactions */}
      <div>
        <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground mb-1">
          <span>Transactions this month</span>
          <span className="text-foreground tabular-nums">
            {txUsed} / {txLimit}
            {txLimit > 0 && (
              <span className="ml-1 text-muted-foreground">({pctTx.toFixed(0)}%)</span>
            )}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
          <div className={`h-full ${barColour(pctTx)}`} style={{ width: `${pctTx}%` }} />
        </div>
      </div>

      {/* Period footer */}
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground pt-0.5">
        <Calendar className="w-3 h-3" />
        <span>Period {period} · resets {nextMonthLabel()}</span>
      </div>
    </div>
  );
}
