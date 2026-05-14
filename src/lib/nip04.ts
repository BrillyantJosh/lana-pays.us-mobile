/**
 * NIP-04 Encryption/Decryption for Nostr DMs
 * Adapted from MejmoseFajnVer3
 */
import * as secp256k1 from '@noble/secp256k1';

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) hex = '0' + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function fromB64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return new Uint8Array(hashBuffer);
}

function normalizeX(shared: Uint8Array): Uint8Array {
  if (shared.length === 33 || shared.length === 65) return shared.slice(1, 33);
  return shared.slice(0, 32);
}

function pkcs7Pad(data: Uint8Array): Uint8Array {
  const padLength = 16 - (data.length % 16);
  const padded = new Uint8Array(data.length + padLength);
  padded.set(data);
  for (let i = data.length; i < padded.length; i++) padded[i] = padLength;
  return padded;
}

function pkcs7Unpad(data: Uint8Array): Uint8Array {
  if (data.length === 0) throw new Error('Empty data');
  const padLength = data[data.length - 1];
  if (padLength > 16 || padLength > data.length) throw new Error('Invalid padding');
  return data.slice(0, data.length - padLength);
}

async function deriveKey(myPrivKeyHex: string, theirPubKeyHex: string): Promise<Uint8Array> {
  const theirPubKeyCompressed = '02' + theirPubKeyHex;
  const shared = secp256k1.getSharedSecret(hexToBytes(myPrivKeyHex), hexToBytes(theirPubKeyCompressed), true);
  return sha256(normalizeX(shared));
}

export async function nip04Encrypt(
  plaintext: string,
  senderPrivKeyHex: string,
  recipientPubKeyHex: string
): Promise<string> {
  const keyBytes = await deriveKey(senderPrivKeyHex, recipientPubKeyHex);
  const keyBuffer = keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'AES-CBC' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const padded = pkcs7Pad(new TextEncoder().encode(plaintext));
  const paddedBuffer = padded.buffer.slice(padded.byteOffset, padded.byteOffset + padded.byteLength) as ArrayBuffer;
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, paddedBuffer);
  return `${toB64(new Uint8Array(encrypted))}?iv=${toB64(iv)}`;
}

export async function nip04Decrypt(
  encryptedContent: string,
  recipientPrivKeyHex: string,
  senderPubKeyHex: string
): Promise<string> {
  const parts = encryptedContent.split('?iv=');
  if (parts.length !== 2) throw new Error('Invalid NIP-04 format');
  const [ctB64, ivB64] = parts;
  const keyBytes = await deriveKey(recipientPrivKeyHex, senderPubKeyHex);
  const keyBuffer = keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'AES-CBC' }, false, ['decrypt']);
  const ciphertext = fromB64(ctB64);
  const iv = fromB64(ivB64);
  const ctBuffer = ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer;
  const ivBuffer = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBuffer }, cryptoKey, ctBuffer);
  return new TextDecoder().decode(pkcs7Unpad(new Uint8Array(decrypted)));
}
