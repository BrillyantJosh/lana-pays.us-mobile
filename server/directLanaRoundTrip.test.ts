// @vitest-environment node
/**
 * The till signs, the server checks: LANA neposredno end to end, with test keys.
 *
 *  - the till's NEW signer (src/lib/directLanaSign.ts, @noble/curves) and the
 *    server's verifier (lib/directLanaTx.ts) agree, for compressed and
 *    uncompressed cards and for several coins;
 *  - each signature is ALSO checked by Node's own crypto on a preimage built
 *    here independently (the Peercoin legacy SIGHASH_ALL, nTime included), so
 *    the two halves cannot agree on a mistake;
 *  - low-S only; a changed output, time stamp or key is refused;
 *  - the fleet's nonce-leak check: the key is not z(1-s)/(s-r);
 *  - the key bytes are zero after signing, whether it signed or failed;
 *  - the record is the exact KIND 9350 template, signed by the card key.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { verifyEvent } from 'nostr-tools/pure';
import { readCardKey, signDirectSale, checkPlanForCard, forgetCardKey } from '../src/lib/directLanaSign.js';
import { verifySignedRaw, parseLanaTx, txidOfRaw } from './lib/directLanaTx.js';
import { addressScript, recordTemplate, DirectLanaError, bytesToHex, hexToBytes, sighash } from './lib/directLanaCore.js';
import { keyOf, wifOf, pubOf, addressOfKey, hexOfKey, coinsOf, makePlan } from './fixtures/directLana.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OWNER = keyOf(7);
const SHOP_WALLET = addressOfKey(OWNER);
const OWNER_HEX = hexOfKey(OWNER);
const N = secp256k1.Point.CURVE().n;

/**
 * The code of a refusal. The till's copy of directLanaCore.ts and the server's
 * are byte-identical files but two module instances, so a DirectLanaError from
 * the till's copy is not an instance of the server copy's class: read the code.
 */
const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) {
    const c = (e as any)?.code;
    return e instanceof Error && typeof c === 'string' && e.name === DirectLanaError.name ? c : `other: ${String(e)}`;
  }
  return 'no error';
};

function planFor(card: Uint8Array, compressed: boolean, values = [10_000_000_000n]) {
  const sender = addressOfKey(card, compressed);
  return makePlan({ card, compressed, recipient: SHOP_WALLET, recipientHex: OWNER_HEX, coins: coinsOf(sender, values) });
}

/** The DER signature and public key of input `i`, read from the raw bytes. */
function inputScript(raw: string, i: number) {
  const tx = Buffer.from(raw, 'hex');
  let at = 9;
  for (let k = 0; k <= i; k++) {
    at += 36;
    const size = tx[at++];
    const script = tx.subarray(at, at + size);
    at += size + 4;
    if (k === i) {
      const ns = script[0];
      return { der: script.subarray(1, ns), hashType: script[ns], pub: script.subarray(2 + ns) };
    }
  }
  throw new Error('no such input');
}

/** The legacy preimage of input `i`, built here from the plan: only that input carries the sender's script. */
function preimage(plan: ReturnType<typeof planFor>, i: number): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  parts.push(u32(1), u32(plan.created_at), Buffer.from([plan.inputs.length]));
  plan.inputs.forEach((c, k) => {
    parts.push(Buffer.from(c.txid, 'hex').reverse(), u32(c.vout));
    if (k === i) { const s = Buffer.from(addressScript(plan.sender)); parts.push(Buffer.from([s.length]), s); } else parts.push(Buffer.from([0]));
    parts.push(u32(0xffffffff));
  });
  const outs: Array<[bigint, string]> = [[BigInt(plan.amount), plan.recipient]];
  if (BigInt(plan.change) > 0n) outs.push([BigInt(plan.change), plan.sender]);
  parts.push(Buffer.from([outs.length]));
  for (const [v, a] of outs) { const s = Buffer.from(addressScript(a)); parts.push(u64(v), Buffer.from([s.length]), s); }
  parts.push(u32(0), u32(1));
  return Buffer.concat(parts);
}

