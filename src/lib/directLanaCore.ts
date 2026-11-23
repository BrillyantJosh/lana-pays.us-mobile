/**
 * LANA neposredno ("LANA direct"): the money and the exact bytes of one direct
 * sale of a shop without a company and without a bank account (KIND 30901
 * payout_account "none", Brilly 23 Nov 2026).
 *
 * The customer's card pays the shop's own wallet in one plain LANA transaction.
 * The brain is not asked and never learns of it. The customer's card key signs
 * the transaction and a public KIND 9350 record of it, in the till's browser.
 * This server only checks, keeps the exact bytes, sends them, and publishes the
 * record once the payment is in a block.
 *
 * THIS FILE EXISTS TWICE, BYTE FOR BYTE: src/lib/directLanaCore.ts (the till,
 * which signs) and server/lib/directLanaCore.ts (the server, which checks). The
 * server's container never ships src/, so it cannot import the till's copy, and
 * two copies that drift would price one sale two ways. A test fails the moment
 * the two files differ by one byte: change one, copy it over the other.
 *
 * Ported from letsbalance-world, which sends the same kind of payment and
 * publishes the same KIND 9350 record: apps/universal/lib/pays/transfer.ts,
 * apps/api/src/modules/pays-us/transferTx.ts and apps/universal/lib/pointsOrder.ts
 * (the margin, with its shared test vectors).
 *
 * Money is integers only: cents and lanoshi (1 LANA = 100,000,000) as BigInt,
 * never a float. Nothing here talks to the network, reads a clock or keeps a key.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { createBase58check } from '@scure/base';

export const NETWORK = 'lanacoin:mainnet';
/** KIND 9350 v1.1.0, "LANA Direct Transfer Record". No new version is needed. */
export const TRANSFER_KIND = 9350;
/** How long a quote may be signed and sent (LetsBalance: 120 s). */
export const QUOTE_SECONDS = 120;
/** At most this many coins in one payment. More need a merge first. */
export const MAX_INPUTS = 20;
/** Change this small goes to the fee, and an amount this small is refused. */
export const DUST_LANOSHI = 1000n;
export const MAX_MARGIN_PERCENT = 20;
export const MAX_DESCRIPTION = 1000;
export const MAX_RECIPIENT_NAME = 200;
export const MAX_INVOICE_NUMBER = 64;
/** The currencies KIND 38888 prices LANA in, each with two decimals. */
export const DIRECT_CURRENCIES = ['EUR', 'GBP', 'USD'];
/** Who may pay directly: registrar wallet types (Brilly's defaults, 23 Nov 2026). */
export const PAYER_WALLET_TYPES = ['Main Wallet', 'Wallet', 'Retail', 'LanaPays.Us'];
/** Where a shop without a company is paid: its owner's Main Wallet (Brilly, 23 Nov 2026). */
export const PAYEE_WALLET_TYPE = 'Main Wallet';
const LANOSHI_PER_LANA = 100_000_000n;

/**
 * A refusal with a code a till turns into the seller's words. The two copies of
 * this file are two classes at run time, so a reader across them asks the
 * name and the code, not instanceof.
 */
export class DirectLanaError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.name = 'DirectLanaError';
    this.code = code;
  }
}
const fail = (code: string, message?: string): never => {
  throw new DirectLanaError(code, message);
};

// ── Margin ──────────────────────────────────────────────────────────────────

/**
 * A margin in whole percent from its tag text, read as KIND 30905 and Točka
 * obilja read theirs (letsbalance-world pointsOrder.ts marginPercent): absent or
 * empty is 0, "0".."20" as written, anything else null. A shop whose margin
 * cannot be read takes no direct sale.
 */
export function marginPercent(text: string | undefined | null): number | null {
  const value = (text ?? '').trim();
  if (!value) return 0;
  return /^(0|[1-9]\d?)$/.test(value) && Number(value) <= MAX_MARGIN_PERCENT ? Number(value) : null;
}

