/**
 * The encrypted key on this device (lib/keyVault.ts) and the key in this tab's memory (lib/heldKey.ts), the same as
 * LetsBalance.world (Brilly, 25. 11. 2026). Every key here is a fresh random TEST key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertWifToIds } from './crypto';
import {
  VAULT_STORAGE_KEY, VaultError, checkNewPassword, discardSavedRecord, forgetVault, saveVault, setVaultStorage, unlockVault, vaultInfo,
} from './keyVault';
import { VAULT_IDLE_MS, forgetHeldKey, heldKeyFromVault, heldKeyHex, heldPrivateKey, holdKey, onHeldKeyChange, touchHeldKey } from './heldKey';


/** A fresh random TEST key as a Lana WIF (0xb0, compressed), with the id this app derives from it. */
async function generateNewWallet() {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const payload = new Uint8Array([0xb0, ...key, 0x01]);
  const h1 = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
  const h2 = new Uint8Array(await crypto.subtle.digest('SHA-256', h1));
  const full = new Uint8Array([...payload, ...h2.slice(0, 4)]);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + Array.from(full, (b) => b.toString(16).padStart(2, '0')).join(''));
  let privateKeyWIF = '';
  while (n > 0n) { privateKeyWIF = alphabet[Number(n % 58n)] + privateKeyWIF; n /= 58n; }
  const ids = await convertWifToIds(privateKeyWIF);
  return { privateKeyWIF, nostrHexId: ids.nostrHexId, nostrPrivateKey: ids.privateKeyHex };
}

const PASSWORD = 'correct horse battery staple';
let map: Map<string, string>;

beforeEach(() => {
  map = new Map();
  setVaultStorage({
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  });
});
afterEach(() => {
  setVaultStorage(null);
  forgetHeldKey();
  vi.useRealTimers();
});

const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof VaultError ? e.code : `not a VaultError: ${String(e)}`; }
  return 'resolved';
};

