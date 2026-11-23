/**
 * The till's half of LANA neposredno: the customer's card key, the check of the
 * server's plan, and the signatures. The key never leaves this browser.
 *
 * NOT the brain LANA signer (lib/transaction.ts). That one is hand-rolled ECDSA,
 * spends from the card's uncompressed sibling address first and stamps the
 * transaction with the phone's clock. This one is a port of letsbalance-world
 * apps/universal/lib/pays/transfer.ts: @noble/curves, low-S, and every
 * signature verified before the payment leaves. The nonce is RFC 6979 with
 * fresh extra entropy mixed in (extraEntropy: true), the fleet's rule since the
 * nonce leak of 24 Sept 2026: never a nonce from the key and the message alone.
 * So one plan signed twice gives two different, equally valid signatures; the
 * till never signs a plan twice anyway, and the server takes one set of bytes
 * per quote (a second set is SALE_CONFLICT). It spends only from
 * the address the card's key names (the server quotes only that address's
 * coins, and the plan check below refuses a coin that pays any other script),
 * sends the change back to that same address, and stamps the payment with the
 * plan's time (the server's), which is also the record's created_at.
 *
 * THE KEY. readCardKey turns the scanned WIF into 32 bytes; the text of the WIF
 * is not kept anywhere. signDirectSale ZEROES those bytes when it is done,
 * whether it signed or failed, and forgetCardKey zeroes them when the customer
 * cancels or the quote runs out. JavaScript cannot wipe a string, so the WIF is
 * never stored as one.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { finalizeEvent } from 'nostr-tools/pure';
import { classifyWifInput } from './wifInput';
import {
  DirectLanaError, type DirectLanaPlan, addressOfPublicKey, bytesToHex, cardHexOf, checkPlan, recordTemplate,
  scriptSig, serialize, sighash, txidOf,
} from './directLanaCore';

/** A scanned card: its key bytes (zeroed after use) and what can be said in public about it. */
export interface CardKey {
  key: Uint8Array;
  compressed: boolean;
  publicKey: string;
  /** The address its key's compression names: the one it pays from. */
  address: string;
  /** Its Nostr HEX (x coordinate): the author of the KIND 9350 record. */
  cardHex: string;
}

/**
 * Read a scanned card. A LANA WIF only: version 0xB0 (cards, Lana Paper) or
 * 0x41 (LetsBalance exports), compressed or not, checksum and scalar checked.
 * A wallet address or a Nostr key is refused with its own code.
 */
export function readCardKey(input: string): CardKey {
  const kind = classifyWifInput(input);
  if (kind === 'address') throw new DirectLanaError('CARD_ADDRESS_NOT_KEY');
  if (kind === 'nostr') throw new DirectLanaError('CARD_NOSTR_KEY');
  const raw = input.replace(/[\s​-‍﻿]/g, '');
  let payload: Uint8Array | undefined;
  let key: Uint8Array | undefined;
  try {
    if (raw.length < 50 || raw.length > 53) throw new Error('length');
    payload = createBase58check(sha256).decode(raw);
    if (payload[0] !== 0xb0 && payload[0] !== 0x41) throw new Error('version');
    const compressed = payload.length === 34 && payload[33] === 1;
    if (payload.length !== 33 && !compressed) throw new Error('length');
    key = payload.slice(1, 33);
    // Throws for a scalar outside the curve's range: a checksum alone is not enough.
    const publicKey = bytesToHex(secp256k1.getPublicKey(key, compressed));
    return { key, compressed, publicKey, address: addressOfPublicKey(publicKey), cardHex: cardHexOf(publicKey) };
  } catch {
    key?.fill(0);
    throw new DirectLanaError('CARD_KEY_INVALID');
  } finally {
    payload?.fill(0);
  }
}

/** Zero the card's key (cancel, a quote that ran out, the tab closing). Safe to call twice. */
export function forgetCardKey(card: CardKey | null | undefined): void {
  card?.key.fill(0);
}

