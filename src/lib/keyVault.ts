/**
 * THE ENCRYPTED KEY ON THIS DEVICE — the same as LetsBalance.world (Brilly, 25. 11. 2026: »vse LanaPays.Us aplikacije
 * dodelaj da bodo takšne kot je LetsBalance.world v smislu logiranja in shranjevanje privatnega ključa«).
 *
 * A port of letsbalance-world apps/universal/lib/signer/{vault,vaultCrypto}.ts, by way of krog-menjave
 * src/lib/signerVault*.ts, with the same parameters:
 *   - the private key (its WIF) is kept ONLY as an encrypted record in this browser's localStorage;
 *   - the wrapping key comes from a passkey (WebAuthn PRF — on an iPhone or a Mac the passkey lives in iCloud
 *     Keychain) or from a password: scrypt(password NFKC, salt, N=131072, r=8, p=1, dkLen=32);
 *   - AES-GCM; the additional data binds [v, pubkey, method, salt, credential|null], so a record cannot be moved to
 *     another identity or opened another way;
 *   - the server never receives the key or the record.
 *
 * Unlock errors never delete anything. Removing always needs a fresh unlock (being signed in is not enough). Saving
 * over an existing record only with an explicit replace for the same identity. Which identity a WIF belongs to is the
 * app's own derivation (lib/crypto.ts); the caller checks it before saving and after unlocking (AuthContext.tsx).
 *
 * This file is identical in every LanaPays.Us app that has it; change it in all of them or in none.
 */
import { scryptAsync } from '@noble/hashes/scrypt.js';

export const VAULT_STORAGE_KEY = 'lana.signer.v1';

export type VaultProblem =
  | 'invalid_record' | 'invalid_key' | 'other_identity' | 'password_long' | 'password_weak' | 'password_mismatch'
  | 'storage_refused' | 'already_saved' | 'changed_elsewhere' | 'nothing_saved' | 'unlock_failed'
  | 'passkey_unavailable' | 'passkey_no_prf' | 'passkey_cancelled' | 'verify_failed' | 'cancelled';

export class VaultError extends Error {
  constructor(readonly code: VaultProblem) {
    super(code);
    this.name = 'VaultError';
  }
}

export type VaultMethod = 'password' | 'passkey';
export type VaultInfo = { pubkey: string; method: VaultMethod };
type VaultPayload = { wif: string };
type VaultRecord = {
  v: 1;
  pubkey: string;
  method: VaultMethod;
  salt: string;
  iv: string;
  ciphertext: string;
  credential?: string;
};

// ---------------------------------------------------------------------------------------------------------------
// encoding

function b64encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
}
function b64decode(text: string): Uint8Array {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new VaultError('invalid_record');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
const random = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

function checkPayload(payload: VaultPayload): void {
  // What a sign-in field takes: a WIF (base58, 51–52 characters), a 64-hex key or an nsec. Nothing else is held.
  if (
    !payload || typeof payload.wif !== 'string' ||
    !/^([1-9A-HJ-NP-Za-km-z]{50,53}|[0-9a-fA-F]{64}|nsec1[02-9ac-hj-np-z]{58})$/.test(payload.wif)
  ) throw new VaultError('invalid_key');
}

function readRecord(raw: string): VaultRecord {
  if (raw.length > 6000) throw new VaultError('invalid_record');
  let r: VaultRecord;
  try {
    r = JSON.parse(raw) as VaultRecord;
  } catch {
    throw new VaultError('invalid_record');
  }
  if (
    !r || typeof r !== 'object' ||
    r.v !== 1 ||
    typeof r.pubkey !== 'string' || !/^[a-f0-9]{64}$/.test(r.pubkey) ||
    !['password', 'passkey'].includes(r.method) ||
    typeof r.salt !== 'string' || b64decode(r.salt).length !== 32 ||
    typeof r.iv !== 'string' || b64decode(r.iv).length !== 12 ||
    typeof r.ciphertext !== 'string' || r.ciphertext.length < 40 || r.ciphertext.length > 3000 ||
    (r.method === 'passkey' && (typeof r.credential !== 'string' || r.credential.length > 1500))
  ) throw new VaultError('invalid_record');
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// crypto

async function passwordKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  if (password.length > 1024) throw new VaultError('password_long');
  return scryptAsync(password.normalize('NFKC'), salt, { N: 131072, r: 8, p: 1, dkLen: 32, maxmem: 256 * 1024 * 1024, asyncTick: 10 });
}

/** At least 14 characters, not only digits (the same rule as LetsBalance). */
export function checkNewPassword(password: string, repeat?: string): void {
  if (password.length > 1024) throw new VaultError('password_long');
  if (password.normalize('NFKC').length < 14 || /^\d+$/.test(password)) throw new VaultError('password_weak');
  if (repeat !== undefined && repeat !== password) throw new VaultError('password_mismatch');
}

function aad(r: Omit<VaultRecord, 'ciphertext'>): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(JSON.stringify([r.v, r.pubkey, r.method, r.salt, r.credential ?? null])));
}

