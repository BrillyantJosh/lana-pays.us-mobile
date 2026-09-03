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
