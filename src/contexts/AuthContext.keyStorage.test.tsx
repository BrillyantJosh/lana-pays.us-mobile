/**
 * Where the private key lives after a sign-in (Brilly, 25. 11. 2026 — the same as LetsBalance.world): in this tab's
 * memory, never in localStorage. Until that day the session kept it there in plain text for eight hours on the till; a session
 * saved like that is rewritten without the key the first time this version reads it. Every key here is a fresh random
 * TEST key.
 */
import { render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // This runner has no real Storage (see src/lib/exclusion.test.ts), and i18n reads it on import: a plain one.
  if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') return;
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => { map.set(k, String(v)); },
      removeItem: (k: string) => { map.delete(k); },
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() { return map.size; },
    },
  });
});
import { AuthProvider, useAuth } from './AuthContext';
import { convertWifToIds } from '@/lib/crypto';
import { forgetHeldKey, heldKeyHex } from '@/lib/heldKey';

const SESSION_KEY = 'lana_pays_session';

async function testWallet() {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const payload = new Uint8Array([0xb0, ...key, 0x01]);
  const h1 = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
  const h2 = new Uint8Array(await crypto.subtle.digest('SHA-256', h1));
  const full = new Uint8Array([...payload, ...h2.slice(0, 4)]);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + Array.from(full, (b) => b.toString(16).padStart(2, '0')).join(''));
  let wif = '';
  while (n > 0n) { wif = alphabet[Number(n % 58n)] + wif; n /= 58n; }
  return { wif, ...(await convertWifToIds(wif)) };
}

/** Nobody is excluded; every card has a profile. */
const server = vi.fn(async (url: any) => {
  const u = String(url);
  if (u.includes('/api/exclusion/')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ excluded: false }) };
  if (u.includes('/api/profile-lookup')) return { ok: true, status: 200, json: async () => ({ profile: { name: 'Test trgovec', currency: 'EUR' }, reachable: true }) };
  return { ok: true, status: 200, json: async () => ({}) };
}) as any;

let auth: ReturnType<typeof useAuth>;
const Probe = () => {
  auth = useAuth();
  return (
    <div>
      <span data-testid="session">{auth.session ? auth.session.nostrHexId : 'none'}</span>
      <span data-testid="locked">{auth.locked ? auth.locked.nostrHexId : 'none'}</span>
    </div>
  );
};
const mount = () => render(<AuthProvider><Probe /></AuthProvider>);

beforeEach(() => { localStorage.clear(); forgetHeldKey(); vi.stubGlobal('fetch', server); });
afterEach(() => { vi.unstubAllGlobals(); forgetHeldKey(); });

describe('the private key after a sign-in', () => {
  it('is held in this tab, and the browser keeps only the public part', async () => {
    const w = await testWallet();
    mount();
    await act(async () => { await auth.login(w.wif); });
    expect(screen.getByTestId('session')).toHaveTextContent(w.nostrHexId);
    expect(auth.session?.privateKeyHex).toBe(w.privateKeyHex);
    const stored = localStorage.getItem(SESSION_KEY)!;
    expect(JSON.parse(stored).nostrHexId).toBe(w.nostrHexId);
    expect(stored).not.toContain(w.privateKeyHex);
    expect(stored).not.toContain(w.wif);
    expect(stored).not.toMatch(/privateKey/i);
    expect(heldKeyHex()).toBe(w.nostrHexId);
  });

  it('is gone after a reload: the merchant is remembered, locked', async () => {
    const w = await testWallet();
    const first = mount();
    await act(async () => { await auth.login(w.wif); });
    first.unmount();
    forgetHeldKey(); // a reload empties the tab's memory

    mount();
    await waitFor(() => expect(screen.getByTestId('locked')).toHaveTextContent(w.nostrHexId));
    expect(screen.getByTestId('session')).toHaveTextContent('none');
  });

  it('an old session with the key in plain text is rewritten without it at once', async () => {
    const w = await testWallet();
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      walletId: w.walletId, nostrHexId: w.nostrHexId, nostrNpubId: w.nostrNpubId,
      privateKeyHex: w.privateKeyHex, currency: 'EUR', expiresAt: Date.now() + 3_600_000,
    }));
    mount();
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent(w.nostrHexId));
    const stored = localStorage.getItem(SESSION_KEY)!;
    expect(stored).not.toContain(w.privateKeyHex);
    expect(JSON.parse(stored).nostrHexId).toBe(w.nostrHexId);
    // this tab carries on with the key it already had; nothing else on the device has it
    expect(heldKeyHex()).toBe(w.nostrHexId);
  });

  it('signing out takes the key out of memory too', async () => {
    const w = await testWallet();
    mount();
    await act(async () => { await auth.login(w.wif); });
    act(() => auth.logout());
    expect(screen.getByTestId('session')).toHaveTextContent('none');
    expect(screen.getByTestId('locked')).toHaveTextContent('none');
    expect(heldKeyHex()).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });
});