/**
 * The invoice with the margin, in whole cents, half a cent up:
 * pay = floor((cents * (100 + m) + 50) / 100). Applied once, to the invoice
 * total: 10.00 + 10 % = 11.00; 7.99 + 20 % = 9.588, so 9.59.
 */
export function withMargin(cents: bigint, margin: number): bigint {
  if (cents < 0n || !Number.isInteger(margin) || margin < 0 || margin > MAX_MARGIN_PERCENT) {
    fail('MARGIN_INVALID');
  }
  return (cents * BigInt(100 + margin) + 50n) / 100n;
}

// ── Fiat and LANA amounts ───────────────────────────────────────────────────

/** "10", "10.5", "10,50" → 1050n cents. Anything else is refused. */
export function parseCents(text: unknown): bigint {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!/^\d{1,13}(?:[.,]\d{1,2})?$/.test(value)) fail('AMOUNT_INVALID');
  const [whole, fraction = ''] = value.replace(',', '.').split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** 1050n → "10.50". */
export function centsText(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const n = cents < 0n ? -cents : cents;
  return `${sign}${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`;
}

/** A KIND 38888 fx price as it is written: digits, an optional point, no sign, above zero. */
export function validRate(rate: unknown): rate is string {
  return typeof rate === 'string' && /^\d{1,12}(?:\.\d{1,18})?$/.test(rate) && /[1-9]/.test(rate);
}

/**
 * Cents to lanoshi at the price of one LANA, rounded DOWN to the lanoshi
 * (letsbalance-world transfer.ts amountInLanoshi): 11.00 EUR at 0.256 is
 * 4,296,875,000 lanoshi = 42.96875 LANA.
 */
export function lanoshiForCents(cents: bigint, rate: string): bigint {
  if (!validRate(rate)) fail('RATE_UNAVAILABLE');
  const [whole, fraction = ''] = rate.split('.');
  const r = BigInt(whole + fraction);
  return (cents * LANOSHI_PER_LANA * 10n ** BigInt(fraction.length)) / (100n * r);
}

/** 4296875000n → "42.96875"; 100000000n → "1". */
export function lanaText(lanoshi: bigint): string {
  const whole = lanoshi / LANOSHI_PER_LANA;
  const fraction = (lanoshi % LANOSHI_PER_LANA).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

// ── Network fee and change ──────────────────────────────────────────────────

/** 150 lanoshi a byte of an estimated size (letsbalance-world transfer.ts feeFor). */
export const feeFor = (inputs: number, outputs: number): bigint =>
  BigInt(inputs * 181 + outputs * 34 + 14) * 150n;

/**
 * Fee and change of a payment of `amount` from these coins. The customer pays
 * the fee on top. It is always charged for two outputs (the shop, then the
 * change back to the card). Change of 1000 lanoshi or less goes to the fee, so
 * the fee written down is always inputs minus outputs.
 */
export function amounts(values: bigint[], amount: bigint): { amount: bigint; fee: bigint; change: bigint } {
  if (!values.length || values.length > MAX_INPUTS) fail('INPUT_LIMIT');
  const total = values.reduce((sum, v) => sum + v, 0n);
  let fee = feeFor(values.length, 2);
  let change = total - amount - fee;
  if (amount <= DUST_LANOSHI) fail('AMOUNT_TOO_SMALL');
  if (change < 0n) fail('INSUFFICIENT_FUNDS');
  if (change > 0n && change <= DUST_LANOSHI) {
    fee += change;
    change = 0n;
  }
  return { amount, fee, change };
}

// ── Bytes ───────────────────────────────────────────────────────────────────

const base58check = createBase58check(sha256);
export const sha256d = (b: Uint8Array): Uint8Array => sha256(sha256(b));
export const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
export const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
export const u64 = (n: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const varint = (n: number): Uint8Array => {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 255, n >> 8]);
  return fail('TX_TOO_LARGE');
};
/** A length, then the bytes: how a script and each push inside one is written. */
export const field = (b: Uint8Array): Uint8Array => join(varint(b.length), b);
export { bytesToHex, hexToBytes };

