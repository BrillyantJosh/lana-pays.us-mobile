/**
 * Home-screen notice: "you have N orders on Točka obilja" (mejmosefajn.org).
 *
 * Asked by Kati (caretaker) and ordered by Brilly in The Rose, 24. 11. 2026.
 * Display only: the count comes from GET /api/food-corner/open-count (signed
 * public orders on the relays, see server/lib/foodCornerOpen.ts) and the button
 * opens the supplier page on mejmosefajn.org, where the orders are handled.
 * Nothing about the buyer and no amount is shown — the number and the shop are
 * enough to know there is something to prepare.
 *
 * No delivery day either, on purpose: mejmosefajn.org itself names two different
 * days for the same order when it came in after the Monday cutoff (the buyer is
 * told next week's pickup, the supplier and Točka lists put it in this week's),
 * so any day shown here would contradict one of them. The supplier page says it.
 */
import { useTranslation } from 'react-i18next';
import { ChevronRight, Truck } from 'lucide-react';

export interface FoodCornerOpen {
  count: number;
  units: { unit_id: string; name: string; count: number }[];
  next_delivery: string | null;
  link: string;
}

/** Only ever this page: the server sends the link, but the notice must not become a way to open anything else. */
export const FOOD_CORNER_SUPPLIER_URL = 'https://mejmosefajn.org/food-corner/supplier';

export function FoodCornerNotice({ data }: { data: FoodCornerOpen | null }) {
  const { t } = useTranslation();
  if (!data || !(data.count > 0)) return null;

  return (
    <a
      href={FOOD_CORNER_SUPPLIER_URL}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="food-corner-notice"
      className="w-full rounded-2xl border-2 border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-4 py-3 flex items-center gap-3 text-left active:scale-[0.98] transition-transform"
    >
      <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center shrink-0">
        <Truck className="w-5 h-5 text-amber-700 dark:text-amber-300" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-base font-bold text-foreground leading-snug">
          {t('home.foodCornerTitle', { count: data.count })}
        </p>
        {data.units.length > 1 && (
          <p className="text-xs text-foreground/80 mt-0.5">
            {data.units.map(u => `${u.name}: ${u.count}`).join(' · ')}
          </p>
        )}
        <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 underline mt-1">
          {t('home.foodCornerOpen')}
        </p>
      </div>
      <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
    </a>
  );
}

export default FoodCornerNotice;
