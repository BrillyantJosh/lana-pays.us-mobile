/**
 * The KIND 38888 a direct LANA sale is priced, read and published by: the
 * newest stored copy, and only after its author AND its signature check out.
 *
 * The heartbeat stores the whole signed event, but its fetch only compares the
 * JSON pubkey field (lib/nostr.ts), and the exchange_rates column holds floats.
 * A direct sale is priced by this server alone, so it re-reads the exact decimal
 * string of the fx tag from the stored event after verifying it: exactly one fx
 * tag for the currency, as letsbalance-world reads it (community/wallet.ts
 * settings). The Electrum servers and the relays come from the same verified
 * event, not from columns parsed out of an unchecked one.
 */
import type Database from 'better-sqlite3';
import { KIND_38888_PUBKEY, verifyNostrEvent } from './nostr.js';
import { devRelays } from './devOverrides.js';
import { validRate } from './directLanaCore.js';
import type { ElectrumEndpoint } from './directLanaChain.js';

export interface DirectParams {
  event_id: string;
  /** The exact fx string for the currency asked, or null when there is none to use. */
  rate: string | null;
  /** When the price took effect (valid_from, else created_at), unix seconds. */
  fx_at: number;
  electrum: ElectrumEndpoint[];
  relays: string[];
}

const verified = new Map<string, boolean>();

/**
 * The verified parameters, or null when no stored KIND 38888 passes: none
 * stored yet, not from the pinned author, a signature that does not hold.
 */
export function readDirectParams(
  db: Database.Database,
  currency: string | null,
  opts: { pubkey?: string; nowSec?: number } = {},
): DirectParams | null {
  const expected = String(opts.pubkey ?? KIND_38888_PUBKEY).toLowerCase();
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  let row: { raw_event?: string } | undefined;
  try {
    row = db.prepare('SELECT raw_event FROM kind_38888 ORDER BY id DESC LIMIT 1').get() as any;
  } catch {
    return null;
  }
  if (!row?.raw_event) return null;
  let ev: any;
  try {
    ev = JSON.parse(row.raw_event);
  } catch {
    return null;
  }
  if (!ev || ev.kind !== 38888 || String(ev.pubkey || '').toLowerCase() !== expected) return null;
  const tags: string[][] = Array.isArray(ev.tags) ? ev.tags : [];
  if (!tags.some(t => Array.isArray(t) && t[0] === 'd' && t[1] === 'main')) return null;
  const cacheKey = `${expected}:${ev.id}:${ev.sig}`;
  let ok = verified.get(cacheKey);
  if (ok === undefined) {
    ok = verifyNostrEvent(ev, [38888], nowSec);
    if (verified.size > 50) verified.clear();
    verified.set(cacheKey, ok);
  }
  if (!ok) return null;

  const fx = currency ? tags.filter(t => t[0] === 'fx' && t[1] === currency) : [];
  const rawRate = fx.length === 1 ? fx[0][2] : undefined;
  const stampTag = tags.find(t => t[0] === 'valid_from')?.[1];
  const fx_at = stampTag && /^\d{1,12}$/.test(stampTag) ? Number(stampTag) : Number(ev.created_at);
  // A price that takes effect later is not a price yet.
  const rate = validRate(rawRate) && fx_at <= nowSec ? rawRate : null;

  const electrum: ElectrumEndpoint[] = [];
  for (const t of tags) {
    if (t[0] !== 'electrum' || !t[1] || t[2] !== '5097') continue;
    if (!electrum.some(s => s.host === t[1])) electrum.push({ host: t[1], port: 5097 });
  }

  let relays = tags.filter(t => t[0] === 'relay' && typeof t[1] === 'string').map(t => t[1]);
  if (!relays.length) {
    try {
      const content = typeof ev.content === 'string' && ev.content.trim().startsWith('{') ? JSON.parse(ev.content) : {};
      if (Array.isArray(content?.relays)) relays = content.relays.filter((r: unknown) => typeof r === 'string');
    } catch { /* no relays in the content either */ }
  }
  relays = [...new Set(relays.filter(r => /^wss:\/\/[^\s]+$/.test(r)))].slice(0, 8);
  // A local run never writes to the production relays (lib/devOverrides.ts).
  if (devRelays.length) relays = [...devRelays];

  return { event_id: String(ev.id), rate, fx_at, electrum: electrum.slice(0, 3), relays };
}
