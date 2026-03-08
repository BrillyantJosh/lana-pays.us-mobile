import elliptic from 'elliptic';
import CryptoJS from 'crypto-js';
import { bech32 } from 'bech32';

const ec = new elliptic.ec('secp256k1');

function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
  return bytes as Uint8Array;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(hex: string): Promise<string> {
  const buffer = hexToBytes(hex);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return bytesToHex(new Uint8Array(hashBuffer));
}

async function sha256d(data: Uint8Array): Promise<Uint8Array> {
  const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const firstHash = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const secondHash = await crypto.subtle.digest("SHA-256", firstHash);
  return new Uint8Array(secondHash);
}

function ripemd160(data: string): string {
  return CryptoJS.RIPEMD160(CryptoJS.enc.Hex.parse(data)).toString();
}

function base58Encode(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt('0x' + bytesToHex(bytes));
  let encoded = "";

  while (num > 0n) {
    let remainder = num % 58n;
    num = num / 58n;
    encoded = alphabet[Number(remainder)] + encoded;
  }

  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = '1' + encoded;
  }

  return encoded;
}

function base58Decode(encoded: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = 0n;

  for (const char of encoded) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error('Invalid Base58 character');
    num = num * 58n + BigInt(index);
  }

  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;

  let bytes = hexToBytes(hex);

  for (const char of encoded) {
    if (char !== '1') break;
    bytes = new Uint8Array([0, ...bytes]);
  }

  return bytes;
}

function normalizeWif(wif: string): string {
  return wif.replace(/[\s\u200B-\u200D\uFEFF\r\n\t]/g, '').trim();
}

async function wifToPrivateKey(wif: string): Promise<string> {
  try {
    const normalizedWif = normalizeWif(wif);
    const decoded = base58Decode(normalizedWif);

    const payload = decoded.slice(0, -4);
    const checksum = decoded.slice(-4);

    const hash = await sha256d(payload);
    const expectedChecksum = hash.slice(0, 4);

    for (let i = 0; i < 4; i++) {
      if (checksum[i] !== expectedChecksum[i]) {
        throw new Error('Invalid WIF checksum');
      }
    }

    // 0xb0 prefix for LanaCoin
    if (payload[0] !== 0xb0) {
      throw new Error('Invalid WIF prefix');
    }

    const privateKey = payload.slice(1, 33);
    return bytesToHex(privateKey);

  } catch (error) {
    throw new Error(`Invalid WIF format: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function generatePublicKey(privateKeyHex: string): string {
  const keyPair = ec.keyFromPrivate(privateKeyHex);
  const pubKeyPoint = keyPair.getPublic();
  return "04" +
    pubKeyPoint.getX().toString(16).padStart(64, '0') +
    pubKeyPoint.getY().toString(16).padStart(64, '0');
}

export function generateCompressedPublicKey(privateKeyHex: string): string {
  const keyPair = ec.keyFromPrivate(privateKeyHex);
  const pubKeyPoint = keyPair.getPublic();
  const yIsEven = pubKeyPoint.getY().isEven();
  const prefix = yIsEven ? "02" : "03";
  return prefix + pubKeyPoint.getX().toString(16).padStart(64, '0');
}

export function deriveNostrPublicKey(privateKeyHex: string): string {
  const keyPair = ec.keyFromPrivate(privateKeyHex);
  const pubKeyPoint = keyPair.getPublic();
  return pubKeyPoint.getX().toString(16).padStart(64, '0');
}

export async function generateLanaAddress(publicKeyHex: string): Promise<string> {
  const sha256Hash = await sha256(publicKeyHex);
  const hash160 = ripemd160(sha256Hash);
  // 0x30 version byte for LanaCoin
  const versionedPayload = "30" + hash160;
  const checksum = await sha256(await sha256(versionedPayload));
  const finalPayload = versionedPayload + checksum.substring(0, 8);
  return base58Encode(hexToBytes(finalPayload));
}

export function hexToNpub(hexPubKey: string): string {
  const data = hexToBytes(hexPubKey);
  const words = bech32.toWords(data);
  return bech32.encode('npub', words);
}

export async function convertWifToIds(wif: string) {
  try {
    const privateKeyHex = await wifToPrivateKey(wif);

    const uncompressedPublicKeyHex = generatePublicKey(privateKeyHex);
    const compressedPublicKeyHex = generateCompressedPublicKey(privateKeyHex);
    const nostrHexId = deriveNostrPublicKey(privateKeyHex);

    const walletId = await generateLanaAddress(compressedPublicKeyHex);
    const walletIdUncompressed = await generateLanaAddress(uncompressedPublicKeyHex);
    const nostrNpubId = hexToNpub(nostrHexId);

    return {
      lanaPrivateKey: wif,
      walletId,
      walletIdUncompressed,
      nostrHexId,
      nostrNpubId,
      nostrPrivateKey: privateKeyHex
    };

  } catch (error) {
    throw new Error(`Conversion failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
