/**
 * Whose name goes on a cash sale — the till's rules, kept pure so they can be pinned.
 *
 * 8 Oct 2026, Živa center: a new card was registered with no name by the LANA
 * tab and then sold to as a bare hex, because a registered card skipped the
 * till's name step. The rules below close that without ever overwriting a
 * profile the till cannot see:
 *
 *   - a name is only written as the person's KIND 0 when EVERY relay confirmed
 *     there is none ('absent') and the scanned key is that identity's own key;
 *   - a profile that exists is never replaced — its name is used instead;
 *   - a relay that did not answer ('unknown') never triggers a question: the
 *     sale goes through exactly as it did before.
 */

export type ProfileStatus =
  | { status: 'found'; name: string | null }
  | { status: 'absent' }
  | { status: 'unknown' };

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The name this app already holds for the wallet — only if it is the same person. */
export function localNameFor(
  user: { hex_id?: string | null; display_name?: string | null } | null | undefined,
  identityHex: string,
): string {
  if (!user || !same(user.hex_id, identityHex)) return '';
  return (user.display_name || '').trim();
}

/** A registered card with no local name: sell under the profile's name, ask for one, or sell as before. */
export function registeredCardStep(
  status: ProfileStatus,
  scannedHex: string | null,
  identityHex: string,
): { action: 'sell'; name: string } | { action: 'askName' } {
  if (status.status === 'found') return { action: 'sell', name: (status.name || '').trim() };
  if (status.status === 'absent' && same(scannedHex, identityHex)) return { action: 'askName' };
  return { action: 'sell', name: '' };
}

/**
 * A new card (not registered, empty): the till registers it and asks for the
 * name. If a profile already exists for this key it is kept — the wallet is
 * registered, nothing is published over it. 'absent' and 'unknown' write the
 * profile, as the till always did for a new card.
 */
export function newCardMode(status: ProfileStatus): { mode: 'new' } | { mode: 'keepProfile'; name: string } {
  if (status.status === 'found') return { mode: 'keepProfile', name: (status.name || '').trim() };
  return { mode: 'new' };
}

/**
 * Tapping a regular customer saved without a name. With a name on the profile
 * the sale carries it; with confirmed no profile the card must be scanned (that
 * asks for the name); a relay that did not answer sells as before.
 */
export function regularCustomerStep(
  savedName: string | null | undefined,
  status: ProfileStatus | null,
): { action: 'sell'; name: string } | { action: 'scanCard' } {
  const saved = (savedName || '').trim();
  if (saved) return { action: 'sell', name: saved };
  if (status?.status === 'absent') return { action: 'scanCard' };
  if (status?.status === 'found') return { action: 'sell', name: (status.name || '').trim() };
  return { action: 'sell', name: '' };
}
