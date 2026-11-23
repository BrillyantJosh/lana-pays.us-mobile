/**
 * Flags derived from a business unit's raw KIND 30901 event.
 *
 * These live here rather than as columns because the heartbeat already stores
 * and refreshes the whole signed event (`raw_event`) on every beat, so a new
 * tag costs no migration and no re-ingestion.
 */

/**
 * Does this unit sell on the LanaRetail portals (KIND 30901 `online_shop` tag,
 * published from shop.lanapays.us)?
 *
 *   true      — the merchant switched Online shop on
 *   false     — the tag is absent or not exactly 'true'
 *   undefined — the event is missing or unparseable, i.e. WE CANNOT TELL
 *
 * The undefined case matters: the mobile home screen hides the Orders tile for
 * units that never sell online, and hiding it from a merchant who actually owes
 * a delivery is worse than showing a dead tile. So "cannot tell" is reported as
 * such, the key is dropped from the JSON, and the client falls back to showing.
 *
 * The tag name is compared EXACTLY, and so is the value — matching the canonical
 * parse in lana-pays-shop (`getTag('online_shop') === 'true'`). A prefix or
 * substring match would also hit `online_shop_shipping_fee` and
 * `online_shop_free_shipping_from`, lighting the tile for a merchant who only
 * ever set a shipping fee.
 */
export function isOnlineShopUnit(rawEvent: unknown): boolean | undefined {
  if (typeof rawEvent !== 'string' || rawEvent.trim() === '') return undefined;
  let ev: any;
  try {
    ev = JSON.parse(rawEvent);
  } catch {
    return undefined;
  }
  if (!ev || typeof ev !== 'object' || !Array.isArray(ev.tags)) return undefined;
  return ev.tags.some((t: unknown) => Array.isArray(t) && t[0] === 'online_shop' && t[1] === 'true');
}

/**
 * The tags of a stored KIND 30901, or undefined when the event is missing or
 * unparseable (WE CANNOT TELL). Malformed entries stay in the list; each reader
 * below looks only at entries that are arrays with the name it wants.
 */
function storedTags(rawEvent: unknown): unknown[] | undefined {
  if (typeof rawEvent !== 'string' || rawEvent.trim() === '') return undefined;
  let ev: any;
  try {
    ev = JSON.parse(rawEvent);
  } catch {
    return undefined;
  }
  if (!ev || typeof ev !== 'object' || !Array.isArray(ev.tags)) return undefined;
  return ev.tags;
}

/** Every tag with exactly this name (compared exactly, see isOnlineShopUnit). */
function tagsNamed(tags: unknown[], name: string): unknown[][] {
  return tags.filter((t): t is unknown[] => Array.isArray(t) && t[0] === name);
}

/**
 * Has this unit NO bank account for payouts? This is option (c) on
 * shop.lanapays.us, "without a company and without a bank account" (KIND 30901
 * v1.4.0 `payout_account`, Brilly 23 Nov 2026).
 *
 *   true      — a `payout_account` tag with exactly the value "none"
 *   false     — no such tag. Any other value, or no tag at all, is a unit as
 *               every unit was before this tag existed: old units stay exactly
 *               as they are
 *   undefined — the event is missing or unparseable: WE CANNOT TELL. The
 *               callers treat that as false, and the brain, which reads its
 *               own copy of the event, has the last word
 *
 * Such a unit sells for cash through the brain, and takes LANA only as a
 * direct transfer to its own wallet. A LANA sale through the brain pays the
 * shop's invoice to a bank account, which this shop does not have, so every
 * route here that hands LANA to the brain refuses it (lib/noPayoutAccount.ts).
 *
 * Name and value are compared exactly, as the shop writes them: "None" or
 * " none" are not "none". When two payout_account tags disagree, one "none" is
 * enough: refusing a LANA sale moves no money, letting one through for a shop
 * that may have no bank account would.
 */
export function isNoPayoutAccountUnit(rawEvent: unknown): boolean | undefined {
  const tags = storedTags(rawEvent);
  if (!tags) return undefined;
  return tagsNamed(tags, 'payout_account').some(t => t[1] === 'none');
}

/** The largest margin a unit without a company may add to a direct LANA payment. */
export const MAX_MARGIN_PERCENT = 20;

/**
 * The margin, in whole percent, that a unit without a company adds to a DIRECT
 * LANA payment (KIND 30901 `margin_percent`). Same name and same reading as the
 * margin of a Point of Abundance, KIND 30905 (letsbalance-world
 * apps/universal/lib/pointsOrder.ts, marginPercent), so two apps never quote
 * two prices for one unit.
 *
 *   0..20     — absent, "" or "0" is 0; "1".."20" as written
 *   null      — any other value, or two margin_percent tags: such a unit takes
 *               NO direct LANA sale (fail closed)
 *   undefined — the event is missing or unparseable: WE CANNOT TELL
 *
 * A cash sale never uses it: cash is the exact invoice (Brilly, 23 Nov 2026).
 */
export function unitMarginPercent(rawEvent: unknown): number | null | undefined {
  const tags = storedTags(rawEvent);
  if (!tags) return undefined;
  const margins = tagsNamed(tags, 'margin_percent');
  if (margins.length > 1) return null;
  const raw: unknown = margins[0]?.[1];
  // A value that is not text is not a margin anyone wrote: no direct sale.
  if (raw !== undefined && typeof raw !== 'string') return null;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return 0;
  return /^(0|[1-9]\d?)$/.test(value) && Number(value) <= MAX_MARGIN_PERCENT ? Number(value) : null;
}

/**
 * The wallet the unit names in `lanapays_payout_wallet`. For every unit it is
 * the wallet its reward is paid to. For a unit without a company it is also
 * the wallet a direct LANA sale pays into (Brilly, 23 Nov 2026: the owner's
 * Main Wallet, for both).
 *
 *   string    — the one wallet named, trimmed
 *   null      — none named, only empty ones, or two different ones (which
 *               would be a guess about where money goes)
 *   undefined — the event is missing or unparseable: WE CANNOT TELL
 *
 * Only the text is read here. Whether it is a valid, registered, unfrozen Main
 * Wallet of the owner is checked where money is about to move.
 */
export function unitPayoutWallet(rawEvent: unknown): string | null | undefined {
  const tags = storedTags(rawEvent);
  if (!tags) return undefined;
  const named = tagsNamed(tags, 'lanapays_payout_wallet')
    .map(t => t[1])
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(w => w !== '');
  const distinct = [...new Set(named)];
  return distinct.length === 1 ? distinct[0] : null;
}