const HEX = /^(?:[0-9a-f]{2})+$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** A mainnet LANA address: Base58Check, version byte 0x30, 20 bytes. Never just the prefix. */
export function isAddress(address: unknown): boolean {
  if (typeof address !== 'string' || address.length < 26 || address.length > 35) return false;
  try {
    const b = base58check.decode(address);
    return b.length === 21 && b[0] === 0x30;
  } catch {
    return false;
  }
}

/** The P2PKH script that pays this address. Throws for anything but a valid mainnet address. */
export function addressScript(address: string): Uint8Array {
  if (!isAddress(address)) fail('ADDRESS_INVALID');
  const b = base58check.decode(address);
  return join(new Uint8Array([0x76, 0xa9, 0x14]), b.slice(1), new Uint8Array([0x88, 0xac]));
}

/** A public key (33 bytes compressed, 65 uncompressed), checked to be a point of the curve. */
export function validPublicKey(publicKey: unknown): publicKey is string {
  if (typeof publicKey !== 'string' || !/^(?:0[23][0-9a-f]{64}|04[0-9a-f]{128})$/.test(publicKey)) return false;
  try {
    secp256k1.Point.fromHex(publicKey);
    return true;
  } catch {
    return false;
  }
}

/** The address a public key pays from: compressed and uncompressed are two different addresses. */
export function addressOfPublicKey(publicKey: string): string {
  if (!validPublicKey(publicKey)) fail('CARD_KEY_INVALID');
  const bytes = hexToBytes(publicKey);
  return base58check.encode(join(new Uint8Array([0x30]), ripemd160(sha256(bytes))));
}

/**
 * The Nostr HEX of the card key: the x coordinate, the same for both forms of
 * the public key. It is the author of the KIND 9350 record (the sender signs it).
 */
export const cardHexOf = (publicKey: string): string => publicKey.slice(2, 66);

/** The id of a transaction: double SHA-256 of its exact bytes, reversed. */
export const txidOf = (bytes: Uint8Array): string => bytesToHex(sha256d(bytes).reverse());

/** The time stamp every LANA transaction carries right after its version (Peercoin layout). */
export function rawTime(raw: string): number {
  if (typeof raw !== 'string' || raw.length < 16 || !HEX.test(raw)) return fail('PREVIOUS_TX_INVALID');
  return new DataView(hexToBytes(raw.slice(8, 16)).buffer).getUint32(0, true);
}

/** The outputs of a raw previous transaction: what each pays, and to which script. */
export function rawOutputs(raw: string): { value: bigint; script: string }[] {
  if (typeof raw !== 'string' || !HEX.test(raw)) fail('PREVIOUS_TX_INVALID');
  const b = hexToBytes(raw);
  let at = 8;
  const take = (n: number) => {
    if (n < 0 || at + n > b.length) fail('PREVIOUS_TX_INVALID');
    const p = b.slice(at, at + n);
    at += n;
    return p;
  };
  const count = () => {
    const n = take(1)[0];
    if (n < 253) return n;
    if (n === 253) {
      const p = take(2);
      return p[0] + p[1] * 256;
    }
    return fail('PREVIOUS_TX_INVALID');
  };
  const inputs = count();
  if (inputs < 1 || inputs > 1000) fail('PREVIOUS_TX_INVALID');
  for (let i = 0; i < inputs; i++) {
    take(36);
    take(count());
    take(4);
  }
  const outputs = count();
  if (outputs < 1 || outputs > 2000) fail('PREVIOUS_TX_INVALID');
  const out: { value: bigint; script: string }[] = [];
  for (let i = 0; i < outputs; i++) {
    const v = take(8);
    out.push({ value: new DataView(v.buffer).getBigUint64(0, true), script: bytesToHex(take(count())) });
  }
  take(4);
  if (at !== b.length) fail('PREVIOUS_TX_INVALID');
  return out;
}

// ── The plan of one direct sale ─────────────────────────────────────────────

/** One coin the payment spends, with the whole previous transaction it comes from. */
export type DirectLanaCoin = { txid: string; vout: number; value: string; height: number; raw: string };

