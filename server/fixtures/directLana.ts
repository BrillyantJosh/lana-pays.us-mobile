/**
 * Test material for LANA neposredno: synthetic keys (32 bytes, all zero but the
 * last), WIFs made from them, synthetic previous transactions in the Peercoin
 * layout, and plans whose every number follows from the others. Nothing here
 * is a real key or a real coin.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import {
  type DirectLanaCoin, type DirectLanaPlan, NETWORK, QUOTE_SECONDS, addressOfPublicKey, addressScript, amounts,
  bytesToHex, cardHexOf, field, join, lanoshiForCents, txidOf, u32, u64, withMargin,
} from '../lib/directLanaCore.js';

/** A synthetic secret key: 31 zero bytes, then n. */
export const keyOf = (n: number): Uint8Array => {
  const k = new Uint8Array(32);
  k[31] = n;
  return k;
};

/** Its WIF: version 0xB0 (cards) or 0x41 (LetsBalance), compressed or not. */
export const wifOf = (key: Uint8Array, compressed = true, version = 0xb0): string =>
  createBase58check(sha256).encode(Uint8Array.from(compressed ? [version, ...key, 1] : [version, ...key]));

export const pubOf = (key: Uint8Array, compressed = true): string => bytesToHex(secp256k1.getPublicKey(key, compressed));
export const addressOfKey = (key: Uint8Array, compressed = true): string => addressOfPublicKey(pubOf(key, compressed));
export const hexOfKey = (key: Uint8Array): string => cardHexOf(pubOf(key, true));

/**
 * A previous transaction paying `address` these values (one output each), with
 * this time stamp. `salt` makes two of them different transactions.
 */
export function previousTx(address: string, values: bigint[], time = 1000, salt = 1): { raw: string; txid: string } {
  const outputs = values.map(v => join(u64(v), field(addressScript(address))));
  const bytes = join(
    u32(1), u32(time),
    new Uint8Array([1]), new Uint8Array(32).fill(salt), u32(0xffffffff), new Uint8Array([0]), u32(0xffffffff),
    new Uint8Array([outputs.length]), ...outputs,
    u32(0),
  );
  return { raw: bytesToHex(bytes), txid: txidOf(bytes) };
}

/** Coins from previous transactions, as a plan names them. */
export function coinsOf(address: string, values: bigint[], opts: { time?: number; salt?: number; height?: number } = {}): DirectLanaCoin[] {
  return values.map((v, i) => {
    const prev = previousTx(address, [v], opts.time ?? 1000, (opts.salt ?? 1) + i);
    return { txid: prev.txid, vout: 0, value: v.toString(), height: opts.height ?? 100 + i, raw: prev.raw };
  });
}

export interface PlanOptions {
  card: Uint8Array;
  compressed?: boolean;
  recipient: string;
  recipientHex: string;
  unitId?: string;
  unitName?: string;
  currency?: string;
  invoiceCents?: bigint;
  margin?: number;
  rate?: string;
  rateEventId?: string;
  invoiceNumber?: string;
  coins?: DirectLanaCoin[];
  createdAt?: number;
  attemptId?: string;
  saleId?: string;
}

/** A plan whose every number follows from its invoice, margin, price and coins. */
export function makePlan(o: PlanOptions): DirectLanaPlan {
  const compressed = o.compressed ?? true;
  const publicKey = pubOf(o.card, compressed);
  const sender = addressOfPublicKey(publicKey);
  const invoice = o.invoiceCents ?? 1000n;
  const margin = o.margin ?? 10;
  const rate = o.rate ?? '0.256';
  const pay = withMargin(invoice, margin);
  const coins = o.coins ?? coinsOf(sender, [10_000_000_000n]);
  const values = amounts(coins.map(c => BigInt(c.value)), lanoshiForCents(pay, rate));
  const createdAt = o.createdAt ?? Math.floor(Date.now() / 1000);
  return {
    v: 1,
    network: NETWORK,
    attempt_id: o.attemptId ?? `dla_${'1'.repeat(32)}`,
    sale_id: o.saleId ?? `dls_${'2'.repeat(32)}`,
    unit_id: o.unitId ?? 'unit-1',
    unit_name: o.unitName ?? 'Kmetija Novak',
    sender,
    public_key: publicKey,
    card_hex: cardHexOf(publicKey),
    recipient: o.recipient,
    recipient_hex: o.recipientHex,
    currency: o.currency ?? 'EUR',
    invoice_cents: invoice.toString(),
    margin_percent: margin,
    pay_cents: pay.toString(),
    rate,
    rate_event_id: o.rateEventId ?? 'e'.repeat(64),
    invoice_number: o.invoiceNumber ?? '',
    amount: values.amount.toString(),
    fee: values.fee.toString(),
    change: values.change.toString(),
    inputs: coins,
    created_at: createdAt,
    expires: createdAt + QUOTE_SECONDS,
  };
}