/** What the till showed the customer, which the server's plan must say too. */
export interface PlanExpectation {
  unit_id: string;
  /** The shop's wallet the till knows (its KIND 30901, served to this till). */
  recipient: string;
  /** The shop's owner. */
  recipient_hex: string;
  currency: string;
  invoice_cents: string;
  margin_percent: number;
  invoice_number: string;
  sale_id?: string | null;
}

/**
 * Is this the payment the till showed, from this card? The whole plan is
 * checked by the shared rules (lib/directLanaCore.ts checkPlan: the total with
 * the margin, the lanoshi at the price, fee and change from the coins, every
 * coin a real output of its previous transaction paying this card's own
 * address). Then: the card, the shop's wallet and owner, the invoice and the
 * margin are the ones on the screen, and the quote is still good by this
 * device's clock. `askedAtMs` (when the quote was asked for) tells a wrong
 * clock apart from a quote that ran out (letsbalance-world verifyPlan).
 */
export function checkPlanForCard(
  plan: DirectLanaPlan,
  card: Pick<CardKey, 'publicKey' | 'address' | 'cardHex'>,
  expect: PlanExpectation,
  nowMs: number = Date.now(),
  askedAtMs?: number,
): ReturnType<typeof checkPlan> {
  const checked = checkPlan(plan);
  if (plan.public_key !== card.publicKey || plan.sender !== card.address || plan.card_hex !== card.cardHex) {
    throw new DirectLanaError('CARD_MISMATCH');
  }
  if (plan.unit_id !== expect.unit_id || plan.recipient !== expect.recipient || plan.recipient_hex !== expect.recipient_hex) {
    throw new DirectLanaError('PLAN_RECIPIENT_CHANGED');
  }
  if (
    plan.currency !== expect.currency || plan.invoice_cents !== expect.invoice_cents
    || plan.margin_percent !== expect.margin_percent || plan.invoice_number !== expect.invoice_number
    || (expect.sale_id && plan.sale_id !== expect.sale_id)
  ) {
    throw new DirectLanaError('PLAN_INVALID');
  }
  const now = nowMs / 1000;
  if (plan.created_at > now + 30 || plan.expires < now || plan.expires > plan.created_at + 180) {
    if (plan.created_at > now + 30 || (askedAtMs !== undefined && plan.created_at < askedAtMs / 1000 - 30)) {
      throw new DirectLanaError('DEVICE_CLOCK');
    }
    throw new DirectLanaError('QUOTE_EXPIRED');
  }
  return checked;
}

export interface SignedDirectSale {
  /** The exact signed transaction, hex. */
  raw: string;
  txid: string;
  /** The KIND 9350 record, signed by the card's key. */
  record: { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };
}

/**
 * Sign the payment and its record with the card's key, then ZERO THE KEY,
 * whatever happened. Each input is signed (SIGHASH_ALL, with nTime; low-S;
 * RFC 6979 with extra entropy) and the signature verified against the card's
 * public key before it is used.
 */
export function signDirectSale(card: CardKey, plan: DirectLanaPlan): SignedDirectSale {
  try {
    checkPlan(plan);
    const pub = secp256k1.getPublicKey(card.key, card.compressed);
    if (bytesToHex(pub) !== plan.public_key || plan.sender !== card.address) throw new DirectLanaError('CARD_MISMATCH');
    const scripts: Uint8Array[] = [];
    for (let i = 0; i < plan.inputs.length; i++) {
      const hash = sighash(plan, i);
      const signature = secp256k1.sign(hash, card.key, { prehash: false, lowS: true, format: 'der', extraEntropy: true });
      if (!secp256k1.verify(signature, hash, pub, { prehash: false, lowS: true, format: 'der' })) {
        throw new DirectLanaError('SIGNATURE_FAILED');
      }
      scripts.push(scriptSig(signature, pub));
    }
    const bytes = serialize(plan, scripts);
    const txid = txidOf(bytes);
    const event = finalizeEvent(recordTemplate(plan, txid), card.key);
    if (event.pubkey !== plan.card_hex) throw new DirectLanaError('CARD_MISMATCH');
    const record = {
      id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind,
      tags: event.tags, content: event.content, sig: event.sig,
    };
    return { raw: bytesToHex(bytes), txid, record };
  } finally {
    card.key.fill(0);
  }
}