/**
 * Everything one direct payment is, frozen when the server quotes it: the
 * invoice, the margin, the price and its KIND 38888, the coins, the amounts and
 * the time stamp. The till signs exactly this, and the server sends exactly this.
 */
export type DirectLanaPlan = {
  v: 1;
  network: string;
  /** One quote, one signed payment at most. */
  attempt_id: string;
  /** One sale at the till; a sale may need a second quote (a price change, a replacement). */
  sale_id: string;
  unit_id: string;
  /** The shop's name, public in the record. */
  unit_name: string;
  /** The card's address (the one its key's compression names). */
  sender: string;
  /** The card's public key, hex. */
  public_key: string;
  /** The x coordinate of the card key: the author of the record. */
  card_hex: string;
  /** The shop's wallet: its owner's Main Wallet, from the shop's KIND 30901. */
  recipient: string;
  /** The registrar owner of that wallet, who is the shop's owner. */
  recipient_hex: string;
  currency: string;
  invoice_cents: string;
  margin_percent: number;
  pay_cents: string;
  /** The KIND 38888 fx price of 1 LANA, exactly as written there. */
  rate: string;
  rate_event_id: string;
  /** '' when the seller entered none. */
  invoice_number: string;
  /** Lanoshi to the shop. */
  amount: string;
  /** Lanoshi to the network: inputs minus outputs, the customer pays it. */
  fee: string;
  /** Lanoshi back to the card's own address. */
  change: string;
  inputs: DirectLanaCoin[];
  /** Unix seconds: the transaction's nTime and the record's created_at. */
  created_at: number;
  expires: number;
};

const PLAN_KEYS = [
  'v', 'network', 'attempt_id', 'sale_id', 'unit_id', 'unit_name', 'sender', 'public_key', 'card_hex',
  'recipient', 'recipient_hex', 'currency', 'invoice_cents', 'margin_percent', 'pay_cents', 'rate',
  'rate_event_id', 'invoice_number', 'amount', 'fee', 'change', 'inputs', 'created_at', 'expires',
];
const COIN_KEYS = ['txid', 'vout', 'value', 'height', 'raw'];
const CONTROL = /[\u0000-\u001f\u007f]/;

/** At most `max` UTF-16 units, never cutting a character in two, control characters gone. */
export function clip(text: unknown, max: number): string {
  const clean = Array.from(String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim());
  let out = '';
  for (const ch of clean) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out.trim();
}

/** A valid invoice number, trimmed: at most 64 characters, no control characters. '' means none. */
export function invoiceNumberOf(text: unknown): string {
  if (text === undefined || text === null) return '';
  if (typeof text !== 'string') return fail('INVOICE_NUMBER_INVALID');
  const value = text.trim();
  if (value.length > MAX_INVOICE_NUMBER || CONTROL.test(value)) fail('INVOICE_NUMBER_INVALID');
  return value;
}

/**
 * The public description of the sale, one item per line (Brilly's list, 23 Nov
 * 2026): the shop and its unit id, the invoice, the margin, the total, the
 * price with its KIND 38888, and the invoice number only when one was entered.
 * Never the seller's note and never the customer's name.
 */
export function saleDescription(plan: Pick<DirectLanaPlan,
  'unit_name' | 'unit_id' | 'currency' | 'invoice_cents' | 'margin_percent' | 'pay_cents' | 'rate' | 'rate_event_id' | 'invoice_number'>): string {
  const invoice = BigInt(plan.invoice_cents);
  const pay = BigInt(plan.pay_cents);
  const cur = plan.currency;
  const lines = [
    'LanaPays.Us direct sale',
    `Unit: ${plan.unit_name} (${plan.unit_id})`,
    `Invoice amount: ${centsText(invoice)} ${cur}`,
    `Margin: ${plan.margin_percent}% (+${centsText(pay - invoice)} ${cur})`,
    `Total: ${centsText(pay)} ${cur}`,
    `Price: 1 LANA = ${plan.rate} ${cur} (KIND 38888 ${plan.rate_event_id})`,
  ];
  if (plan.invoice_number) lines.push(`Invoice no.: ${plan.invoice_number}`);
  return lines.join('\n');
}