describe('the till signs with the card key; the server verifies exactly that', () => {
  for (const compressed of [true, false]) {
    it(`${compressed ? 'compressed' : 'uncompressed'} card, two coins: the server returns the same txid`, () => {
      const cardKey = keyOf(1);
      const card = readCardKey(wifOf(cardKey, compressed));
      expect(card.compressed).toBe(compressed);
      expect(card.address).toBe(addressOfKey(cardKey, compressed));
      const plan = planFor(cardKey, compressed, [3_000_000_000n, 2_000_000_000n]);
      expect(plan.inputs.length).toBe(2);
      checkPlanForCard(plan, card, {
        unit_id: plan.unit_id, recipient: SHOP_WALLET, recipient_hex: OWNER_HEX, currency: 'EUR',
        invoice_cents: plan.invoice_cents, margin_percent: plan.margin_percent, invoice_number: '',
      });
      const signed = signDirectSale(card, plan);
      expect(verifySignedRaw(plan, signed.raw)).toBe(signed.txid);
      expect(txidOfRaw(signed.raw)).toBe(signed.txid);

      // Outputs: the shop first, change back to the SAME card address; the plan's time stamp.
      const tx = parseLanaTx(signed.raw);
      expect(tx.nTime).toBe(plan.created_at);
      expect(tx.outputs.map(o => [o.script, o.lanoshis.toString()])).toEqual([
        [bytesToHex(addressScript(SHOP_WALLET)), plan.amount],
        [bytesToHex(addressScript(card.address)), plan.change],
      ]);
      const inputs = plan.inputs.reduce((n, c) => n + BigInt(c.value), 0n);
      const outputs = tx.outputs.reduce((n, o) => n + o.lanoshis, 0n);
      expect((inputs - outputs).toString()).toBe(plan.fee);

      // Every signature, again, by Node's own crypto over a preimage built here.
      const spki = Buffer.concat([
        Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
        Buffer.from(secp256k1.getPublicKey(cardKey, false)),
      ]);
      const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
      plan.inputs.forEach((_, i) => {
        const s = inputScript(signed.raw, i);
        expect(s.hashType).toBe(1);
        expect(bytesToHex(s.pub)).toBe(pubOf(cardKey, compressed));
        const digest = createHash('sha256').update(preimage(plan, i)).digest();
        expect(nodeVerify('sha256', digest, publicKey, s.der)).toBe(true);
        // Low-S, always.
        expect(secp256k1.Signature.fromBytes(s.der, 'der').hasHighS()).toBe(false);
      });
    });
  }

  it('the nonce is RFC 6979 with extra entropy (the fleet rule since 24 Sept): two signings differ, both are exactly the plan', () => {
    const plan = planFor(keyOf(1), true, [3_000_000_000n, 2_000_000_000n]);
    const a = signDirectSale(readCardKey(wifOf(keyOf(1))), plan);
    const b = signDirectSale(readCardKey(wifOf(keyOf(1))), plan);
    // Fresh randomness in every nonce: never the key and the message alone.
    expect(inputScript(a.raw, 0).der).not.toEqual(inputScript(b.raw, 0).der);
    expect(a.txid).not.toBe(b.txid);
    // Each is a whole, valid payment of exactly this plan: the same coins, so at
    // most one of them could ever be in a block, and the server takes only the
    // first set of bytes it is given for a quote (a second is SALE_CONFLICT).
    expect(verifySignedRaw(plan, a.raw)).toBe(a.txid);
    expect(verifySignedRaw(plan, b.raw)).toBe(b.txid);
    expect(parseLanaTx(a.raw).inputs).toEqual(parseLanaTx(b.raw).inputs);
    expect(parseLanaTx(a.raw).outputs).toEqual(parseLanaTx(b.raw).outputs);
  });

  it('the till asks for extra entropy in every signature (src/lib/directLanaSign.ts)', () => {
    const src = readFileSync(path.resolve(here, '../src/lib/directLanaSign.ts'), 'utf8');
    const calls = src.match(/secp256k1\.sign\([^)]*\)/g) || [];
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('extraEntropy: true');
    expect(calls[0]).toContain('lowS: true');
  });

  it('the key is not z(1-s)/(s-r): the nonce does not leak it (the fleet check of 24 Sept)', () => {
    const cardKey = keyOf(1);
    const d = BigInt('0x' + bytesToHex(cardKey));
    const plan = planFor(cardKey, true, [3_000_000_000n, 2_000_000_000n]);
    const signed = signDirectSale(readCardKey(wifOf(cardKey)), plan);
    const mod = (a: bigint) => ((a % N) + N) % N;
    const inv = (a: bigint) => { let [x, y, u, v] = [mod(a), N, 1n, 0n]; while (x !== 0n) { const q = y / x; [x, y, u, v] = [y - q * x, x, v - q * u, u]; } return mod(v); };
    plan.inputs.forEach((_, i) => {
      const sig = secp256k1.Signature.fromBytes(inputScript(signed.raw, i).der, 'der');
      const z = mod(BigInt('0x' + bytesToHex(sighash(plan, i))));
      for (const s of [sig.s, N - sig.s]) expect(mod(z * (1n - s) * inv(s - sig.r))).not.toBe(d);
    });
  });

  it('the key bytes are zero after signing, and after a failed signing', () => {
    const plan = planFor(keyOf(1), true);
    const card = readCardKey(wifOf(keyOf(1)));
    signDirectSale(card, plan);
    expect(card.key.every(b => b === 0)).toBe(true);

    const other = readCardKey(wifOf(keyOf(2)));
    expect(code(() => signDirectSale(other, plan))).toBe('CARD_MISMATCH');
    expect(other.key.every(b => b === 0)).toBe(true);

    const cancelled = readCardKey(wifOf(keyOf(3)));
    forgetCardKey(cancelled);
    expect(cancelled.key.every(b => b === 0)).toBe(true);
  });

  it('the record is the exact KIND 9350 template, signed by the card key', () => {
    const cardKey = keyOf(1);
    const plan = planFor(cardKey, true);
    const signed = signDirectSale(readCardKey(wifOf(cardKey)), plan);
    const expected = recordTemplate(plan, signed.txid);
    expect(signed.record.kind).toBe(9350);
    expect(signed.record.created_at).toBe(plan.created_at);
    expect(signed.record.tags).toEqual(expected.tags);
    expect(signed.record.content).toBe(expected.content);
    expect(signed.record.pubkey).toBe(plan.card_hex);
    expect(JSON.parse(signed.record.content).sender.hex).toBe(signed.record.pubkey);
    expect(verifyEvent({ ...signed.record })).toBe(true);
  });
});

