/**
 * THE KEY HELD IN THIS TAB'S MEMORY — never written to storage, never sent (Brilly, 25. 11. 2026: the same as
 * LetsBalance.world; the web port it follows is krog-menjave src/lib/heldKey.ts).
 *
 * - A key typed or scanned at sign-in is held until this tab closes or the person signs out. A reload forgets it.
 * - A key unlocked from the encrypted copy on this device (keyVault.ts) is forgotten after 15 minutes without use
 *   (a click, a key press or a signature counts as use; checked against the clock too, because a hidden tab
 *   throttles timers and a sleeping device pauses them), when the page is left (pagehide), and when the saved copy is
 *   removed or replaced in another tab.
 *
 * The React session (contexts/AuthContext.tsx) holds the same key for the pages; this module is where code outside
 * React (lib/signedRequest.ts) finds it, and where the 15 minutes are counted. One key, of one person.
 *
 * This file is identical in every LanaPays.Us app that has it; change it in all of them or in none.
 */
import { VAULT_STORAGE_KEY } from './keyVault';

export const VAULT_IDLE_MS = 15 * 60 * 1000;

interface Held { hex: string; privateKeyHex: string; fromVault: boolean; lastUse: number; timer?: ReturnType<typeof setTimeout> }
let held: Held | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => { try { fn(); } catch { /* a listener's problem is its own */ } });

/** Called whenever the held key comes or goes (also when it is forgotten for being idle); returns the unsubscribe. */
export function onHeldKeyChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Hold the key of `hex` (64-hex private key). `fromVault`: unlocked from this device's encrypted copy → 15 minutes. */
export function holdKey(hex: string, privateKeyHex: string, fromVault: boolean): void {
  if (!/^[0-9a-f]{64}$/.test(hex) || !/^[0-9a-f]{64}$/i.test(privateKeyHex)) throw new Error('holdKey: not a key');
  if (held?.timer) clearTimeout(held.timer);
  held = { hex, privateKeyHex, fromVault, lastUse: Date.now() };
  arm();
  changed();
}

function arm(): void {
  if (!held?.fromVault) return;
  if (held.timer) clearTimeout(held.timer);
  held.timer = setTimeout(expire, VAULT_IDLE_MS + 1000);
}

/** An unlocked key past its 15 minutes counts as gone — also when no timer has fired (a sleeping device). */
function expired(): boolean {
  return !!held?.fromVault && Date.now() - held.lastUse > VAULT_IDLE_MS;
}
function expire(): void {
  if (expired()) forgetHeldKey();
  else arm();
}

/** The person did something: an unlocked key's 15 minutes start again (unless they have already run out). */
export function touchHeldKey(): void {
  if (!held) return;
  if (expired()) { forgetHeldKey(); return; }
  held.lastUse = Date.now();
  arm();
}

export function forgetHeldKey(): void {
  const had = held !== null;
  if (held?.timer) clearTimeout(held.timer);
  held = null;
  if (had) changed();
}

/** The held private key (64 hex) — of `hex` when given; null when there is none, it is another person's, or it ran out. */
export function heldPrivateKey(hex?: string): string | null {
  if (!held) return null;
  if (expired()) { forgetHeldKey(); return null; }
  if (hex !== undefined && held.hex !== hex) return null;
  held.lastUse = Date.now();
  arm();
  return held.privateKeyHex;
}

/** Whose key is held (null when none); does not count as use. */
export function heldKeyHex(): string | null {
  if (!held || expired()) return null;
  return held.hex;
}

/** Was the held key unlocked from this device's encrypted copy (and so forgotten after 15 minutes)? */
export function heldKeyFromVault(): boolean {
  return !!held && held.fromVault && !expired();
}

// typed here: this module is also checked (and tested) without the DOM
const page = globalThis as unknown as {
  addEventListener?: (type: string, listener: (event: { key?: string | null }) => void, options?: object) => void;
};
if (typeof page.addEventListener === 'function') {
  for (const type of ['pointerdown', 'keydown']) page.addEventListener(type, () => touchHeldKey(), { capture: true, passive: true });
  page.addEventListener('visibilitychange', () => { if (held && expired()) forgetHeldKey(); });
  page.addEventListener('pagehide', () => { if (held?.fromVault) forgetHeldKey(); });
  // the saved copy was removed or replaced in another tab: this tab's unlocked key goes too
  page.addEventListener('storage', (event) => { if (event.key === VAULT_STORAGE_KEY && held?.fromVault) forgetHeldKey(); });
}