async function encryptRecord(payload: VaultPayload, meta: Omit<VaultRecord, 'ciphertext' | 'iv'>, wrappingKey: Uint8Array): Promise<VaultRecord> {
  checkPayload(payload);
  const r = { ...meta, iv: b64encode(random(12)) };
  const key = await crypto.subtle.importKey('raw', new Uint8Array(wrappingKey), 'AES-GCM', false, ['encrypt']);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  try {
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(b64decode(r.iv)), additionalData: aad(r) }, key, plain);
    return { ...r, ciphertext: b64encode(new Uint8Array(encrypted)) };
  } finally {
    plain.fill(0);
  }
}

async function decryptRecord(record: VaultRecord, wrappingKey: Uint8Array): Promise<VaultPayload> {
  const r = readRecord(JSON.stringify(record));
  const key = await crypto.subtle.importKey('raw', new Uint8Array(wrappingKey), 'AES-GCM', false, ['decrypt']);
  const buffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(b64decode(r.iv)), additionalData: aad(r) }, key, new Uint8Array(b64decode(r.ciphertext)));
  const plain = new Uint8Array(buffer);
  try {
    const payload = JSON.parse(new TextDecoder().decode(plain)) as VaultPayload;
    checkPayload(payload);
    return payload;
  } finally {
    plain.fill(0);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// storage (injectable so the tests can use a Map; in the browser it is localStorage, every access in try/catch)

export interface VaultStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
let override: VaultStorage | null = null;
export function setVaultStorage(storage: VaultStorage | null): void { override = storage; }
const store = (): VaultStorage => override ?? globalThis.localStorage;
function readRaw(): string | null {
  try { return store().getItem(VAULT_STORAGE_KEY); } catch { return null; }
}
function writeRaw(value: string): void {
  try { store().setItem(VAULT_STORAGE_KEY, value); } catch { throw new VaultError('storage_refused'); }
}
function removeRaw(): void {
  try { store().removeItem(VAULT_STORAGE_KEY); } catch { throw new VaultError('storage_refused'); }
}

/** The saved key's public id and how it opens; null when none — or when the record is unreadable (it is left as it is). */
export function vaultInfo(): VaultInfo | null {
  const raw = readRaw();
  if (!raw) return null;
  try {
    const r = readRecord(raw);
    return { pubkey: r.pubkey, method: r.method };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// passkey (typed here: this module is also checked and tested without the DOM)

interface PasskeyResult { rawId: ArrayBuffer; getClientExtensionResults(): { prf?: { results?: { first?: ArrayBuffer } } } }
interface Browser { isSecureContext?: boolean; PublicKeyCredential?: unknown; location?: { hostname: string }; navigator?: { credentials?: { get(options: object): Promise<unknown>; create(options: object): Promise<unknown> } } }
const browser = () => globalThis as unknown as Browser;

export function passkeyAvailable(): boolean {
  const b = browser();
  return !!b.isSecureContext && !!b.PublicKeyCredential && !!b.navigator?.credentials;
}

async function prf(credential: string, salt: string, signal?: AbortSignal): Promise<Uint8Array> {
  let result: PasskeyResult | null;
  try {
    result = (await browser().navigator!.credentials!.get({
      signal,
      publicKey: {
        challenge: random(32),
        allowCredentials: [{ id: new Uint8Array(b64decode(credential)), type: 'public-key' }],
        userVerification: 'required',
        timeout: 60000,
        extensions: { prf: { eval: { first: new Uint8Array(b64decode(salt)) } } },
      },
    })) as PasskeyResult | null;
  } catch {
    throw new VaultError('passkey_cancelled');
  }
  const bytes = result?.getClientExtensionResults()?.prf?.results?.first;
  if (!bytes || bytes.byteLength !== 32) throw new VaultError('passkey_no_prf');
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------------------------------------------
// the operations

/**
 * Save `wif` (already checked by the caller to be the key of `pubkey`) encrypted on this device. Returns the stored
 * record, so a caller whose sign-in then fails can take back exactly what it saved (discardSavedRecord).
 * A passkey must be created right after the person's click: call this before any network wait.
 */
export async function saveVault(
  wif: string, pubkey: string, method: VaultMethod, password = '', repeat?: string, signal?: AbortSignal, replace = false,
): Promise<string> {
  const original = readRaw();
  const existing = vaultInfo();
  if (original && (!existing || !replace || existing.pubkey !== pubkey)) throw new VaultError('already_saved');
  if (!/^[a-f0-9]{64}$/.test(pubkey)) throw new VaultError('invalid_key');
  const payload: VaultPayload = { wif };
  checkPayload(payload);
  const salt = b64encode(random(32));
  let wrapping: Uint8Array | undefined;
  try {
    let credential: string | undefined;
    if (method === 'password') {
      checkNewPassword(password, repeat);
      wrapping = await passwordKey(password, b64decode(salt));
    } else {
      if (!passkeyAvailable()) throw new VaultError('passkey_unavailable');
      let created: PasskeyResult | null;
      try {
        created = (await browser().navigator!.credentials!.create({
          signal,
          publicKey: {
            challenge: random(32),
            rp: { name: browser().location?.hostname ?? 'Lana' },
            user: { id: random(32), name: `Lana key ${pubkey.slice(0, 12)}`, displayName: `Lana key ${pubkey.slice(0, 12)}` },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
            attestation: 'none',
            timeout: 60000,
            extensions: { prf: {} },
          },
        })) as PasskeyResult | null;
      } catch {
        throw new VaultError('passkey_cancelled');
      }
      if (!created) throw new VaultError('passkey_cancelled');
      credential = b64encode(new Uint8Array(created.rawId));
      // Not every authenticator gives a PRF output; without one nothing can be encrypted, and nothing is saved.
      wrapping = await prf(credential, salt, signal);
    }
    const record = await encryptRecord(payload, { v: 1, pubkey, method, salt, ...(credential ? { credential } : {}) }, wrapping);
    const opened = await decryptRecord(record, wrapping);
    if (opened.wif !== wif) throw new VaultError('verify_failed');
    opened.wif = '';
    if (signal?.aborted) throw new VaultError('cancelled');
    if (readRaw() !== original) throw new VaultError('changed_elsewhere');
    const raw = JSON.stringify(record);
    writeRaw(raw);
    return raw;
  } finally {
    wrapping?.fill(0);
  }
}

/** Take back a record this tab has just saved — only while it is still exactly that record. */
export function discardSavedRecord(raw: string): void {
  if (readRaw() === raw) removeRaw();
}

/** Unlock the saved key (password, or the passkey's prompt). The WIF goes to the caller's memory, never to storage. */
export async function unlockVault(password = '', signal?: AbortSignal): Promise<{ wif: string; pubkey: string }> {
  const raw = readRaw();
  if (!raw) throw new VaultError('nothing_saved');
  const r = readRecord(raw);
  let wrapping: Uint8Array | undefined;
  try {
    wrapping = r.method === 'password' ? await passwordKey(password, b64decode(r.salt)) : await prf(r.credential!, r.salt, signal);
    const payload = await decryptRecord(r, wrapping);
    return { wif: payload.wif, pubkey: r.pubkey };
  } catch (error) {
    if (error instanceof VaultError && (error.code === 'passkey_cancelled' || error.code === 'passkey_no_prf' || error.code === 'password_long')) throw error;
    throw new VaultError('unlock_failed');
  } finally {
    wrapping?.fill(0);
  }
}

/** Remove the saved key from this device: always a fresh unlock first. */
export async function forgetVault(password = '', signal?: AbortSignal): Promise<void> {
  const original = readRaw();
  const opened = await unlockVault(password, signal);
  opened.wif = '';
  if (signal?.aborted) throw new VaultError('cancelled');
  if (readRaw() !== original) throw new VaultError('changed_elsewhere');
  removeRaw();
}
