/**
 * Which shops may take LANA neposredno.
 *
 * ONLY a shop without a company and without a bank account (KIND 30901
 * payout_account "none", shop.lanapays.us option (c)), read strictly: one
 * payout_account tag, no company or bank tag beside it, its reward method
 * "lana", no online shop (unitFlags.ts isStrictNoPayoutAccountUnit). Every other shop sells
 * LANA through the brain, as before, and can never reach this path: the
 * server refuses it here, whatever a till sends. On top of that the shop's
 * stored, owner-signed KIND 30901 must name:
 *   - a margin that reads (margin_percent "0".."20", or none = 0);
 *   - one valid mainnet wallet in lanapays_payout_wallet: for such a shop it
 *     is the owner's Main Wallet, for its reward and for its direct sales
 *     (Brilly, 23 Nov 2026). Whether the registrar agrees is asked when money
 *     is about to move, fresh;
 *   - its own owner as the author: the event's pubkey is owner_hex. The
 *     registrar owner of the wallet must later be the same person;
 * and the shop must not be pending, suspended or rejected (KIND 30903), in one
 * of the three currencies KIND 38888 prices LANA in.
 *
 * NO SWITCH (Brilly, 26 Nov 2026: "ne rabim stikala, naredi da povsod dela"):
 * every shop that meets all of the above takes it, from the moment its record
 * says so. Until then it was behind app_settings.direct_lana_units, off by
 * default; that setting is gone (db/schema.ts drops its row).
 */
import type Database from 'better-sqlite3';
import { SIMPLE_UNIT_SQL } from './unitOrigin.js';
import { isStrictNoPayoutAccountUnit, unitMarginPercent, unitPayoutWallet } from './unitFlags.js';
import { DIRECT_CURRENCIES, isAddress, clip, MAX_RECIPIENT_NAME } from './directLanaCore.js';
import { readDirectParams } from './directLanaParams.js';

const BLOCKED = ['pending', 'suspended', 'rejected'];

export interface DirectUnit {
  unit_id: string;
  /** The shop's name as the record shows it: at most 200 characters. */
  name: string;
  owner_hex: string;
  authorized_hex: string;
  currency: string;
  suspension_status: string;
  wallet: string;
  margin: number;
}

/**
 * `unit` when ok, `code` when not. One shape rather than a union: the server's
 * tsconfig has strictNullChecks off, which turns off narrowing on `ok`.
 */
export type DirectUnitState = { ok: boolean; unit?: DirectUnit; code?: string };

/** The stored row of an active unit of this app (never a simple.lanapays.us unit), or undefined. */
export function unitRow(db: Database.Database, unitId: unknown): any | undefined {
  if (typeof unitId !== 'string' || !unitId || unitId.length > 200) return undefined;
  return db.prepare(`
    SELECT unit_id, name, owner_hex, authorized_hex, currency, suspension_status, pubkey, raw_event
    FROM business_units
    WHERE unit_id = ? AND status = 'active' AND NOT ${SIMPLE_UNIT_SQL}
  `).get(unitId);
}

/** Has this payee wallet of this unit been found frozen after a sale (and not cleared since)? */
export function payeeMarkedFrozen(db: Database.Database, unitId: string, wallet: string): boolean {
  try {
    const row = db.prepare('SELECT frozen FROM direct_lana_payees WHERE unit_id = ? AND wallet = ?').get(unitId, wallet) as any;
    return row?.frozen === 1;
  } catch {
    return false;
  }
}

/**
 * Whether this unit may take a direct sale right now, by what this server has
 * stored, or why not.
 */
export function directUnitState(db: Database.Database, row: any): DirectUnitState {
  if (!row) return { ok: false, code: 'UNKNOWN_UNIT' };
  // Exactly option (c), nothing of a company or a bank beside it (unitFlags.ts).
  if (!isStrictNoPayoutAccountUnit(row.raw_event)) return { ok: false, code: 'UNIT_NOT_DIRECT' };
  if (BLOCKED.includes(String(row.suspension_status || 'active'))) return { ok: false, code: 'UNIT_BLOCKED' };
  let author = '';
  try {
    author = String(JSON.parse(row.raw_event)?.pubkey || '');
  } catch {
    author = '';
  }
  const owner = String(row.owner_hex || '');
  if (!/^[0-9a-f]{64}$/.test(owner) || author !== owner || String(row.pubkey || '') !== owner) {
    return { ok: false, code: 'UNIT_AUTHOR_MISMATCH' };
  }
  const margin = unitMarginPercent(row.raw_event);
  if (typeof margin !== 'number') return { ok: false, code: 'MARGIN_INVALID' };
  const wallet = unitPayoutWallet(row.raw_event);
  if (typeof wallet !== 'string' || !isAddress(wallet)) return { ok: false, code: 'WALLET_INVALID' };
  const currency = String(row.currency || '').toUpperCase();
  if (!DIRECT_CURRENCIES.includes(currency)) return { ok: false, code: 'CURRENCY_UNSUPPORTED' };
  if (payeeMarkedFrozen(db, row.unit_id, wallet)) return { ok: false, code: 'PAYEE_FROZEN' };
  return {
    ok: true,
    unit: {
      unit_id: row.unit_id,
      name: clip(row.name, MAX_RECIPIENT_NAME),
      owner_hex: owner,
      authorized_hex: String(row.authorized_hex || '[]'),
      currency,
      suspension_status: String(row.suspension_status || 'active'),
      wallet,
      margin,
    },
  };
}

/**
 * What the till shows for a shop without a company (GET /api/business-units):
 * whether its "LANA neposredno" button is on, and if not, why. Only for such a
 * shop; every other shop's answer has no such key. The button is never shown
 * for a reason the till cannot know: every payment is checked again from
 * scratch when it is quoted and when it is sent.
 *   enabled true   nothing stored says no (there is no switch since 26 Nov 2026)
 *   reason         what the shop lacks:
 *                  WALLET_INVALID, MARGIN_INVALID, PAYEE_FROZEN,
 *                  RATE_UNAVAILABLE / CURRENCY_UNSUPPORTED, UNIT_AUTHOR_MISMATCH
 */
export function directLanaView(
  db: Database.Database,
  row: any,
  opts: { pubkey?: string; nowSec?: number } = {},
): { enabled: boolean; reason: string | null } {
  const state = directUnitState(db, row);
  if (!state.ok) return { enabled: false, reason: state.code };
  if (!readDirectParams(db, state.unit.currency, opts)?.rate) return { enabled: false, reason: 'RATE_UNAVAILABLE' };
  return { enabled: true, reason: null };
}