describe('the encrypted key on this device', () => {
  it('keeps the key only encrypted, opens with the password, and with nothing else', async () => {
    const w = await generateNewWallet();
    await saveVault(w.privateKeyWIF, w.nostrHexId, 'password', PASSWORD, PASSWORD);

    const raw = map.get(VAULT_STORAGE_KEY)!;
    expect(raw).toBeTruthy();
    expect(raw).not.toContain(w.privateKeyWIF);
    expect(raw).not.toContain(w.nostrPrivateKey);
    expect(vaultInfo()).toEqual({ pubkey: w.nostrHexId, method: 'password' });

    const opened = await unlockVault(PASSWORD);
    expect(opened).toEqual({ wif: w.privateKeyWIF, pubkey: w.nostrHexId });
    expect(await code(unlockVault('wrong password, long enough'))).toBe('unlock_failed');
    // a failed unlock never deletes anything
    expect(map.get(VAULT_STORAGE_KEY)).toBe(raw);
  }, 60_000);

  it('cannot be moved to another identity: the id is bound into the encryption', async () => {
    const w = await generateNewWallet();
    await saveVault(w.privateKeyWIF, w.nostrHexId, 'password', PASSWORD, PASSWORD);
    const record = JSON.parse(map.get(VAULT_STORAGE_KEY)!);
    record.pubkey = 'ab'.repeat(32);
    map.set(VAULT_STORAGE_KEY, JSON.stringify(record));
    expect(await code(unlockVault(PASSWORD))).toBe('unlock_failed');
  }, 60_000);

  it('saves one key per device, and never over another one', async () => {
    const a = await generateNewWallet();
    const b = await generateNewWallet();
    await saveVault(a.privateKeyWIF, a.nostrHexId, 'password', PASSWORD, PASSWORD);
    expect(await code(saveVault(b.privateKeyWIF, b.nostrHexId, 'password', PASSWORD, PASSWORD))).toBe('already_saved');
    expect(await code(saveVault(b.privateKeyWIF, b.nostrHexId, 'password', PASSWORD, PASSWORD, undefined, true))).toBe('already_saved');
    expect(vaultInfo()?.pubkey).toBe(a.nostrHexId);
  }, 60_000);

  it('removes only after a fresh unlock', async () => {
    const w = await generateNewWallet();
    await saveVault(w.privateKeyWIF, w.nostrHexId, 'password', PASSWORD, PASSWORD);
    expect(await code(forgetVault('not the password at all'))).toBe('unlock_failed');
    expect(vaultInfo()).not.toBeNull();
    await forgetVault(PASSWORD);
    expect(vaultInfo()).toBeNull();
    expect(map.has(VAULT_STORAGE_KEY)).toBe(false);
  }, 60_000);

  it('takes back exactly what a failed sign-in had just saved', async () => {
    const w = await generateNewWallet();
    const raw = await saveVault(w.privateKeyWIF, w.nostrHexId, 'password', PASSWORD, PASSWORD);
    discardSavedRecord('something else');
    expect(vaultInfo()).not.toBeNull();
    discardSavedRecord(raw);
    expect(vaultInfo()).toBeNull();
  }, 60_000);

  it('asks for a real password, twice the same', () => {
    expect(() => checkNewPassword('short')).toThrow(VaultError);
    expect(() => checkNewPassword('12345678901234567890')).toThrow(VaultError);
    expect(() => checkNewPassword(PASSWORD, 'something else entirely')).toThrow(VaultError);
    expect(() => checkNewPassword(PASSWORD, PASSWORD)).not.toThrow();
  });

  it('refuses a passkey where the browser has none, and saves nothing', async () => {
    const w = await generateNewWallet();
    expect(await code(saveVault(w.privateKeyWIF, w.nostrHexId, 'passkey'))).toBe('passkey_unavailable');
    expect(vaultInfo()).toBeNull();
  });

  it('refuses what is not a key', async () => {
    expect(await code(saveVault('not a key', 'ab'.repeat(32), 'password', PASSWORD, PASSWORD))).toBe('invalid_key');
    expect(vaultInfo()).toBeNull();
  });
});

describe('the key in this tab', () => {
  const HEX = 'cd'.repeat(32);
  const KEY = '11'.repeat(32);

  it('is given only for its own id', () => {
    holdKey(HEX, KEY, false);
    expect(heldKeyHex()).toBe(HEX);
    expect(heldPrivateKey(HEX)).toBe(KEY);
    expect(heldPrivateKey('ef'.repeat(32))).toBeNull();
    forgetHeldKey();
    expect(heldPrivateKey()).toBeNull();
  });

  it('a typed key stays until sign-out; an unlocked one goes after 15 minutes without use', () => {
    vi.useFakeTimers();
    holdKey(HEX, KEY, false);
    vi.advanceTimersByTime(VAULT_IDLE_MS * 4);
    expect(heldPrivateKey(HEX)).toBe(KEY);

    const seen: (string | null)[] = [];
    const off = onHeldKeyChange(() => seen.push(heldKeyHex()));
    holdKey(HEX, KEY, true);
    expect(heldKeyFromVault()).toBe(true);
    vi.advanceTimersByTime(VAULT_IDLE_MS - 60_000);
    touchHeldKey(); // the person did something: 15 minutes again
    vi.advanceTimersByTime(VAULT_IDLE_MS - 60_000);
    expect(heldPrivateKey(HEX)).toBe(KEY);
    vi.advanceTimersByTime(VAULT_IDLE_MS + 2_000);
    expect(heldPrivateKey(HEX)).toBeNull();
    expect(seen.at(-1)).toBeNull();
    off();
  });

  it('counts the clock, not only the timer (a sleeping device pauses timers)', () => {
    vi.useFakeTimers();
    holdKey(HEX, KEY, true);
    vi.setSystemTime(Date.now() + VAULT_IDLE_MS + 1);
    expect(heldKeyHex()).toBeNull();
    expect(heldPrivateKey(HEX)).toBeNull();
  });
});
