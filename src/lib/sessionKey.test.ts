// @vitest-environment node
/**
 * The till's session survives the phone (Brilly, 26 Nov 2026): the signing key
 * is kept on this device ENCRYPTED with a non-extractable browser key, for the
 * session's hours only (lib/sessionKey.ts). Every key here is a fresh random
 * TEST key; the store is the in-memory one a test hands in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  SESSION_HOURS, keepSessionKey, restoreSessionKey, dropSessionKey, setSessionKeyStore,
  type SessionKeyRecord, type SessionKeyStore,
} from './sessionKey';

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function memoryStore() {
  let record: SessionKeyRecord | undefined;
  const store: SessionKeyStore & { peek(): SessionKeyRecord | undefined; set(r: SessionKeyRecord | undefined): void } = {
    get: async () => record,
    put: async (r) => { record = r; },
    clear: async () => { record = undefined; },
    peek: () => record,
    set: (r) => { record = r; },
  };
  return store;
}

let store: ReturnType<typeof memoryStore>;
const person = () => {
  const sk = generateSecretKey();
  return { hex: getPublicKey(sk), priv: toHex(sk) };
};
const inHours = (h: number) => Date.now() + h * 3_600_000;

beforeEach(() => { store = memoryStore(); setSessionKeyStore(store); });
afterEach(() => { setSessionKeyStore(null); vi.useRealTimers(); });

describe('kept for the session\'s hours', () => {
  it('a sign-in holds for several hours', () => {
    expect(SESSION_HOURS).toBeGreaterThanOrEqual(8);
  });

  it('kept, then brought back: the same key, of the same person', async () => {
    const p = person();
    expect(await keepSessionKey(p.hex, p.priv, inHours(12))).toBe(true);
    expect(await restoreSessionKey(p.hex)).toBe(p.priv);
    // Brought back again: it stays until the hours are over or it is dropped.
    expect(await restoreSessionKey(p.hex)).toBe(p.priv);
  });

  it('never readable at rest: no key bytes in the record, and the browser key cannot be exported', async () => {
    const p = person();
    await keepSessionKey(p.hex, p.priv, inHours(12));
    const r = store.peek()!;
    expect(r.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', r.key)).rejects.toThrow();
    const stored = toHex(new Uint8Array(r.ct)) + toHex(r.iv) + JSON.stringify({ hex: r.hex, expiresAt: r.expiresAt });
    expect(stored).not.toContain(p.priv);
    expect(new Uint8Array(r.ct).length).toBe(32 + 16); // 32 key bytes + the GCM tag
  });

  it('past its hours: nothing, and the copy is gone', async () => {
    const p = person();
    await keepSessionKey(p.hex, p.priv, inHours(1));
    expect(await restoreSessionKey(p.hex, inHours(2))).toBeNull();
    expect(store.peek()).toBeUndefined();
  });

  it('asked for another person: nothing, and the copy is gone', async () => {
    const a = person();
    const b = person();
    await keepSessionKey(a.hex, a.priv, inHours(12));
    expect(await restoreSessionKey(b.hex)).toBeNull();
    expect(store.peek()).toBeUndefined();
  });

  it('a copy changed at rest (its end moved, its bytes, a key of somebody else) never reads', async () => {
    const p = person();
    await keepSessionKey(p.hex, p.priv, inHours(1));
    const r = store.peek()!;
    // The end moved forward: bound into the ciphertext, so it no longer decrypts.
    store.set({ ...r, expiresAt: inHours(48) });
    expect(await restoreSessionKey(p.hex)).toBeNull();
    expect(store.peek()).toBeUndefined();

    await keepSessionKey(p.hex, p.priv, inHours(1));
    const r2 = store.peek()!;
    const ct = new Uint8Array(r2.ct.slice(0));
    ct[0] ^= 1;
    store.set({ ...r2, ct: ct.buffer });
    expect(await restoreSessionKey(p.hex)).toBeNull();
    expect(store.peek()).toBeUndefined();

    // Somebody else's key filed under this person's id: decrypts, but is not theirs.
    const other = person();
    await keepSessionKey(other.hex, other.priv, inHours(1));
    const r3 = store.peek()!;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const end = inHours(1);
    const forged = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`lana.session.v1|${p.hex}|${end}`) },
      key, Uint8Array.from(other.priv.match(/../g)!.map((h) => parseInt(h, 16))),
    );
    store.set({ ...r3, hex: p.hex, expiresAt: end, iv, ct: forged, key });
    expect(await restoreSessionKey(p.hex)).toBeNull();
    expect(store.peek()).toBeUndefined();
  });

  it('dropped (sign-out, a commission decision): nothing', async () => {
    const p = person();
    await keepSessionKey(p.hex, p.priv, inHours(12));
    await dropSessionKey();
    expect(await restoreSessionKey(p.hex)).toBeNull();
  });

  it('a key or an id that does not read, or an end already past: nothing is kept', async () => {
    const p = person();
    expect(await keepSessionKey(p.hex, 'nope', inHours(12))).toBe(false);
    expect(await keepSessionKey('nope', p.priv, inHours(12))).toBe(false);
    expect(await keepSessionKey(p.hex, p.priv, Date.now() - 1)).toBe(false);
    expect(store.peek()).toBeUndefined();
  });

  it('a browser that cannot keep it: false, and the till goes on as before', async () => {
    setSessionKeyStore({ get: async () => undefined, put: async () => { throw new Error('quota'); }, clear: async () => {} });
    const p = person();
    expect(await keepSessionKey(p.hex, p.priv, inHours(12))).toBe(false);
    expect(await restoreSessionKey(p.hex)).toBeNull();
  });

  it('a browser whose storage never answers does not keep the till waiting', async () => {
    vi.useFakeTimers();
    setSessionKeyStore({ get: () => new Promise(() => {}), put: async () => {}, clear: async () => {} });
    const asked = restoreSessionKey(person().hex);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await asked).toBeNull();
  });
});