/**
 * Is this plan whole, and does every number in it follow from the others?
 * Recomputes the total with the margin, the lanoshi at the price, the fee and
 * the change from the coins, and checks that every coin is a real output of its
 * previous transaction, of exactly that value, paying the card's own address,
 * and not stamped later than the payment. Time limits are the caller's: the till
 * and the server judge "too late" each by its own clock.
 */
export function checkPlan(plan: DirectLanaPlan): { amount: bigint; fee: bigint; change: bigint; description: string } {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('PLAN_INVALID');
  const keys = Object.keys(plan);
  if (keys.length !== PLAN_KEYS.length || keys.some(k => !PLAN_KEYS.includes(k))) fail('PLAN_INVALID');
  if (plan.v !== 1 || plan.network !== NETWORK) fail('PLAN_INVALID');
  if (typeof plan.attempt_id !== 'string' || !/^dla_[0-9a-f]{32}$/.test(plan.attempt_id)) fail('PLAN_INVALID');
  if (typeof plan.sale_id !== 'string' || !/^dls_[0-9a-f]{32}$/.test(plan.sale_id)) fail('PLAN_INVALID');
  if (typeof plan.unit_id !== 'string' || !plan.unit_id || plan.unit_id.length > 100 || CONTROL.test(plan.unit_id)) fail('PLAN_INVALID');
  if (typeof plan.unit_name !== 'string' || plan.unit_name.length > MAX_RECIPIENT_NAME || CONTROL.test(plan.unit_name)) fail('PLAN_INVALID');
  if (!validPublicKey(plan.public_key) || addressOfPublicKey(plan.public_key) !== plan.sender) fail('PLAN_INVALID');
  if (plan.card_hex !== cardHexOf(plan.public_key)) fail('PLAN_INVALID');
  if (!isAddress(plan.recipient) || plan.recipient === plan.sender) fail('PLAN_INVALID');
  if (typeof plan.recipient_hex !== 'string' || !HEX64.test(plan.recipient_hex)) fail('PLAN_INVALID');
  if (!DIRECT_CURRENCIES.includes(plan.currency)) fail('PLAN_INVALID');
  if (typeof plan.invoice_cents !== 'string' || !/^[1-9]\d{0,15}$/.test(plan.invoice_cents)) fail('PLAN_INVALID');
  if (!Number.isInteger(plan.margin_percent) || plan.margin_percent < 0 || plan.margin_percent > MAX_MARGIN_PERCENT) fail('PLAN_INVALID');
  if (plan.pay_cents !== withMargin(BigInt(plan.invoice_cents), plan.margin_percent).toString()) fail('PLAN_AMOUNTS_CHANGED');
  if (!validRate(plan.rate) || typeof plan.rate_event_id !== 'string' || !HEX64.test(plan.rate_event_id)) fail('PLAN_INVALID');
  if (typeof plan.invoice_number !== 'string' || invoiceNumberOf(plan.invoice_number) !== plan.invoice_number) fail('PLAN_INVALID');
  if (![plan.amount, plan.fee, plan.change].every(v => typeof v === 'string' && /^\d{1,18}$/.test(v))) fail('PLAN_INVALID');
  if (!Number.isSafeInteger(plan.created_at) || plan.created_at <= 0 || plan.expires !== plan.created_at + QUOTE_SECONDS) fail('PLAN_INVALID');

  const own = bytesToHex(addressScript(plan.sender));
  if (!Array.isArray(plan.inputs) || !plan.inputs.length || plan.inputs.length > MAX_INPUTS) fail('PLAN_INVALID');
  if (new Set(plan.inputs.map(c => `${c?.txid}:${c?.vout}`)).size !== plan.inputs.length) fail('PLAN_INVALID');
  for (const c of plan.inputs) {
    if (!c || typeof c !== 'object' || Object.keys(c).length !== COIN_KEYS.length || Object.keys(c).some(k => !COIN_KEYS.includes(k))) fail('PLAN_INVALID');
    if (typeof c.txid !== 'string' || !HEX64.test(c.txid) || !Number.isSafeInteger(c.vout) || c.vout < 0) fail('PLAN_INVALID');
    if (typeof c.value !== 'string' || !/^\d{1,18}$/.test(c.value) || !Number.isSafeInteger(c.height) || c.height <= 0) fail('PLAN_INVALID');
    if (typeof c.raw !== 'string' || c.raw.length > 200_000 || !HEX.test(c.raw)) fail('PLAN_INVALID');
    const output = rawOutputs(c.raw)[c.vout];
    if (txidOf(hexToBytes(c.raw)) !== c.txid || !output || output.value !== BigInt(c.value) || output.script !== own) {
      fail('PLAN_INPUT_MISMATCH');
    }
    // The network refuses a transaction stamped earlier than a coin it spends.
    if (rawTime(c.raw) > plan.created_at) fail('PLAN_INPUT_MISMATCH');
  }

  const requested = lanoshiForCents(BigInt(plan.pay_cents), plan.rate);
  const expected = amounts(plan.inputs.map(c => BigInt(c.value)), requested);
  if (expected.amount.toString() !== plan.amount || expected.fee.toString() !== plan.fee || expected.change.toString() !== plan.change) {
    fail('PLAN_AMOUNTS_CHANGED');
  }
  const description = saleDescription(plan);
  if (description.length > MAX_DESCRIPTION) fail('PLAN_INVALID');
  return { ...expected, description };
}

