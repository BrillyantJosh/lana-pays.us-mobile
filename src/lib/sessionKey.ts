/**
 * The till's session survives the phone (Brilly, 26 Nov 2026: "the session must
 * hold for hours, also when the seller switches to another app and comes back").
 *
 * Since 25 Nov 2026 the signing key lives only in the tab's memory
 * (lib/heldKey.ts). A phone that puts the browser away reloads the page when the
 * seller comes back, and the key was gone: the seller had to scan again. Now,
 * at sign-in, the key is also kept on this device ENCRYPTED, for the session's
 * hours only:
 *
 *   - a fresh AES-GCM key is made by the browser as NON-EXTRACTABLE: no script,
 *     this app's own included, can ever read its bytes or send them anywhere;
 *     the browser keeps it in IndexedDB and only uses it here;
 *   - the private key is encrypted with it, bound to the person (their hex id)
 *     and to the session's end, and kept beside it;
 *   - back on the page within the hours, the key is decrypted, checked to be
 *     that person's, and held in memory again: the seller is still signed in;
 *   - past the hours, on sign-out, on a commission decision, or when anything
 *     does not read, the whole copy is deleted.
 *
 * Nothing of it is ever in localStorage, and the key is never stored readable.
 * If the browser has no IndexedDB (some private modes), nothing is kept and the
 * till behaves as before: a reload asks to sign in again.
 */
import { getPublicKey } from 'nostr-tools/pure';

/** How long a sign-in holds on this device (Brilly, 26 Nov 2026: "several hours"). */
export const SESSION_HOURS = 12;

export interface SessionKeyRecord {
  v: 1;
  hex: string;
  expiresAt: number;
  iv: Uint8Array;
  ct: ArrayBuffer;
  key: CryptoKey;
}

/** Where the record is kept: IndexedDB in the browser; a test hands in its own. */
export interface SessionKeyStore {
  get(): Promise<SessionKeyRecord | undefined>;
  put(record: SessionKeyRecord): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = 'lana-pays-session';
const STORE_NAME = 'session';
const RECORD_ID = 'current';
/** A browser whose IndexedDB never answers must not keep the till on a spinner. */
const RESTORE_TIMEOUT_MS = 2500;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE_NAME); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

/** One transaction; resolves when it is COMPLETE (written), with what the request answered. */
async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = run(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const indexedDbStore: SessionKeyStore = {
  get: () => withStore<SessionKeyRecord>('readonly', (s) => s.get(RECORD_ID) as IDBRequest<SessionKeyRecord>),
  put: async (record) => { await withStore('readwrite', (s) => { s.put(record, RECORD_ID); }); },
  clear: async () => { await withStore('readwrite', (s) => { s.delete(RECORD_ID); }); },
};

let store: SessionKeyStore = indexedDbStore;
/** For tests: another store (null: the browser's IndexedDB again). */
export function setSessionKeyStore(next: SessionKeyStore | null): void {
  store = next ?? indexedDbStore;
}

const HEX64 = /^[0-9a-f]{64}$/;
const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
/** What the ciphertext is bound to: whose key it is and until when. */
const boundTo = (hex: string, expiresAt: number) => new TextEncoder().encode(`lana.session.v1|${hex}|${expiresAt}`);

/**
 * Keep `privateKeyHex` of `hex` encrypted on this device until `expiresAt` (ms).
 * True when it was kept; false (and nothing kept) when the browser cannot.
 */
export async function keepSessionKey(hex: string, privateKeyHex: string, expiresAt: number): Promise<boolean> {
  const id = String(hex).toLowerCase();
  const priv = String(privateKeyHex).toLowerCase();
  if (!HEX64.test(id) || !HEX64.test(priv) || !(expiresAt > Date.now())) return false;
  const plain = hexToBytes(priv);
  try {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: boundTo(id, expiresAt) }, key, plain);
    await store.put({ v: 1, hex: id, expiresAt, iv, ct, key });
    return true;
  } catch {
    await dropSessionKey();
    return false;
  } finally {
    plain.fill(0);
  }
}

async function readRecord(hex: string, now: number): Promise<string | null> {
  const record = await store.get();
  if (!record) return null;
  const id = String(hex).toLowerCase();
  if (record.v !== 1 || record.hex !== id || !(record.expiresAt > now) || !(record.iv instanceof Uint8Array)) {
    await dropSessionKey();
    return null;
  }
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(record.iv), additionalData: boundTo(id, record.expiresAt) }, record.key, record.ct,
  ));
  try {
    if (plain.length !== 32 || getPublicKey(plain) !== id) { await dropSessionKey(); return null; }
    return bytesToHex(plain);
  } finally {
    plain.fill(0);
  }
}

/**
 * The key of `hex` kept on this device, when it is still within its hours, or
 * null. Anything that does not read deletes the copy. Never waits longer than
 * a moment: a browser that does not answer counts as nothing kept.
 */
export async function restoreSessionKey(hex: string, now = Date.now()): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), RESTORE_TIMEOUT_MS); });
  try {
    return await Promise.race([
      readRecord(hex, now).catch(async () => { await dropSessionKey(); return null; }),
      late,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Delete the kept copy (sign-out, a commission decision, the hours are over). Never throws. */
export async function dropSessionKey(): Promise<void> {
  try { await store.clear(); } catch { /* nothing kept, or the browser cannot: nothing to delete */ }
}
