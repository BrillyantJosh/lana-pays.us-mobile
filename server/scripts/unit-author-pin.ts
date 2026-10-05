/**
 * Who may publish each business unit's KIND 30901 in this app, and moving
 * that to another key (round 5, 5 Oct 2026 — lana-brain a0d7cdb's root-only
 * repin, as a script). Run by hand on the server, in the app's container (it
 * opens the app's own SQLite file):
 *
 *   npx tsx server/scripts/unit-author-pin.ts list
 *   npx tsx server/scripts/unit-author-pin.ts repin <unit_id> <new_pubkey_hex> <reason…>            (dry run)
 *   npx tsx server/scripts/unit-author-pin.ts repin <unit_id> <new_pubkey_hex> <reason…> --apply    (writes)
 *
 * The pin (business_units.author_pin) is set when a unit is first stored and
 * nothing the relays send can move it (heartbeat.ts syncBusinessUnits). That
 * is the point — and it makes a merchant who lost his key, or moved the shop
 * to another key, unable to update his shop here until a person moves it.
 * Whoever runs `repin` decides which key controls the unit's shipping fee,
 * pickup, owner and staff in this app: exactly as sensitive as the takeover
 * the pin refuses. So it is shell-only (no HTTP route), a dry run unless
 * --apply, needs a reason, and every move is kept in business_unit_pin_log.
 *
 * Before moving a pin, check on the relays that the new key really publishes
 * this unit and that the merchant confirms the change through a channel the
 * new key does not control.
 *
 * `list` prints per unit: unit id, shop name, the pin and the stored author
 * (first 12 hex), whether they differ, and whether the stored 30901 is a
 * verified event of that author with d = unit id (stored_event_ok — the
 * order path judges orders only for such a unit, orderSync moneyUnit); then
 * counts. No buyer data. It opens the database as the app does (getDb runs
 * the migrations, so also the pin backfill a boot would run): to see before
 * a deploy which shops the new rules would hold still, run it on a COPY,
 * with LANA_DB_PATH pointing at the copy.
 */
import { getDb, closeDb } from '../db/connection.js';
import { verifyNostrEvent } from '../lib/nostr.js';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

function main(): number {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const [cmd, unitId, newPin, ...reasonParts] = args.filter(a => a !== '--apply');

  if (cmd === 'list') {
    const db = getDb();
    const rows = db.prepare(`
      SELECT unit_id, name, author_pin, author_pin_set_at, pubkey, raw_event
      FROM business_units ORDER BY name COLLATE NOCASE
    `).all() as any[];
    const storedOk = (r: any): boolean => {
      try {
        const ev = JSON.parse(r.raw_event || 'null');
        const tag = (n: string) => ev?.tags?.find((t: string[]) => t[0] === n)?.[1];
        return verifyNostrEvent(ev, [30901]) && ev.pubkey === r.pubkey && tag('d') === r.unit_id
          && (tag('unit_id') === undefined || tag('unit_id') === r.unit_id);
      } catch { return false; }
    };
    for (const r of rows) {
      console.log(JSON.stringify({
        unit_id: r.unit_id,
        name: r.name,
        author_pin: r.author_pin ? `${String(r.author_pin).slice(0, 12)}…` : null,
        stored_author: r.pubkey ? `${String(r.pubkey).slice(0, 12)}…` : null,
        mismatch: !!r.author_pin && !!r.pubkey && r.author_pin !== r.pubkey,
        stored_event_ok: storedOk(r),
        pinned_at: r.author_pin_set_at,
      }));
    }
    console.log(JSON.stringify({
      units: rows.length,
      unpinned: rows.filter(r => !r.author_pin).length,
      mismatched: rows.filter(r => r.author_pin && r.pubkey && r.author_pin !== r.pubkey).length,
      stored_event_not_ok: rows.filter(r => !storedOk(r)).length,
    }));
    return 0;
  }

  if (cmd === 'repin') {
    const reason = reasonParts.join(' ').trim();
    const pin = String(newPin || '').toLowerCase();
    if (!HEX32.test(unitId || '')) { console.error('unit_id must be 32 lower-case hex characters'); return 2; }
    if (!HEX64.test(pin)) { console.error('new_pubkey_hex must be 64 hex characters'); return 2; }
    if (reason.length < 3) { console.error('a reason is required (it is the audit trail)'); return 2; }
    const db = getDb();
    const unit = db.prepare('SELECT unit_id, name, author_pin, pubkey FROM business_units WHERE unit_id = ?').get(unitId) as any;
    if (!unit) { console.error('business unit not found'); return 1; }
    const previous: string | null = unit.author_pin || null;
    if (previous === pin) { console.log(JSON.stringify({ unit_id: unitId, unchanged: true, pin: `${pin.slice(0, 12)}…` })); return 0; }
    const plan = {
      unit_id: unitId, name: unit.name,
      from: previous ? `${previous.slice(0, 12)}…` : null, to: `${pin.slice(0, 12)}…`,
      stored_author: unit.pubkey ? `${String(unit.pubkey).slice(0, 12)}…` : null,
      reason,
    };
    if (!apply) {
      console.log(JSON.stringify({ dry_run: true, ...plan }));
      console.log('nothing written — add --apply to move the pin');
      return 0;
    }
    db.transaction(() => {
      db.prepare("UPDATE business_units SET author_pin = ?, author_pin_set_at = datetime('now') WHERE unit_id = ?").run(pin, unitId);
      db.prepare('INSERT INTO business_unit_pin_log (unit_id, previous_pin, new_pin, reason) VALUES (?, ?, ?, ?)').run(unitId, previous, pin, reason);
    })();
    console.warn(`[30901-pin] RE-PINNED ${JSON.stringify(plan)}`);
    return 0;
  }

  console.error('usage: unit-author-pin.ts list | repin <unit_id> <new_pubkey_hex> <reason…> [--apply]');
  return 2;
}

let code = 1;
try { code = main(); } finally { closeDb(); }
process.exit(code);