/**
 * The exact bytes of the payment, with these input scripts: version 1, the
 * plan's time stamp, the coins, the shop first, then the change back to the
 * card (only when there is change), lock time 0. Peercoin layout.
 */
export function serialize(plan: DirectLanaPlan, scripts: Uint8Array[]): Uint8Array {
  const inputs = plan.inputs.map((c, i) => join(hexToBytes(c.txid).reverse(), u32(c.vout), field(scripts[i]), u32(0xffffffff)));
  const outputs = [join(u64(BigInt(plan.amount)), field(addressScript(plan.recipient)))];
  if (BigInt(plan.change) > 0n) outputs.push(join(u64(BigInt(plan.change)), field(addressScript(plan.sender))));
  return join(u32(1), u32(plan.created_at), varint(inputs.length), ...inputs, varint(outputs.length), ...outputs, u32(0));
}

/** What the signature of input `index` covers (legacy SIGHASH_ALL, with nTime). */
export function sighash(plan: DirectLanaPlan, index: number): Uint8Array {
  const scripts: Uint8Array[] = plan.inputs.map(() => new Uint8Array(0));
  scripts[index] = addressScript(plan.sender);
  return sha256d(join(serialize(plan, scripts), u32(1)));
}

/** An input script: the DER signature with SIGHASH_ALL, then the public key. */
export const scriptSig = (derSignature: Uint8Array, publicKey: Uint8Array): Uint8Array =>
  join(field(join(derSignature, new Uint8Array([1]))), field(publicKey));

// ── The public record (KIND 9350 v1.1.0) ────────────────────────────────────

export type RecordTemplate = { kind: number; created_at: number; tags: string[][]; content: string };

/**
 * The record of the payment, exactly as letsbalance.world writes one
 * (transfer.ts): four tags in this order, the content keys in this order,
 * created_at = the plan's time stamp. The card key signs it, so the sender is
 * the card. The recipient is the shop's owner, its wallet and the shop's name.
 */
export function recordTemplate(plan: DirectLanaPlan, txid: string): RecordTemplate {
  return {
    kind: TRANSFER_KIND,
    created_at: plan.created_at,
    tags: [
      ['p', plan.recipient_hex],
      ['txid', txid],
      ['network', NETWORK],
      ['v', '1'],
    ],
    content: JSON.stringify({
      v: 1,
      network: NETWORK,
      txid,
      sender: { hex: plan.card_hex, wallet: plan.sender },
      recipient: { hex: plan.recipient_hex, wallet: plan.recipient, name: plan.unit_name },
      amount_lanoshi: plan.amount,
      fee_lanoshi: plan.fee,
      description: saleDescription(plan),
      created_at: plan.created_at,
    }),
  };
}