describe('the server refuses anything that is not exactly the plan, signed by its key', () => {
  const cardKey = keyOf(1);
  const plan = planFor(cardKey, true);
  const signed = signDirectSale(readCardKey(wifOf(cardKey)), plan);

  it('a changed output amount, time stamp or recipient', () => {
    const bytes = hexToBytes(signed.raw);
    const nTime = bytes.slice();
    nTime[4] ^= 1;
    expect(code(() => verifySignedRaw(plan, bytesToHex(nTime)))).toBe('TX_INVALID');
    const amount = bytes.slice();
    amount[amount.length - 4 - 34 - 34 + 1] ^= 1;
    expect(code(() => verifySignedRaw(plan, bytesToHex(amount)))).toBe('TX_INVALID');
    expect(code(() => verifySignedRaw({ ...plan, recipient: addressOfKey(keyOf(9)) }, signed.raw))).toBe('TX_INVALID');
    expect(code(() => verifySignedRaw(plan, signed.raw + '00'))).toBe('TX_INVALID');
    expect(code(() => verifySignedRaw(plan, 'zz'))).toBe('TX_INVALID');
  });

  it('a payment signed by another key', () => {
    const otherPlan = planFor(keyOf(2), true);
    const other = signDirectSale(readCardKey(wifOf(keyOf(2))), otherPlan);
    expect(code(() => verifySignedRaw(plan, other.raw))).toBe('TX_INVALID');
  });

  it('a high-S signature (the malleable twin of a valid one)', () => {
    const s = inputScript(signed.raw, 0);
    const sig = secp256k1.Signature.fromBytes(s.der, 'der');
    const high = new secp256k1.Signature(sig.r, N - sig.s).toBytes('der');
    // Valid ECDSA, but not low-S: rebuild the input script with it.
    const script = Buffer.concat([Buffer.from([high.length + 1]), Buffer.from(high), Buffer.from([1]), Buffer.from([s.pub.length]), s.pub]);
    const tx = Buffer.from(signed.raw, 'hex');
    const size = tx[45];
    const rebuilt = Buffer.concat([tx.subarray(0, 45), Buffer.from([script.length]), script, tx.subarray(46 + size)]);
    expect(code(() => verifySignedRaw(plan, rebuilt.toString('hex')))).toBe('TX_INVALID');
  });
});

