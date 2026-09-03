/**
 * Merchant authorization helpers (trust-the-client hex — same pattern as
 * /api/business-units/:hexId and /api/regular-customers).
 *
 * Lifted from paymentRequests.ts so the Lana-online payment requests and the
 * Lana Online Shop orders share ONE definition of "this hex may act for this
 * unit": the unit must be active, belong to THIS app (NOT a simple.lanapays.us
 * unit — see unitOrigin.ts), and the hex must be its owner or a staff `p`.
 */

import type Database from 'better-sqlite3';
import { SIMPLE_UNIT_SQL } from './unitOrigin.js';

export const HEX64 = /^[0-9a-f]{64}$/i;

/** Business unit row if `hex` is its owner or an authorized staff hex, else null. */
export function unitForMerchant(db: Database.Database, hex: string, unitId: string): any | null {
  if (!HEX64.test(hex || '') || !unitId) return null;
  const u = db.prepare(`
    SELECT unit_id, name, owner_hex, authorized_hex, currency, suspension_status
    FROM business_units
    WHERE status = 'active' AND unit_id = ? AND NOT ${SIMPLE_UNIT_SQL}
  `).get(unitId) as any;
  if (!u) return null;
  if (u.owner_hex === hex) return u;
  try {
    const authList: string[] = JSON.parse(u.authorized_hex || '[]');
    if (authList.includes(hex)) return u;
  } catch { /* fall through */ }
  return null;
}

/** All unit_ids where `hex` is owner or authorized (for cross-unit notification). */
export function unitIdsForMerchant(db: Database.Database, hex: string): string[] {
  if (!HEX64.test(hex || '')) return [];
  const units = db.prepare(`
    SELECT unit_id, owner_hex, authorized_hex FROM business_units
    WHERE status = 'active' AND NOT ${SIMPLE_UNIT_SQL} AND (owner_hex = ? OR authorized_hex LIKE ?)
  `).all(hex, `%${hex}%`) as any[];
  return units.filter(u => {
    if (u.owner_hex === hex) return true;
    try { return (JSON.parse(u.authorized_hex || '[]') as string[]).includes(hex); } catch { return false; }
  }).map(u => u.unit_id);
}
