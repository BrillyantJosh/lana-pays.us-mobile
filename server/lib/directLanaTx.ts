/**
 * A signed direct LANA payment, read from its own bytes on this server, so that
 * nothing the till says about it is taken on its word.
 *
 * verifySignedRaw is the server's half of LANA neposredno: before a payment is
 * kept or sent, every input signature must be a valid low-S signature by the
 * card's key over exactly the stored plan, and the bytes must be exactly the
 * plan's bytes (the coins, the shop's output, the change, the time stamp).
 * Ported from letsbalance-world apps/api/src/modules/pays-us/transferTx.ts
 * (verifySignatures).
 *
 * parseLanaTx and txidOfRaw read any transaction in the Peercoin layout (nTime
 * after the version), strictly, values as BigInt lanoshi. Ported from
 * letsbalance-world apps/api/src/modules/community/lanaTx.ts. The settle step
 * uses them on transactions it reads from the chain.
 */
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  type DirectLanaPlan, bytesToHex, hexToBytes, serialize, sighash, txidOf, DirectLanaError,
} from './directLanaCore.js';

export interface LanaTxOutput {
  lanoshis: bigint;
  /** The scriptPubKey, lower-case hex. */
  script: string;
}

export interface LanaTx {
  version: number;
  nTime: number;
  inputs: { prevTxid: string; vout: number }[];
  outputs: LanaTxOutput[];
  locktime: number;
}

/** A transaction id as this server writes it: 64 lower-case hex. */
export const TXID = /^[0-9a-f]{64}$/;
const MAX_IN_OUT = 10_000;

const sha256d = (bytes: Uint8Array): Buffer =>
  createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest();

/** Parse a raw transaction (hex). Throws on anything that is not exactly one well-formed transaction. */
export function parseLanaTx(rawHex: string): LanaTx {
  if (typeof rawHex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(rawHex)) throw new Error('not hex');
  const b = Buffer.from(rawHex, 'hex');
  let o = 0;
  const need = (n: number) => {
    if (n < 0 || o + n > b.length) throw new Error('truncated');
  };
  const u32 = () => {
    need(4);
    const v = b.readUInt32LE(o);
    o += 4;
    return v;
  };
  const u64 = () => {
    need(8);
    const v = b.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const varint = () => {
    need(1);
    const first = b[o++];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      need(2);
      const v = b.readUInt16LE(o);
      o += 2;
      if (v < 0xfd) throw new Error('noncanonical varint');
      return v;
    }
    if (first === 0xfe) {
      const v = u32();
      if (v <= 0xffff) throw new Error('noncanonical varint');
      return v;
    }
    throw new Error('varint too large');
  };
  const skip = (n: number) => {
    need(n);
    o += n;
  };
  const version = u32();
  const nTime = u32();
  const nIn = varint();
  if (nIn < 1 || nIn > MAX_IN_OUT) throw new Error('inputs');
  const inputs: { prevTxid: string; vout: number }[] = [];
  for (let i = 0; i < nIn; i++) {
    need(32);
    const prevTxid = Buffer.from(b.subarray(o, o + 32)).reverse().toString('hex');
    skip(32);
    const vout = u32();
    inputs.push({ prevTxid, vout });
    skip(varint());
    u32();
  }
  const nOut = varint();
  if (nOut < 1 || nOut > MAX_IN_OUT) throw new Error('outputs');
  const outputs: LanaTxOutput[] = [];
  for (let i = 0; i < nOut; i++) {
    const lanoshis = u64();
    if (lanoshis > (1n << 63n) - 1n) throw new Error('amount overflow');
    const length = varint();
    need(length);
    const script = b.subarray(o, o + length).toString('hex');
    o += length;
    outputs.push({ lanoshis, script });
  }
  const locktime = u32();
  if (o !== b.length) throw new Error('trailing bytes');
  return { version, nTime, inputs, outputs, locktime };
}

/** The id of a raw transaction: sha256d of its bytes, reversed (as Electrum and explorers print it). */
export function txidOfRaw(rawHex: string): string {
  return Buffer.from(sha256d(Buffer.from(rawHex, 'hex'))).reverse().toString('hex');
}

/**
 * The txid of a signed direct payment, after proving it is exactly the stored
 * plan, signed by the plan's card key. Throws TX_INVALID otherwise.
 *
 *  - the input count and, per input, a script holding one DER signature with
 *    SIGHASH_ALL and the plan's own public key;
 *  - each signature valid and low-S for that input's sighash;
 *  - the whole raw equal to the plan serialised with those scripts, so the
 *    outputs, the amounts, the change address and the time stamp are the plan's.
 */
export function verifySignedRaw(plan: DirectLanaPlan, raw: unknown): string {
  const bad = () => new DirectLanaError('TX_INVALID');
  if (typeof raw !== 'string' || !/^(?:[0-9a-f]{2}){80,20000}$/.test(raw)) throw bad();
  const bytes = hexToBytes(raw);
  if (bytes[8] !== plan.inputs.length) throw bad();
  let at = 9;
  const scripts: Uint8Array[] = [];
  for (let i = 0; i < plan.inputs.length; i++) {
    at += 36;
    if (at >= bytes.length) throw bad();
    const size = bytes[at++];
    if (size > 150 || at + size + 4 > bytes.length) throw bad();
    const script = bytes.slice(at, at + size);
    at += size + 4;
    const ns = script[0];
    if (!(ns >= 9 && ns <= 73) || 2 + ns > script.length) throw bad();
    const signature = script.slice(1, 1 + ns);
    const np = script[1 + ns];
    const pub = script.slice(2 + ns);
    if (signature[signature.length - 1] !== 1 || np !== pub.length || bytesToHex(pub) !== plan.public_key) throw bad();
    let valid = false;
    try {
      valid = secp256k1.verify(signature.slice(0, -1), sighash(plan, i), pub, { prehash: false, format: 'der', lowS: true });
    } catch {
      valid = false;
    }
    if (!valid) throw bad();
    scripts.push(script);
  }
  if (bytesToHex(serialize(plan, scripts)) !== raw) throw bad();
  return txidOf(bytes);
}