describe('the card', () => {
  it('a card WIF of either version reads; an address, a Nostr key or garbage does not', () => {
    expect(readCardKey(wifOf(keyOf(1), true, 0x41)).address).toBe(addressOfKey(keyOf(1), true));
    expect(readCardKey(wifOf(keyOf(1), false, 0xb0)).address).toBe(addressOfKey(keyOf(1), false));
    expect(code(() => readCardKey(SHOP_WALLET))).toBe('CARD_ADDRESS_NOT_KEY');
    expect(code(() => readCardKey('npub1' + 'q'.repeat(58)))).toBe('CARD_NOSTR_KEY');
    expect(code(() => readCardKey('not a key at all, not even close to one....'))).toBe('CARD_KEY_INVALID');
    // A valid checksum on a Bitcoin key version (0x80) is not a LANA card.
    expect(code(() => readCardKey(wifOf(keyOf(1), true, 0x80)))).toBe('CARD_KEY_INVALID');
  });

  it('a plan for the uncompressed sibling of a compressed card is refused before signing', () => {
    const cardKey = keyOf(1);
    const card = readCardKey(wifOf(cardKey, true));
    const sibling = planFor(cardKey, false);
    expect(code(() => checkPlanForCard(sibling, card, {
      unit_id: sibling.unit_id, recipient: SHOP_WALLET, recipient_hex: OWNER_HEX, currency: 'EUR',
      invoice_cents: sibling.invoice_cents, margin_percent: sibling.margin_percent, invoice_number: '',
    }))).toBe('CARD_MISMATCH');
    forgetCardKey(card);
  });

  it('a plan to another wallet than the one shown, or with another margin, is refused before signing', () => {
    const cardKey = keyOf(1);
    const card = readCardKey(wifOf(cardKey));
    const plan = planFor(cardKey, true);
    const expect_ = { unit_id: plan.unit_id, recipient: SHOP_WALLET, recipient_hex: OWNER_HEX, currency: 'EUR', invoice_cents: plan.invoice_cents, margin_percent: plan.margin_percent, invoice_number: '' };
    expect(code(() => checkPlanForCard(plan, card, { ...expect_, recipient: addressOfKey(keyOf(9)) }))).toBe('PLAN_RECIPIENT_CHANGED');
    expect(code(() => checkPlanForCard(plan, card, { ...expect_, margin_percent: 5 }))).toBe('PLAN_INVALID');
    expect(code(() => checkPlanForCard(plan, card, expect_, (plan.expires + 1) * 1000))).toBe('QUOTE_EXPIRED');
    expect(code(() => checkPlanForCard(plan, card, expect_, (plan.created_at - 120) * 1000))).toBe('DEVICE_CLOCK');
    expect(code(() => checkPlanForCard(plan, card, expect_))).toBe('no error');
    forgetCardKey(card);
  });
});
