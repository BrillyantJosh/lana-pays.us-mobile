/**
 * LANA neposredno ("LANA direct"): a shop without a company and without a bank
 * account (KIND 30901 payout_account "none") takes LANA straight from the
 * customer's card into the owner's Main Wallet, with the shop's margin on top.
 * NOT THROUGH THE BRAIN (Brilly, 23 Nov 2026): no call to the brain, Direct Fund
 * or Lana.Discount, no 30933, no quota, no reward, no caretaker share. The
 * customer's card key signs the transaction and a public KIND 9350 record of it
 * in the till's browser. This server signs nothing: it checks, keeps the exact
 * bytes, sends them to two Electrum servers, and publishes the customer's record
 * once the payment is in a block.
 *
 * ROUTES (every one needs the seller's NIP-98 signature, owner or staff of the
 * shop, and asks the KIND 87058 gate):
 *   GET  /api/direct-lana/price             invoice, margin, total, LANA, price
 *   POST /api/direct-lana/quote             the plan the card will sign
 *   POST /api/direct-lana/submit            the signed payment and record
 *   GET  /api/direct-lana/sales?unit_id=    the shop's direct sales
 *   GET  /api/direct-lana/sales/:id         one attempt, for the till to poll
 *   POST /api/direct-lana/sales/:id/resend  the identical bytes again
 *
 * PAYMENT LINKS (Brilly, 25 Nov 2026; lib/directLanaLinks.ts): the seller makes
 * a link at the till and sends it; the customer pays it at home from their own
 * card, in their own browser. One link is one sale of the same journal, quoted,
 * checked, sent and settled by the same code as at the till (quoteSale,
 * submitAttempt, resendAttempt below), so it can be paid once at most.
 *   POST /api/direct-lana/links               the seller makes a link (signed)
 *   GET  /api/direct-lana/links?unit_id=      the shop's links (signed)
 *   POST /api/direct-lana/links/:id/cancel    close one, while nothing of it is on its way (signed)
 *   GET  /api/direct-lana/links/unseen        paid links not seen yet (signed)
 *   POST /api/direct-lana/links/seen          the seller saw them (signed)
 *   GET  /api/direct-pay/:token               the customer's page
 *   POST /api/direct-pay/:token/quote         the plan the customer's card will sign
 *   POST /api/direct-pay/:token/submit        the signed payment and record
 *   POST /api/direct-pay/:token/resend        the identical bytes again
 * The customer's routes carry no signature: the link's token is the
 * capability. Who sells is the seller who made the link, asked again at every
 * step (still owner or staff, no KIND 87058 decision against them).
 *
 * ORDER AT QUOTE AND AT SUBMIT, each fresh and failing closed: the seller's
 * signature; KIND 87058 for the seller, the owner, the card and the card's
 * registrar owner; the shop's settings and the switch; the verified KIND 38888
 * price; the registrar for the card (registered, not frozen, owner known, an
 * allowed type) and the shop's wallet (registered, not frozen, Main Wallet,
 * owned by the shop's owner, who signed the shop); the card's owner is not the
 * shop's owner and the card is not the shop's wallet; two agreeing Electrum
 * servers with nothing of the card's still waiting for a block; the same price
 * string at submit (else RATE_CHANGED). Any doubt refuses BEFORE anything is
 * sent, and the till can try again.
 *
 * AFTER SENDING, a payment is 'sent' only when a server answered with exactly
 * its txid. Otherwise it is 'unknown', the card is held, and only the chain
 * resolves it, never time. The sweep (runDirectLanaWorker) settles it: in a
 * block = paid; a coin spent by another transaction 6 blocks deep = failed.
 * A payment that hangs, or that every server refused after it was sent, may be
 * replaced only by one that spends at least one of the same coins, so at most
 * one of them can ever be mined (lib/directLanaStore.ts beginValidating).
 *
 * Behind a switch, OFF by default (lib/directLanaUnit.ts): app_settings
 * direct_lana_units = '' | '*' | unit ids.
 */
import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import WebSocket from 'ws';
import { gateNames, excludedNow, excludedMerchant, merchantRefusal } from './lib/exclusionGate.js';
import { exclusionRefusal } from './lib/personExclusion.js';
import { verifyRequestSignature } from './lib/nip98.js';
import { isOwnerOrStaff, unitIdsForMerchant } from './lib/merchantAuth.js';
import { cleanRequestNote } from './lib/requestNote.js';
import { verifyNostrEvent, type NostrEvent } from './lib/nostr.js';
import {
  DirectLanaError, type DirectLanaPlan, type DirectLanaCoin, NETWORK, QUOTE_SECONDS, MAX_INPUTS, DUST_LANOSHI,
  PAYER_WALLET_TYPES, PAYEE_WALLET_TYPE, addressOfPublicKey, amounts, cardHexOf, centsText, checkPlan,
  feeFor, invoiceNumberOf, lanaText, lanoshiForCents, parseCents, rawTime, recordTemplate, validPublicKey, withMargin,
} from './lib/directLanaCore.js';
import { verifySignedRaw, parseLanaTx } from './lib/directLanaTx.js';
import { withChain as liveChain, spendingPending, ChainUnavailable, type WithChain, type ChainRead, type Utxo } from './lib/directLanaChain.js';
import { registrarLookup, RegistrarUnavailable, type RegistrarLookup, type RegistrarAnswer } from './lib/directLanaRegistrar.js';
import { readDirectParams, type DirectParams } from './lib/directLanaParams.js';
import { directUnitState, unitRow, type DirectUnit } from './lib/directLanaUnit.js';
import {
  type LinkRow, linkByToken, linkById, newLinkId, newLinkToken, linkExpiryHours, syncLink, syncAllLinks, linkPayment,
  linkStatusOf, linkAmounts, publicAttemptView, forCustomer, sellerLinkView, saleInFlight,
} from './lib/directLanaLinks.js';
import {
  type DirectRow, getAttempt, attemptsOfSale, heldByCard, invoiceNumberTaken, insertQuote, beginValidating,
  move, attemptView, planOf, mayStillBeMined, refuseBeforeSending, replacesOf,
} from './lib/directLanaStore.js';

/** Relays that answered OK for this event. */
export type RelayPublisher = (event: NostrEvent, relays: string[]) => Promise<string[]>;

export interface DirectLanaDeps {
  withChain: WithChain;
  registrar: RegistrarLookup;
  publish: RelayPublisher;
  /** Milliseconds now (tests move it). */
  nowMs: () => number;
  /** The KIND 38888 author (tests sign their own). */
  paramsPubkey?: string;
  /** Quote, submit and resend calls per minute from one address (20; tests make more). */
  limitPerMinute?: number;
}

/** Confirmations a spend needs before it proves another payment can never be mined. */
const SETTLED_DEPTH = 6;
/** A row still 'validating' or 'broadcasting' this long after its last move was cut off by a crash. */
const STALE_SECONDS = 300;
/** A 'sent' payment neither server holds any more, with every coin unspent, after this long: unknown. */
const LOST_AFTER_SECONDS = 600;
/**
 * The identical bytes are sent again only this long after the card signed
 * them: a re-send is for the customer still at the till. Later the seller pays
 * again with the same card (a replacement: the card is scanned again, every
 * check is made afresh, and it spends one of the same coins).
 */
export const RESEND_WINDOW_SECONDS = 30 * 60;
const RELAYS_NEEDED = 3;

/** The seller's words, in English, for a client that prints `error` as it is. A till reads `code`. */
const WORDS: Record<string, string> = {
  UNKNOWN_UNIT: 'This shop is not known here.',
  UNKNOWN_SALE: 'This payment is not known here.',
  UNIT_NOT_DIRECT: 'This shop does not take LANA directly.',
  DIRECT_LANA_OFF: 'Direct LANA is not switched on for this shop yet.',
  UNIT_BLOCKED: 'This shop cannot take payments at the moment.',
  UNIT_AUTHOR_MISMATCH: 'This shop\'s settings were not signed by its owner.',
  MARGIN_INVALID: 'This shop\'s margin cannot be read. Fix it on shop.lanapays.us.',
  WALLET_INVALID: 'This shop has no valid wallet for LANA. Fix it on shop.lanapays.us.',
  WALLET_CHANGED: 'This shop\'s wallet changed meanwhile. Try again.',
  CURRENCY_UNSUPPORTED: 'There is no LANA price for this shop\'s currency.',
  CURRENCY_MISMATCH: 'This amount is not in the shop\'s currency.',
  RATE_UNAVAILABLE: 'There is no LANA price for this currency right now.',
  RATE_CHANGED: 'The LANA price changed meanwhile. Try again.',
  AMOUNT_INVALID: 'This amount is not valid.',
  AMOUNT_TOO_SMALL: 'This amount is too small to pay in LANA.',
  INVOICE_NUMBER_INVALID: 'This invoice number is not valid.',
  INVOICE_USED: 'This invoice number is already paid in this shop.',
  CARD_KEY_INVALID: 'This card cannot pay.',
  REGISTRAR_UNAVAILABLE: 'The wallet register could not be checked. Try again in a few minutes.',
  PAYER_NOT_REGISTERED: 'The customer\'s card is not registered.',
  PAYER_OWNER_UNKNOWN: 'The owner of the customer\'s card could not be confirmed.',
  PAYER_FROZEN: 'The customer\'s wallet is frozen.',
  PAYER_TYPE_NOT_ALLOWED: 'This kind of wallet cannot pay directly.',
  PAYEE_NOT_REGISTERED: 'The shop\'s wallet is not registered.',
  PAYEE_FROZEN: 'The shop\'s wallet is frozen.',
  PAYEE_TYPE_NOT_ALLOWED: 'The shop\'s wallet is not its owner\'s Main Wallet.',
  PAYEE_OWNER_MISMATCH: 'The shop\'s wallet does not belong to the shop\'s owner.',
  SELF_PAYMENT: 'The shop\'s owner cannot pay their own shop.',
  CHAIN_UNAVAILABLE: 'The LANA network could not be read from two servers. Try again.',
  CHAIN_PENDING: 'The customer\'s wallet has a payment still waiting for a block. Try again after the next block.',
  CARD_PAYMENT_PENDING: 'This card has a payment that is still being checked.',
  SALE_PAYMENT_PENDING: 'This sale has a payment that is still being checked.',
  SALE_ALREADY_PAID: 'This sale is already paid.',
  SALE_MISMATCH: 'This is not the same sale.',
  SALE_CONFLICT: 'This payment was already sent with other bytes.',
  TX_ALREADY_KNOWN: 'This exact payment is already known here. Try again.',
  INSUFFICIENT_FUNDS: 'The card does not have enough confirmed LANA, fee included.',
  INPUT_LIMIT: 'The card has too many small coins. Merge them first.',
  WALLET_STATE_CHANGED: 'The card changed meanwhile. Try again.',
  TX_TOO_LARGE: 'This payment is too large to send in one go.',
  QUOTE_EXPIRED: 'This quote ran out. Try again.',
  TX_INVALID: 'The signed payment does not match the quote.',
  RECORD_INVALID: 'The payment record does not match the payment.',
  BROADCAST_REFUSED: 'The network refused the payment.',
  RESEND_NOT_ALLOWED: 'This payment cannot be sent again.',
  RESEND_TOO_LATE: 'This payment is too old to send again. Pay again with the same card while the customer is here.',
  PLAN_INVALID: 'The payment could not be prepared.',
  SIGNATURE_REQUIRED: 'This till could not confirm who is selling. Reload the page and try again. If that does not help, sign in again.',
  NOT_ENTITLED: 'This sign-in is not listed as the owner or staff of this shop.',
  PERSON_EXCLUDED: 'This sale cannot go through: a community commission has paused the access of someone named on it.',
  MERCHANT_UNAVAILABLE: 'This shop cannot take payments at the moment.',
  LINK_NOT_FOUND: 'This payment link is not known here.',
  LINK_PAID: 'This payment link is already paid.',
  LINK_CANCELLED: 'The seller cancelled this payment link.',
  LINK_EXPIRED: 'This payment link has expired.',
  LINK_CLOSED: 'This shop cannot take this payment at the moment.',
  INVOICE_HAS_LINK: 'This invoice number already has an open payment link.',
};

const words = (code: string) => WORDS[code] || 'The payment could not be prepared.';
const refusal = (code: string, extra: Record<string, unknown> = {}) =>
  ({ success: false, code, error: words(code), message: words(code), ...extra });

const codeOf = (e: unknown): string => {
  if (e instanceof DirectLanaError) return e.code;
  if (e instanceof RegistrarUnavailable) return 'REGISTRAR_UNAVAILABLE';
  if (e instanceof ChainUnavailable) return 'CHAIN_UNAVAILABLE';
  return 'CHAIN_UNAVAILABLE';
};
/** A dependency that did not answer is 503; a KIND 87058 decision is 403; a rule that says no is 409. */
const statusFor = (code: string) =>
  ['REGISTRAR_UNAVAILABLE', 'CHAIN_UNAVAILABLE', 'RATE_UNAVAILABLE'].includes(code) ? 503
    : ['PERSON_EXCLUDED', 'MERCHANT_UNAVAILABLE'].includes(code) ? 403 : 409;

const one = (v: unknown): string => (typeof v === 'string' ? v : '');
const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(16).toString('hex')}`;

/** The card named by a quote's body, for the KIND 87058 gate. Nothing when it does not read. */
function cardOfBody(body: any): { hex: string; address: string } | null {
  try {
    const pub = body?.public_key;
    if (!validPublicKey(pub)) return null;
    return { hex: cardHexOf(pub), address: addressOfPublicKey(pub) };
  } catch {
    return null;
  }
}

const unitOfAttempt = (db: Database.Database, id: unknown): string =>
  (getAttempt(db, id)?.unit_id) ?? '';

/** `hex` when ok; `status` and `body` when not (one shape: strictNullChecks is off here, see nip98.ts). */
type SellerCheck = { ok: boolean; hex?: string; status?: number; body?: unknown };

/**
 * The seller's NIP-98 signature (bound to the exact body of a POST), owner or
 * staff of this shop, and no KIND 87058 decision against the person it proves.
 * Required from day one: there is no "log only" here.
 */
function signedSeller(db: Database.Database, req: Request, unit: { owner_hex?: string; authorized_hex?: string }, nowSec: number): SellerCheck {
  const signed = verifyRequestSignature(req, req.method === 'GET' ? {} : { body: (req as any).rawBody ?? null });
  if (!signed.ok) {
    const { reason } = signed as { ok: false; reason: string };
    return { ok: false, status: 401, body: refusal('SIGNATURE_REQUIRED', { reason, server_time: nowSec }) };
  }
  if (!isOwnerOrStaff(unit, signed.hex)) return { ok: false, status: 403, body: refusal('NOT_ENTITLED') };
  const decision = excludedNow(db, signed.hex);
  if (decision) return { ok: false, status: 403, body: exclusionRefusal(decision) };
  return { ok: true, hex: signed.hex };
}

/** The card: registered, not frozen, its owner known, a wallet type that may pay directly. */
function checkPayer(answer: RegistrarAnswer): { owner: string; type: string } {
  if (!answer.registered) throw new DirectLanaError('PAYER_NOT_REGISTERED');
  if (answer.frozen) throw new DirectLanaError('PAYER_FROZEN');
  if (!answer.owner) throw new DirectLanaError('PAYER_OWNER_UNKNOWN');
  if (!PAYER_WALLET_TYPES.includes(answer.wallet_type)) throw new DirectLanaError('PAYER_TYPE_NOT_ALLOWED');
  return { owner: answer.owner, type: answer.wallet_type };
}

/** The shop's wallet: registered, not frozen, a Main Wallet, owned by the shop's owner. */
function checkPayee(answer: RegistrarAnswer, owner: string): void {
  if (!answer.registered) throw new DirectLanaError('PAYEE_NOT_REGISTERED');
  if (answer.frozen) throw new DirectLanaError('PAYEE_FROZEN');
  if (answer.wallet_type !== PAYEE_WALLET_TYPE) throw new DirectLanaError('PAYEE_TYPE_NOT_ALLOWED');
  if (!answer.owner || answer.owner !== owner) throw new DirectLanaError('PAYEE_OWNER_MISMATCH');
}

/**
 * Remember (or forget) that a shop's wallet is frozen, so its button turns off
 * (and back on). Only a clear "registered and not frozen" forgets it: a wallet
 * the register no longer knows is not thereby unfrozen (every sale to it is
 * refused anyway, PAYEE_NOT_REGISTERED), so its mark stays.
 */
function notePayee(db: Database.Database, unitId: string, wallet: string, answer: RegistrarAnswer, nowSec: number): void {
  const had = db.prepare('SELECT frozen FROM direct_lana_payees WHERE unit_id = ? AND wallet = ?').get(unitId, wallet) as any;
  if (!answer.registered) {
    // Asked, and kept as it was: the sweep asks again in ten minutes, not every pass.
    if (had) db.prepare('UPDATE direct_lana_payees SET checked_at = ? WHERE unit_id = ? AND wallet = ?').run(nowSec, unitId, wallet);
    return;
  }
  const frozen = answer.frozen ? 1 : 0;
  if (!frozen && !had) return;
  db.prepare(`
    INSERT INTO direct_lana_payees (unit_id, wallet, frozen, freeze_reason, checked_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(unit_id, wallet) DO UPDATE SET frozen = excluded.frozen, freeze_reason = excluded.freeze_reason, checked_at = excluded.checked_at
  `).run(unitId, wallet, frozen, answer.freeze_reason, nowSec);
  if (frozen && had?.frozen !== 1) {
    console.error(`[direct-lana] ALERT shop wallet frozen: unit ${unitId.slice(0, 12)} wallet ${wallet.slice(0, 8)}… reason=${answer.freeze_reason || '-'} — its direct LANA button is off until the register says otherwise`);
  }
}

/** The KIND 87058 decision against anyone a direct payment names, said the way the gate says it. */
function exclusionAgainst(db: Database.Database, hexes: string[], unitId: string): { status: number; body: unknown } | null {
  for (const h of hexes) {
    const decision = excludedNow(db, h);
    if (decision) return { status: 403, body: exclusionRefusal(decision) };
  }
  if (excludedMerchant(db, [unitId])) return { status: 403, body: merchantRefusal() };
  return null;
}

const key = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;
const byValue = (a: Utxo, b: Utxo) =>
  BigInt(a.value) === BigInt(b.value) ? a.txid.localeCompare(b.txid) || a.vout - b.vout : BigInt(a.value) > BigInt(b.value) ? -1 : 1;

/**
 * The coins for a payment of `requested` lanoshi: confirmed coins only, largest
 * first, at most 20, skipping coins stamped later than the payment (the network
 * refuses a transaction stamped earlier than a coin it spends). A replacement
 * first takes one still-unspent coin of EVERY attempt of this card that may
 * still be mined, so that this payment and those can never both be in a block.
 */
async function chooseCoins(c: ChainRead, requested: bigint, createdAt: number, replaced: DirectRow[]): Promise<DirectLanaCoin[]> {
  const available = c.snapshot.utxos.filter(u => u.height > 0).sort(byValue);
  if (available.reduce((n, u) => n + BigInt(u.value), 0n) !== BigInt(c.snapshot.confirmed)) {
    throw new DirectLanaError('WALLET_STATE_CHANGED');
  }
  const forced: Utxo[] = [];
  for (const r of replaced) {
    const inputs = planOf(r).inputs;
    const unspent = available.filter(u => inputs.some(i => i.txid === u.txid && i.vout === u.vout));
    if (!unspent.length) throw new DirectLanaError('CARD_PAYMENT_PENDING');
    if (!forced.some(f => unspent.some(u => key(u) === key(f)))) forced.push(unspent[0]);
  }
  if (forced.length > MAX_INPUTS) throw new DirectLanaError('INPUT_LIMIT');
  const early = new Set<string>();
  for (let round = 0; ; round++) {
    if (forced.some(f => early.has(key(f)))) throw new DirectLanaError('CHAIN_PENDING');
    const chosen: Utxo[] = [...forced];
    let values: ReturnType<typeof amounts> | undefined;
    const fits = () => {
      try {
        values = amounts(chosen.map(u => BigInt(u.value)), requested);
      } catch {
        values = undefined;
      }
    };
    fits();
    for (const coin of available) {
      if (values || chosen.length >= MAX_INPUTS) break;
      if (early.has(key(coin)) || chosen.some(u => key(u) === key(coin))) continue;
      chosen.push(coin);
      fits();
    }
    if (!values) {
      if (early.size) throw new DirectLanaError('CHAIN_PENDING');
      const total = available.reduce((n, u) => n + BigInt(u.value), 0n);
      throw new DirectLanaError(available.length > MAX_INPUTS && total - feeFor(available.length, 2) >= requested ? 'INPUT_LIMIT' : 'INSUFFICIENT_FUNDS');
    }
    const read = await Promise.all(chosen.map(async u => ({ txid: u.txid, vout: u.vout, value: u.value, height: u.height, raw: await c.raw(u.txid) })));
    const late = read.filter(coin => rawTime(coin.raw) > createdAt);
    if (!late.length) return read;
    if (round >= 3) throw new DirectLanaError('CHAIN_PENDING');
    for (const coin of late) early.add(key(coin));
  }
}

/**
 * The record the card signed, checked against the plan: the exact template
 * (kind, created_at, the four tags in order, the content byte for byte), the
 * card's key as author, and the signature, verified on a freshly built object.
 */
function checkRecord(record: any, plan: DirectLanaPlan, txid: string): NostrEvent {
  const expected = recordTemplate(plan, txid);
  const bad = () => new DirectLanaError('RECORD_INVALID');
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw bad();
  if (Object.keys(record).some(k => !['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'].includes(k))) throw bad();
  if (record.kind !== expected.kind || record.created_at !== expected.created_at || record.pubkey !== plan.card_hex) throw bad();
  if (record.content !== expected.content || JSON.stringify(record.tags) !== JSON.stringify(expected.tags)) throw bad();
  const fresh = {
    id: record.id, pubkey: record.pubkey, created_at: record.created_at, kind: record.kind,
    tags: record.tags, content: record.content, sig: record.sig,
  };
  // created_at is the plan's, which is in the past: the bound on the future is not the question here.
  if (!verifyNostrEvent(fresh, [expected.kind], Math.max(Math.floor(Date.now() / 1000), plan.created_at))) throw bad();
  return fresh as NostrEvent;
}

/** Publish one event to these relays; the relays that answered OK for exactly this event id. */
export const publishToRelays: RelayPublisher = async (event, relays) => {
  const one = (url: string) => new Promise<boolean>((resolve) => {
    let ws: WebSocket;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* gone */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 7_000);
    try {
      ws = new WebSocket(url);
    } catch {
      finish(false);
      return;
    }
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'OK' && msg[1] === event.id) finish(msg[2] === true);
      } catch { /* one unreadable frame */ }
    });
    ws.on('error', () => finish(false));
    ws.on('close', () => finish(false));
  });
  const results = await Promise.all(relays.map(one));
  return relays.filter((_, i) => results[i]);
};

export function defaultDirectLanaDeps(): DirectLanaDeps {
  return { withChain: liveChain, registrar: registrarLookup, publish: publishToRelays, nowMs: () => Date.now() };
}

// ── The sweep ───────────────────────────────────────────────────────────────

/**
 * Proof that this attempt can never be mined: a coin it spends was spent by a
 * DIFFERENT transaction that lies at least 6 blocks deep. One that pays out
 * exactly the same is the same payment under another id, not a proof
 * (letsbalance-world pays-us/service.ts spentForGood) — unless it is another
 * attempt of this journal: a replacement pays the same, and when the attempt it
 * replaced is mined after all, the replacement has failed (Brilly's rule).
 * Anything unclear is no proof.
 */
async function spentForGood(row: DirectRow, c: ChainRead, journal: Set<string> = new Set()): Promise<boolean> {
  try {
    const plan = planOf(row);
    const s = c.snapshot;
    const gone = plan.inputs.filter(i => !s.utxos.some(u => u.txid === i.txid && u.vout === i.vout));
    if (!gone.length) return false;
    // A spend of a coin lies in the coin's own block or later (a block may hold
    // a coin and the transaction that spends it); one waiting for a block
    // (height 0 or -1) proves nothing.
    const newest = Math.max(...plan.inputs.map(i => i.height));
    const later = s.history.filter(h => h.height > 0 && h.height >= newest && h.txid !== row.txid);
    if (later.length > 40) return false;
    const paid = JSON.stringify(parseLanaTx(row.raw_tx || '').outputs.map(o => [o.script, o.lanoshis.toString()]));
    for (const h of later) {
      const tx = parseLanaTx(await c.raw(h.txid));
      if (!tx.inputs.some(i => gone.some(g => g.txid === i.prevTxid && g.vout === i.vout))) continue;
      const deep = s.height - h.height + 1 >= SETTLED_DEPTH;
      if (journal.has(h.txid)) return deep;
      return deep && JSON.stringify(tx.outputs.map(o => [o.script, o.lanoshis.toString()])) !== paid;
    }
    return false;
  } catch {
    return false;
  }
}

/** Mark an attempt paid; the unique indexes are the last guard against a sale paid twice. */
function markPaid(db: Database.Database, row: DirectRow, height: number, nowSec: number): boolean {
  try {
    return move(db, row.id, ['sent', 'unknown', 'refused', 'superseded'], 'paid', nowSec, { paid_height: height, fromSent: 1 });
  } catch (e: any) {
    console.error(`[direct-lana] ALERT attempt ${row.id} is in block ${height} but cannot be marked paid (${e?.message || e}): check the sale ${row.sale_id} by hand`);
    return false;
  }
}

/** Settle every attempt of one card against a fresh read of two agreeing servers. */
export async function settleCard(db: Database.Database, deps: DirectLanaDeps, address: string, params: DirectParams): Promise<string[]> {
  const nowSec = Math.floor(deps.nowMs() / 1000);
  const rows = (db.prepare(`
    SELECT * FROM direct_lana_sales
    WHERE payer_address = ? AND sent = 1 AND txid IS NOT NULL AND status IN ('sent','unknown','refused','superseded')
    ORDER BY created_at
  `).all(address) as DirectRow[]);
  if (!rows.length) return [];
  const paidNow: DirectRow[] = [];
  const moved: string[] = [];
  // Every payment of this card this server ever signed off on: one of them in a
  // block spends the coins of the others.
  const journal = new Set((db.prepare('SELECT txid FROM direct_lana_sales WHERE payer_address = ? AND txid IS NOT NULL').all(address) as Array<{ txid: string }>).map(r => r.txid));
  try {
    await deps.withChain(params.electrum, address, async (c) => {
      for (const row of rows) {
        const seen = c.snapshot.history.find(h => h.txid === row.txid);
        if (seen && seen.height > 0) {
          if (markPaid(db, row, seen.height, nowSec)) {
            paidNow.push(row);
            moved.push(`${row.id}:paid`);
          }
          continue;
        }
        if (seen) {
          // Waiting for its block on both servers: sent, whatever was heard at the time.
          if (row.status === 'unknown' || row.status === 'refused') {
            if (move(db, row.id, ['unknown', 'refused'], 'sent', nowSec, { reason: null, fromSent: 1 })) moved.push(`${row.id}:sent`);
          }
          continue;
        }
        if (await spentForGood(row, c, journal)) {
          if (move(db, row.id, ['sent', 'unknown', 'refused', 'superseded'], 'failed', nowSec, { reason: 'COIN_SPENT_ELSEWHERE', fromSent: 1 })) moved.push(`${row.id}:failed`);
          continue;
        }
        // Neither server holds it, and every coin it spends is still there: it is
        // not on its way to a block. That is not a failure: it becomes 'unknown',
        // so the seller may replace it with a payment that spends the same coins.
        const unspent = planOf(row).inputs.every(i => c.snapshot.utxos.some(u => u.txid === i.txid && u.vout === i.vout && u.height > 0));
        if (row.status === 'sent' && unspent && nowSec - row.status_at >= LOST_AFTER_SECONDS) {
          if (move(db, row.id, ['sent'], 'unknown', nowSec, { reason: 'NOT_HELD_BY_SERVERS' })) moved.push(`${row.id}:unknown`);
        }
      }
    });
  } finally {
    db.prepare(`UPDATE direct_lana_sales SET checked_at = ? WHERE payer_address = ? AND sent = 1 AND status IN ('sent','unknown','refused','superseded','paid','failed')`).run(nowSec, address);
  }
  // A shop wallet is read again once a payment into it is in a block.
  for (const row of paidNow) {
    try {
      notePayee(db, row.unit_id, row.recipient_wallet, await deps.registrar(row.recipient_wallet), nowSec);
    } catch (e: any) {
      console.warn(`[direct-lana] shop wallet of unit ${row.unit_id.slice(0, 12)} not re-read after payment: ${e?.message || e}`);
    }
  }
  return moved;
}

/**
 * Publish the customer's record of every PAID payment, the identical signed
 * event each time, until at least three relays of KIND 38888 accepted it (all
 * of them when it names fewer). Never re-signed, never for a payment that is not
 * in a block: a refused, failed or superseded payment never becomes a record.
 */
export async function publishPaidRecords(db: Database.Database, deps: DirectLanaDeps, params: DirectParams): Promise<number> {
  const rows = db.prepare(`SELECT * FROM direct_lana_sales WHERE status = 'paid' AND record_published = 0 ORDER BY status_at LIMIT 10`).all() as DirectRow[];
  const relays = params.relays;
  const need = Math.min(RELAYS_NEEDED, relays.length);
  if (!rows.length || need === 0) return 0;
  let published = 0;
  for (const row of rows) {
    let event: NostrEvent;
    try {
      event = JSON.parse(row.record_json || 'null');
    } catch {
      event = null as any;
    }
    if (!event || event.id !== row.record_id || !verifyNostrEvent(event, [9350], Math.max(Math.floor(deps.nowMs() / 1000), row.created_at))) {
      console.error(`[direct-lana] ALERT the stored record of paid attempt ${row.id} does not verify; it is not published`);
      continue;
    }
    let accepted: string[] = [];
    try {
      accepted = JSON.parse(row.record_relays || '[]');
    } catch {
      accepted = [];
    }
    const todo = relays.filter(r => !accepted.includes(r));
    let now: string[] = [];
    try {
      now = todo.length ? await deps.publish(event, todo) : [];
    } catch {
      now = [];
    }
    accepted = [...new Set([...accepted, ...now])];
    const done = accepted.filter(r => relays.includes(r)).length >= need;
    db.prepare(`UPDATE direct_lana_sales SET record_relays = ?, record_published = ?, record_published_at = CASE WHEN ? = 1 THEN datetime('now') ELSE record_published_at END, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(accepted), done ? 1 : 0, done ? 1 : 0, row.id);
    if (done) published++;
  }
  return published;
}

let sweeping = false;

/**
 * One pass of the direct LANA sweep: quotes nobody signed expire, attempts cut
 * off by a crash are put right, sent payments are settled against the chain,
 * paid ones get their record published, and frozen shop wallets are read again.
 */
export async function runDirectLanaWorker(db: Database.Database, deps: DirectLanaDeps = defaultDirectLanaDeps()) {
  const report = { expired: 0, recovered: 0, settled: [] as string[], published: 0 };
  if (sweeping) return report;
  sweeping = true;
  try {
    const nowSec = Math.floor(deps.nowMs() / 1000);
    report.expired = db.prepare(`UPDATE direct_lana_sales SET status = 'expired', reason = 'QUOTE_EXPIRED', status_at = ?, updated_at = datetime('now')
      WHERE status = 'quoted' AND expires_at < ?`).run(nowSec, nowSec).changes;
    // Validating never reached a server: nothing was sent, and what it was to
    // replace is put back (lib/directLanaStore.ts refuseBeforeSending).
    // Broadcasting may have reached one: unknown, the card stays held.
    const stale = db.prepare(`SELECT id FROM direct_lana_sales WHERE status = 'validating' AND status_at < ?`).all(nowSec - STALE_SECONDS) as Array<{ id: string }>;
    for (const s of stale) {
      if (refuseBeforeSending(db, s.id, 'INTERRUPTED_BEFORE_SENDING', nowSec).refused) report.recovered++;
    }
    report.recovered += db.prepare(`UPDATE direct_lana_sales SET status = 'unknown', sent = 1, reason = 'INTERRUPTED_WHILE_SENDING', status_at = ?, updated_at = datetime('now')
      WHERE status = 'broadcasting' AND status_at < ?`).run(nowSec, nowSec - STALE_SECONDS).changes;

    const params = readDirectParams(db, null, { pubkey: deps.paramsPubkey, nowSec });
    if (params && params.electrum.length >= 2) {
      const cards = db.prepare(`
        SELECT payer_address, MIN(COALESCE(checked_at, 0)) AS last FROM direct_lana_sales
        WHERE sent = 1 AND txid IS NOT NULL AND status IN ('sent','unknown','refused','superseded')
        GROUP BY payer_address ORDER BY last LIMIT 8
      `).all() as Array<{ payer_address: string }>;
      for (const card of cards) {
        try {
          report.settled.push(...await settleCard(db, deps, card.payer_address, params));
        } catch (e: any) {
          console.warn(`[direct-lana] could not settle card ${card.payer_address.slice(0, 8)}…: ${e?.message || e}`);
        }
      }
    }
    if (params) report.published = await publishPaidRecords(db, deps, params);
    // A payment link whose sale is now paid says so; one past its time with
    // nothing on its way expires.
    try {
      syncAllLinks(db, nowSec);
    } catch (e: any) {
      console.warn('[direct-lana] payment links not brought up to date:', e?.message || e);
    }

    const frozen = db.prepare('SELECT unit_id, wallet FROM direct_lana_payees WHERE frozen = 1 AND checked_at < ? LIMIT 5').all(nowSec - 600) as Array<{ unit_id: string; wallet: string }>;
    for (const p of frozen) {
      try {
        const answer = await deps.registrar(p.wallet);
        notePayee(db, p.unit_id, p.wallet, answer, nowSec);
        if (answer.registered && !answer.frozen) console.log(`[direct-lana] shop wallet of unit ${p.unit_id.slice(0, 12)} is no longer frozen: its direct LANA button is back`);
      } catch {
        db.prepare('UPDATE direct_lana_payees SET checked_at = ? WHERE unit_id = ? AND wallet = ?').run(nowSec, p.unit_id, p.wallet);
      }
    }
  } finally {
    sweeping = false;
  }
  return report;
}

let workerTimer: ReturnType<typeof setInterval> | null = null;

/** Every 30 s, on its own timer, so a slow Electrum read never holds up the heartbeat. */
export function startDirectLanaWorker(db: Database.Database, deps: DirectLanaDeps = defaultDirectLanaDeps()): void {
  if (workerTimer) return;
  const tick = () => { runDirectLanaWorker(db, deps).catch((e: any) => console.warn('[direct-lana] sweep failed (non-fatal):', e?.message || e)); };
  workerTimer = setInterval(tick, 30_000);
  workerTimer.unref?.();
  setTimeout(tick, 5_000).unref?.();
}

export function stopDirectLanaWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

// ── The routes ──────────────────────────────────────────────────────────────

/** An answer as a route sends it. */
type Answer = { status: number; body: any };

/** What one quote is for, once it is known who sells and which shop (the till's seller, or a payment link). */
interface QuoteInput {
  u: DirectUnit;
  /** Who sells: the till's signed seller, or the seller who made the link. */
  sellerHex: string;
  card: { hex: string; address: string };
  publicKey: string;
  p: DirectParams;
  cents: bigint;
  invoiceNumber: string;
  /** The margin of this sale: the shop's own at the till, the link's for a payment link. */
  margin: number;
  /** undefined: a new sale; otherwise the sale this quote continues (its form is checked here). */
  saleId: unknown;
  /** The till continues only a sale it quoted before; a link's sale may have no attempt yet. */
  saleMustExist: boolean;
}

export function registerDirectLanaRoutes(app: Express, db: Database.Database, overrides: Partial<DirectLanaDeps> = {}): DirectLanaDeps {
  const deps: DirectLanaDeps = { ...defaultDirectLanaDeps(), ...overrides };
  const nowSec = () => Math.floor(deps.nowMs() / 1000);
  const params = (currency: string | null) => readDirectParams(db, currency, { pubkey: deps.paramsPubkey, nowSec: nowSec() });
  // Each quote and submit asks the registrar twice and two Electrum servers:
  // well under the till's own limits, and far from the registrar's hourly budget.
  const directLimiter = rateLimit({ windowMs: 60 * 1000, max: deps.limitPerMinute ?? 20, standardHeaders: true, legacyHeaders: false });
  // The customer's page of a payment link carries no signature, so it is held
  // to the count of the Lana-online pay page (/api/pay/*): ten tries a minute.
  const linkActionLimiter = rateLimit({ windowMs: 60 * 1000, max: deps.limitPerMinute ?? 10, standardHeaders: true, legacyHeaders: false });
  // The page asks again every 10 s while a payment may still change: fifteen
  // minutes of that, with room to spare.
  const linkViewLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: deps.limitPerMinute ? deps.limitPerMinute * 15 : 200, standardHeaders: true, legacyHeaders: false });
  const settling = new Map<string, number>();

  /** Settle a card in the background when a till polls it (at most every 20 s per card). */
  const settleSoon = (row: DirectRow) => {
    if (!mayStillBeMined(row) || row.status === 'validating' || row.status === 'broadcasting' || !row.txid) return;
    const at = settling.get(row.payer_address) ?? 0;
    if (nowSec() - at < 20) return;
    settling.set(row.payer_address, nowSec());
    if (settling.size > 500) settling.clear();
    const p = params(null);
    if (!p || p.electrum.length < 2) return;
    void settleCard(db, deps, row.payer_address, p).catch(() => {});
  };

  /**
   * One quote, the same for the till and for a payment link, once the caller
   * has said who sells, which shop, which card, the invoice and the margin: the
   * sale, the card's own payments, the register, KIND 87058, the chain and the
   * plan, in this order, each fresh and failing closed.
   */
  const quoteSale = async (q: QuoteInput): Promise<Answer> => {
    const { u, card, p } = q;
    const no = (status: number, code: string, extra: Record<string, unknown> = {}): Answer => ({ status, body: refusal(code, extra) });
    let pay: bigint;
    try {
      pay = withMargin(q.cents, q.margin);
    } catch (e) {
      return no(409, codeOf(e) === 'CHAIN_UNAVAILABLE' ? 'MARGIN_INVALID' : codeOf(e));
    }
    const requested = lanoshiForCents(pay, p.rate);
    if (requested <= DUST_LANOSHI) return no(409, 'AMOUNT_TOO_SMALL');
    if (requested > BigInt(Number.MAX_SAFE_INTEGER)) return no(400, 'AMOUNT_INVALID');

    // The sale: a new one, or one started before for exactly this purchase.
    let saleId = newId('dls');
    if (q.saleId !== undefined) {
      if (typeof q.saleId !== 'string' || !/^dls_[0-9a-f]{32}$/.test(q.saleId)) return no(400, 'SALE_MISMATCH');
      const earlier = attemptsOfSale(db, q.saleId);
      if (!earlier.length && q.saleMustExist) return no(404, 'UNKNOWN_SALE');
      if (earlier.some(a => a.unit_id !== u.unit_id || a.currency !== u.currency || a.invoice_cents !== q.cents.toString() || a.invoice_number !== q.invoiceNumber)) {
        return no(409, 'SALE_MISMATCH');
      }
      if (earlier.some(a => a.status === 'paid')) return no(409, 'SALE_ALREADY_PAID');
      // A payment of this sale from another card may still be mined: not a second one beside it.
      if (earlier.some(a => mayStillBeMined(a) && a.payer_address !== card.address)) return no(409, 'SALE_PAYMENT_PENDING');
      saleId = q.saleId;
    }
    if (invoiceNumberTaken(db, u.unit_id, q.invoiceNumber, saleId)) return no(409, 'INVOICE_USED');

    // The card's own payments that may still be mined. One on its way, or one of
    // another sale: the card waits. One of this sale that hangs: a replacement.
    const held = heldByCard(db, card.address);
    const waiting = held.find(h => ['validating', 'broadcasting', 'sent'].includes(h.status) || h.sale_id !== saleId);
    if (waiting) {
      return no(409, 'CARD_PAYMENT_PENDING', waiting.unit_id === u.unit_id ? { pending_attempt_id: waiting.id, pending_sale_id: waiting.sale_id } : {});
    }

    let payer: { owner: string; type: string };
    try {
      // The card first: an unregistered card ends the quote with one question.
      payer = checkPayer(await deps.registrar(card.address));
      const payee = await deps.registrar(u.wallet);
      notePayee(db, u.unit_id, u.wallet, payee, nowSec());
      checkPayee(payee, u.owner_hex);
    } catch (e) {
      const code = codeOf(e);
      return no(statusFor(code), code);
    }
    const excluded = exclusionAgainst(db, [card.hex, payer.owner], u.unit_id);
    if (excluded) return excluded;
    if (payer.owner === u.owner_hex || card.hex === u.owner_hex || card.address === u.wallet) return no(409, 'SELF_PAYMENT');
    if (p.electrum.length < 2) return no(503, 'CHAIN_UNAVAILABLE');

    let plan: DirectLanaPlan;
    let checked: ReturnType<typeof checkPlan>;
    try {
      plan = await deps.withChain(p.electrum, card.address, async (c) => {
        if (spendingPending(c.snapshot)) throw new DirectLanaError('CHAIN_PENDING');
        // A new payment is never byte for byte an earlier one of this card (the
        // same coins and amounts in the same second would be): it is stamped at
        // least a second after the card's last signed attempt.
        const last = (db.prepare('SELECT MAX(created_at) AS t FROM direct_lana_sales WHERE payer_address = ? AND txid IS NOT NULL').get(card.address) as any)?.t;
        const createdAt = Math.max(nowSec(), Number(last || 0) + 1);
        const inputs = await chooseCoins(c, requested, createdAt, held);
        if (!(await c.tipUnchanged())) throw new DirectLanaError('WALLET_STATE_CHANGED');
        const values = amounts(inputs.map(i => BigInt(i.value)), requested);
        return {
          v: 1,
          network: NETWORK,
          attempt_id: newId('dla'),
          sale_id: saleId,
          unit_id: u.unit_id,
          unit_name: u.name,
          sender: card.address,
          public_key: q.publicKey,
          card_hex: card.hex,
          recipient: u.wallet,
          recipient_hex: u.owner_hex,
          currency: u.currency,
          invoice_cents: q.cents.toString(),
          margin_percent: q.margin,
          pay_cents: pay.toString(),
          rate: p.rate,
          rate_event_id: p.event_id,
          invoice_number: q.invoiceNumber,
          amount: values.amount.toString(),
          fee: values.fee.toString(),
          change: values.change.toString(),
          inputs,
          created_at: createdAt,
          expires: createdAt + QUOTE_SECONDS,
        } as DirectLanaPlan;
      });
      checked = checkPlan(plan);
      if (JSON.stringify(plan).length > 250_000) throw new DirectLanaError('TX_TOO_LARGE');
    } catch (e) {
      const code = codeOf(e);
      return no(statusFor(code), code);
    }
    insertQuote(db, {
      plan,
      owner_hex: u.owner_hex,
      seller_hex: q.sellerHex,
      payer_owner_hex: payer.owner,
      payer_wallet_type: payer.type,
      description: checked.description,
      replaces: held.map(h => h.id),
    }, nowSec());
    return {
      status: 200,
      body: {
        success: true,
        attempt_id: plan.attempt_id,
        sale_id: plan.sale_id,
        plan,
        lana: lanaText(checked.amount),
        fee_lana: lanaText(checked.fee),
        description: checked.description,
        replaces: held.map(h => h.id),
      },
    };
  };

  /**
   * The signed payment and its record for one attempt, the same for the till
   * and a payment link, once the caller is known to be entitled to it. Kept
   * (with the record) before anything is sent, checked once more, then sent to
   * both Electrum servers. The same bytes again answer with what happened to
   * them; other bytes for the same attempt are refused.
   */
  const submitAttempt = async (row: DirectRow, body: any): Promise<Answer> => {
    if (row.status !== 'quoted') {
      const same = typeof body.raw === 'string' && body.raw === row.raw_tx && body.record?.id === row.record_id;
      if (same) return { status: 200, body: { success: row.status !== 'refused', ...attemptView(row) } };
      return { status: 409, body: refusal('SALE_CONFLICT', { ...attemptView(row) }) };
    }
    if (nowSec() > row.expires_at) {
      move(db, row.id, ['quoted'], 'expired', nowSec(), { reason: 'QUOTE_EXPIRED' });
      // The whole attempt, as every other answer about it: the till shows it.
      return { status: 409, body: refusal('QUOTE_EXPIRED', attemptView(getAttempt(db, row.id)!)) };
    }
    const plan = planOf(row);
    let txid: string;
    let record: NostrEvent;
    try {
      checkPlan(plan);
      txid = verifySignedRaw(plan, body.raw);
      record = checkRecord(body.record, plan, txid);
    } catch (e) {
      return { status: 400, body: refusal(codeOf(e) === 'CHAIN_UNAVAILABLE' ? 'TX_INVALID' : codeOf(e)) };
    }
    const began = beginValidating(db, row, { txid, raw: body.raw, record, record_id: record.id }, nowSec());
    if (began.ok === false) {
      // NOT_QUOTED cannot happen between the read above and here (no await in
      // between, one process): it is the last guard, not a path.
      const why = began.why === 'NOT_QUOTED' ? 'SALE_CONFLICT' : began.why === 'TXID_CONFLICT' ? 'TX_ALREADY_KNOWN' : began.why;
      return { status: 409, body: refusal(why) };
    }

    let attempted = false;
    // Refused before anything was sent: what this attempt was to replace is
    // put back, since it may still be mined (lib/directLanaStore.ts).
    const refuseNow = (code: string) => {
      refuseBeforeSending(db, row.id, code, nowSec());
      return { code };
    };
    let outcome: { code?: string };
    try {
      outcome = await (async () => {
        const state = directUnitState(db, unitRow(db, row.unit_id));
        if (!state.ok) return refuseNow(state.code);
        if (state.unit.wallet !== plan.recipient || state.unit.owner_hex !== plan.recipient_hex) return refuseNow('WALLET_CHANGED');
        let payer: { owner: string; type: string };
        try {
          payer = checkPayer(await deps.registrar(plan.sender));
          const payee = await deps.registrar(plan.recipient);
          notePayee(db, row.unit_id, plan.recipient, payee, nowSec());
          checkPayee(payee, plan.recipient_hex);
        } catch (e) {
          return refuseNow(codeOf(e));
        }
        const excluded = exclusionAgainst(db, [plan.card_hex, payer.owner], row.unit_id);
        if (excluded) return refuseNow(excluded.status === 403 && (excluded.body as any)?.code === 'MERCHANT_UNAVAILABLE' ? 'MERCHANT_UNAVAILABLE' : 'PERSON_EXCLUDED');
        if (payer.owner === plan.recipient_hex) return refuseNow('SELF_PAYMENT');
        const p = params(plan.currency);
        if (!p?.rate) return refuseNow('RATE_UNAVAILABLE');
        if (p.rate !== plan.rate) return refuseNow('RATE_CHANGED');
        if (p.electrum.length < 2) return refuseNow('CHAIN_UNAVAILABLE');
        return await deps.withChain(p.electrum, plan.sender, async (c) => {
          if (spendingPending(c.snapshot)) return refuseNow('CHAIN_PENDING');
          for (const coin of plan.inputs) {
            const still = c.snapshot.utxos.some(u => u.txid === coin.txid && u.vout === coin.vout && u.value === coin.value && u.height > 0);
            if (!still || (await c.raw(coin.txid)) !== coin.raw) return refuseNow('WALLET_STATE_CHANGED');
          }
          if (!(await c.tipUnchanged())) return refuseNow('WALLET_STATE_CHANGED');
          if (!move(db, row.id, ['validating'], 'broadcasting', nowSec(), { sent: 1 })) return {};
          attempted = true;
          const answers = await c.broadcast(body.raw);
          const results = JSON.stringify(answers);
          if (answers.includes('accepted')) {
            move(db, row.id, ['broadcasting'], 'sent', nowSec(), { broadcast_results: results, reason: null });
            return {};
          }
          if (answers.length > 0 && answers.every(a => a === 'refused')) {
            const holds = await c.holds(txid, body.raw).catch(() => [] as boolean[]);
            if (holds.some(Boolean)) {
              move(db, row.id, ['broadcasting'], 'sent', nowSec(), { broadcast_results: results, reason: null });
            } else {
              move(db, row.id, ['broadcasting'], 'refused', nowSec(), { broadcast_results: results, reason: 'BROADCAST_REFUSED' });
            }
            return {};
          }
          move(db, row.id, ['broadcasting'], 'unknown', nowSec(), { broadcast_results: results, reason: 'NO_CLEAR_ANSWER' });
          return {};
        });
      })();
    } catch (e) {
      if (!attempted) outcome = refuseNow(codeOf(e));
      else {
        // A lost answer after the bytes were handed over is never a failure the
        // till may quietly replace: only the chain can tell.
        move(db, row.id, ['broadcasting'], 'unknown', nowSec(), { reason: 'NO_CLEAR_ANSWER' });
        outcome = {};
      }
    }
    const after = getAttempt(db, row.id)!;
    if (after.status === 'refused') {
      const code = outcome?.code || after.reason || 'BROADCAST_REFUSED';
      // A replacement refused before it left: the payment it was to replace
      // may still be mined, and the till says so (and shows it).
      const pending = after.sent === 1 ? undefined
        : replacesOf(after).map(id => getAttempt(db, id)).find(a => a && mayStillBeMined(a));
      return { status: statusFor(code), body: refusal(code, { ...attemptView(after), ...(pending ? { pending_attempt_id: pending.id } : {}) }) };
    }
    return { status: 200, body: { success: true, ...attemptView(after) } };
  };

  /**
   * The identical signed bytes of one attempt, again, the same for the till and
   * a payment link: only within RESEND_WINDOW_SECONDS of the card's signature,
   * never a new signature. A payment every server refused has in effect never
   * been sent, so a re-send is its first: it is held to every check of a
   * submit, made afresh, in the same order (the shop and the switch, its wallet
   * and owner, the register for the card and the shop's wallet, KIND 87058 for
   * the card and its owner as the register names them NOW, the card's owner not
   * the shop's, the same LANA price, nothing of the card's waiting for a block,
   * every coin still there). Any doubt refuses before the bytes go out; the
   * payer may then pay again with the same card, which spends one of the same
   * coins.
   */
  const resendAttempt = async (row: DirectRow): Promise<Answer> => {
    const resendable = row.raw_tx && row.txid && (row.status === 'sent' || row.status === 'unknown' || (row.status === 'refused' && row.sent === 1));
    if (!resendable) return { status: 409, body: refusal('RESEND_NOT_ALLOWED', attemptView(row)) };
    const plan = planOf(row);
    /** Refused before the bytes go out again; the attempt stays as the chain says. */
    const no = (code: string): Answer => ({ status: statusFor(code), body: refusal(code, attemptView(getAttempt(db, row.id)!)) });
    if (nowSec() - plan.created_at > RESEND_WINDOW_SECONDS) return no('RESEND_TOO_LATE');

    // The shop as it is now: an active unit of this app, exactly without a
    // company, the switch on, not pending/suspended/rejected, signed by its
    // owner, and still paying into the wallet and the owner this plan names.
    const state = directUnitState(db, unitRow(db, row.unit_id));
    if (!state.ok) return no(state.code);
    if (state.unit.wallet !== plan.recipient || state.unit.owner_hex !== plan.recipient_hex) return no('WALLET_CHANGED');
    let payer: { owner: string; type: string };
    try {
      payer = checkPayer(await deps.registrar(plan.sender));
      const payee = await deps.registrar(plan.recipient);
      notePayee(db, row.unit_id, plan.recipient, payee, nowSec());
      checkPayee(payee, plan.recipient_hex);
    } catch (e) {
      return no(codeOf(e));
    }
    // The card, its owner as the register names them now, and the one stored
    // at the quote (if the register moved the card, both are asked).
    const excluded = exclusionAgainst(db, [...new Set([row.card_hex, payer.owner, row.payer_owner_hex])], row.unit_id);
    if (excluded) return excluded;
    if (payer.owner === plan.recipient_hex || plan.card_hex === plan.recipient_hex || plan.sender === plan.recipient) return no('SELF_PAYMENT');
    const p = params(plan.currency);
    if (!p?.rate) return no('RATE_UNAVAILABLE');
    if (p.rate !== plan.rate) return no('RATE_CHANGED');
    if (p.electrum.length < 2) return no('CHAIN_UNAVAILABLE');
    // What this resend found: in a block, waiting for one, taken by a server
    // now, refused by every server again, or no clear answer. The attempt's
    // status says what the chain says; `resend` says what this tap did.
    let resend: 'in_block' | 'waiting' | 'accepted' | 'refused' | 'unknown';
    try {
      resend = await deps.withChain(p.electrum, row.payer_address, async (c) => {
        const seen = c.snapshot.history.find(h => h.txid === row.txid);
        if (seen && seen.height > 0) { markPaid(db, row, seen.height, nowSec()); return 'in_block' as const; }
        if (seen) { move(db, row.id, ['unknown', 'refused'], 'sent', nowSec(), { reason: null, fromSent: 1 }); return 'waiting' as const; }
        // As at a submit: nothing else of the card's waiting for a block, and
        // every coin this payment spends still a confirmed coin, unchanged.
        if (spendingPending(c.snapshot)) throw new DirectLanaError('CHAIN_PENDING');
        for (const coin of plan.inputs) {
          const still = c.snapshot.utxos.some(u => u.txid === coin.txid && u.vout === coin.vout && u.value === coin.value && u.height > 0);
          if (!still || (await c.raw(coin.txid)) !== coin.raw) throw new DirectLanaError('WALLET_STATE_CHANGED');
        }
        if (!(await c.tipUnchanged())) throw new DirectLanaError('WALLET_STATE_CHANGED');
        const answers = await c.broadcast(row.raw_tx!);
        const refusedByAll = answers.length > 0 && answers.every(a => a === 'refused');
        // Refused, yet a server holds exactly these bytes: it had them already.
        const held = refusedByAll && (await c.holds(row.txid!, row.raw_tx!).catch(() => [] as boolean[])).some(Boolean);
        if (answers.includes('accepted') || held) {
          move(db, row.id, ['unknown', 'refused'], 'sent', nowSec(), { reason: null, fromSent: 1, broadcast_results: JSON.stringify(answers) });
          return 'accepted' as const;
        }
        return refusedByAll ? 'refused' as const : 'unknown' as const;
      });
    } catch (e) {
      const code = codeOf(e);
      return { status: statusFor(code), body: refusal(code, attemptView(getAttempt(db, row.id)!)) };
    }
    return { status: 200, body: { success: true, ...attemptView(getAttempt(db, row.id)!), resend } };
  };

  /**
   * GET /api/direct-lana/price?unit_id=&amount=
   * The breakdown the till shows before the card is scanned, as exact strings:
   * 10.00 + 10 % = 11.00 EUR = 42.96875 LANA at 0.256. Nothing is reserved.
   */
  app.get('/api/direct-lana/price', gateNames(db, req => ({ hex: [req.headers?.['x-lana-hex']], unit: [req.query?.unit_id] })), (req: Request, res: Response) => {
    const row = unitRow(db, one(req.query.unit_id));
    if (!row) return res.status(404).json(refusal('UNKNOWN_UNIT'));
    const who = signedSeller(db, req, row, nowSec());
    if (!who.ok) return res.status(who.status).json(who.body);
    const state = directUnitState(db, row);
    if (!state.ok) return res.status(state.code === 'UNKNOWN_UNIT' ? 404 : 409).json(refusal(state.code));
    const u = state.unit;
    if (req.query.currency !== undefined && one(req.query.currency).toUpperCase() !== u.currency) {
      return res.status(400).json(refusal('CURRENCY_MISMATCH'));
    }
    const p = params(u.currency);
    if (!p?.rate) return res.status(503).json(refusal('RATE_UNAVAILABLE'));
    let cents: bigint;
    try {
      cents = parseCents(one(req.query.amount));
    } catch {
      return res.status(400).json(refusal('AMOUNT_INVALID'));
    }
    if (cents <= 0n) return res.status(400).json(refusal('AMOUNT_INVALID'));
    const pay = withMargin(cents, u.margin);
    const lanoshi = lanoshiForCents(pay, p.rate);
    if (lanoshi <= DUST_LANOSHI) return res.status(409).json(refusal('AMOUNT_TOO_SMALL'));
    if (lanoshi > BigInt(Number.MAX_SAFE_INTEGER)) return res.status(400).json(refusal('AMOUNT_INVALID'));
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      unit_id: u.unit_id,
      currency: u.currency,
      invoice_cents: cents.toString(),
      invoice: centsText(cents),
      margin_percent: u.margin,
      margin: centsText(pay - cents),
      pay_cents: pay.toString(),
      total: centsText(pay),
      lanoshi: lanoshi.toString(),
      lana: lanaText(lanoshi),
      rate: p.rate,
      rate_event_id: p.event_id,
      fx_at: p.fx_at,
      recipient: u.wallet,
      recipient_name: u.name,
    });
  });

  /**
   * POST /api/direct-lana/quote { unit_id, amount, currency?, public_key, invoice_number?, sale_id? }
   * The plan the customer's card will sign, after every check. `public_key` is
   * the card's (never its key): the card's address is derived from it here.
   * `sale_id` continues a sale (a second quote after a refusal, or a replacement).
   */
  app.post('/api/direct-lana/quote', directLimiter, gateNames(db, req => {
    const card = cardOfBody(req.body);
    return { hex: [req.headers?.['x-lana-hex'], card?.hex], wallet: [card?.address], unit: [req.body?.unit_id] };
  }), async (req: Request, res: Response) => {
    const body = req.body || {};
    const row = unitRow(db, body.unit_id);
    if (!row) return res.status(404).json(refusal('UNKNOWN_UNIT'));
    const who = signedSeller(db, req, row, nowSec());
    if (!who.ok) return res.status(who.status).json(who.body);
    const state = directUnitState(db, row);
    if (!state.ok) return res.status(409).json(refusal(state.code));
    const u: DirectUnit = state.unit;

    const card = cardOfBody(body);
    if (!card) return res.status(400).json(refusal('CARD_KEY_INVALID'));
    if (body.currency !== undefined && one(body.currency).toUpperCase() !== u.currency) return res.status(400).json(refusal('CURRENCY_MISMATCH'));
    const p = params(u.currency);
    if (!p?.rate) return res.status(503).json(refusal('RATE_UNAVAILABLE'));
    let cents: bigint;
    let invoiceNumber: string;
    try {
      cents = parseCents(body.amount);
      invoiceNumber = invoiceNumberOf(body.invoice_number);
    } catch (e) {
      return res.status(400).json(refusal(codeOf(e)));
    }
    if (cents <= 0n) return res.status(400).json(refusal('AMOUNT_INVALID'));
    // A payment link's sale keeps the link's margin when the till pays it again
    // (the customer came to the shop): the price the link promised.
    const linkOfSale = typeof body.sale_id === 'string'
      ? (db.prepare('SELECT margin_percent FROM direct_lana_links WHERE sale_id = ?').get(body.sale_id) as { margin_percent: number } | undefined)
      : undefined;
    const answer = await quoteSale({
      u, sellerHex: who.hex, card, publicKey: body.public_key, p, cents, invoiceNumber,
      margin: linkOfSale ? linkOfSale.margin_percent : u.margin,
      saleId: body.sale_id, saleMustExist: true,
    });
    if (answer.status === 200) res.set('Cache-Control', 'no-store');
    return res.status(answer.status).json(answer.body);
  });

  /**
   * POST /api/direct-lana/submit { attempt_id, raw, record }
   * The payment the card signed, and its record (submitAttempt).
   */
  app.post('/api/direct-lana/submit', directLimiter, gateNames(db, req => ({
    hex: [req.headers?.['x-lana-hex'], req.body?.record?.pubkey],
    unit: [unitOfAttempt(db, req.body?.attempt_id)],
  })), async (req: Request, res: Response) => {
    const body = req.body || {};
    const row = getAttempt(db, body.attempt_id);
    if (!row) return res.status(404).json(refusal('UNKNOWN_SALE'));
    const unit = unitRow(db, row.unit_id) || db.prepare('SELECT owner_hex, authorized_hex FROM business_units WHERE unit_id = ?').get(row.unit_id) || {};
    const who = signedSeller(db, req, unit, nowSec());
    if (!who.ok) return res.status(who.status).json(who.body);
    const answer = await submitAttempt(row, body);
    return res.status(answer.status).json(answer.body);
  });

  /** GET /api/direct-lana/sales?unit_id= : the shop's direct sales, newest first. */
  app.get('/api/direct-lana/sales', gateNames(db, req => ({ hex: [req.headers?.['x-lana-hex']], unit: [req.query?.unit_id] })), (req: Request, res: Response) => {
    const row = unitRow(db, one(req.query.unit_id)) || db.prepare('SELECT unit_id, owner_hex, authorized_hex FROM business_units WHERE unit_id = ?').get(one(req.query.unit_id));
    if (!row) return res.status(404).json(refusal('UNKNOWN_UNIT'));
    const who = signedSeller(db, req, row, nowSec());
    if (!who.ok) return res.status(who.status).json(who.body);
    const rows = db.prepare(`SELECT * FROM direct_lana_sales WHERE unit_id = ? AND status <> 'quoted' AND NOT (status = 'expired') ORDER BY created_at DESC, id DESC LIMIT 50`).all(row.unit_id) as DirectRow[];
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, sales: rows.map(attemptView) });
  });

  /** GET /api/direct-lana/sales/:id : one attempt, for the till to poll. */
  app.get('/api/direct-lana/sales/:id', gateNames(db, req => ({ hex: [req.headers?.['x-lana-hex']], unit: [unitOfAttempt(db, req.params?.id)] })), (req: Request, res: Response) => {
    let row = getAttempt(db, req.params.id);
    if (!row) return res.status(404).json(refusal('UNKNOWN_SALE'));
    const unit = db.prepare('SELECT owner_hex, authorized_hex FROM business_units WHERE unit_id = ?').get(row.unit_id) || {};
    const who = signedSeller(db, req, unit, nowSec());
    if (!who.ok) return res.status(who.status).json(who.body);
    // A quote past its time can never be sent any more (the submit refuses it):
    // made final now rather than at the next sweep, so a till whose submit
    // never arrived learns for certain that nothing was sent.
    if (row.status === 'quoted' && nowSec() > row.expires_at) {
      move(db, row.id, ['quoted'], 'expired', nowSec(), { reason: 'QUOTE_EXPIRED' });
      row = getAttempt(db, row.id)!;
    }
    settleSoon(row);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...attemptView(row) });
  });

  /**
   * POST /api/direct-lana/sales/:id/resend { attempt_id }
   * The identical signed bytes, again (resendAttempt): only when the seller
   * asks for it with the customer present, never by itself.
   */
  app.post('/api/direct-lana/sales/:id/resend', directLimiter, gateNames(db, req => ({ hex: [req.headers?.['x-lana-hex']], unit: [unitOfAttempt(db, req.params?.id)] })), async (req: Request, res: Response) => {
    const row = getAttempt(db, req.params.id);
    if (!row) return res.status(404).json(refusal('UNKNOWN_SALE'));
    const unit = db.prepare('SELECT owner_hex, authorized_hex FROM business_units WHERE unit_id = ?').get(row.unit_id) || {};
    const who = signedSeller(db, req, unit, nowSec());
    if (!who.ok) return res.status(who.status).json(who.body);
    const answer = await resendAttempt(row);
    return res.status(answer.status).json(answer.body);
  });

  // ── Payment links: the seller's side (signed, owner or staff) ─────────────

  /** The shop's row for a seller's link route: an active unit of this app, or the bare row (owner and staff). */
  const sellerUnitRow = (unitId: unknown) =>
    unitRow(db, unitId) || (typeof unitId === 'string' && unitId
      ? db.prepare('SELECT unit_id, owner_hex, authorized_hex FROM business_units WHERE unit_id = ?').get(unitId)
      : undefined);

  const linkView = (link: LinkRow) => sellerLinkView(link, linkPayment(db, link), attemptView);

  /**
   * POST /api/direct-lana/links { unit_id, amount, currency?, invoice_number?, note? }
   * A payment link for one sale: the invoice amount, the shop's margin as it is
   * now, the invoice number and a note the customer sees. Only where the till
   * itself could take LANA neposredno now (the shop, the switch, a price).
   */
  app.post('/api/direct-lana/links', directLimiter, gateNames(db, req => ({ hex: [req.headers?.['x-lana-hex']], unit: [req.body?.unit_id] })), (req: Request, res: Response) => {
    const body = req.body || {};
    const row = unitRow(db, body.unit_id);
    if (!row) return res.status(404).json(refusal('UNKNOWN_UNIT'));
    const who = signedSeller(db, req, row, nowSec());
    if (!who.ok) return res.status(who.status).json(who.body);
    const state = directUnitState(db, row);
    if (!state.ok) return res.status(409).json(refusal(state.code));
    const u: DirectUnit = state.unit;
    if (body.currency !== undefined && one(body.currency).toUpperCase() !== u.currency) return res.status(400).json(refusal('CURRENCY_MISMATCH'));
    const p = params(u.currency);
    if (!p?.rate) return res.status(503).json(refusal('RATE_UNAVAILABLE'));
    let cents: bigint;
    let invoiceNumber: string;
    try {
      cents = parseCents(body.amount);
      invoiceNumber = invoiceNumberOf(body.invoice_number);
    } catch (e) {
      return res.status(400).json(refusal(codeOf(e)));
    }
    if (cents <= 0n) return res.status(400).json(refusal('AMOUNT_INVALID'));
    const pay = withMargin(cents, u.margin);
    const lanoshi = lanoshiForCents(pay, p.rate);
    if (lanoshi <= DUST_LANOSHI) return res.status(409).json(refusal('AMOUNT_TOO_SMALL'));
    if (lanoshi > BigInt(Number.MAX_SAFE_INTEGER)) return res.status(400).json(refusal('AMOUNT_INVALID'));
    const saleId = newId('dls');
    // An invoice number paid here already, or carried by a payment that may
    // still be paid, or by another open link of this shop: not a second time.
    if (invoiceNumber && invoiceNumberTaken(db, u.unit_id, invoiceNumber, saleId)) return res.status(409).json(refusal('INVOICE_USED'));
    if (invoiceNumber && db.prepare("SELECT 1 FROM direct_lana_links WHERE unit_id = ? AND invoice_number = ? AND status = 'open' LIMIT 1").get(u.unit_id, invoiceNumber)) {
      return res.status(409).json(refusal('INVOICE_HAS_LINK'));
    }
    const now = nowSec();
    const hours = linkExpiryHours(db);
    const id = newLinkId();
    db.prepare(`
      INSERT INTO direct_lana_links (id, token, sale_id, unit_id, seller_hex, owner_hex, unit_name, currency,
        invoice_cents, margin_percent, invoice_number, note, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(id, newLinkToken(), saleId, u.unit_id, who.hex, u.owner_hex, u.name, u.currency,
      cents.toString(), u.margin, invoiceNumber, cleanRequestNote(body.note), now, hours ? now + hours * 3600 : null);
    console.log(`[direct-lana] payment link made: unit ${u.unit_id.slice(0, 12)} ${centsText(pay)} ${u.currency}`);
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ success: true, link: linkView(linkById(db, id)!) });
  });

  /** GET /api/direct-lana/links?unit_id= : the shop's payment links, newest first, as the chain says they are. */
  app.get('/api/direct-lana/links', gateNames(db, req => ({ hex: [req.headers?.['x-lana-hex']], unit: [req.query?.unit_id] })), (req: Request, res: Response) => {
    const row = sellerUnitRow(one(req.query.unit_id));
    if (!row) return res.status(404).json(refusal('UNKNOWN_UNIT'));
    const who = signedSeller(db, req, row, nowSec());
    if (!who.ok) return res.status(who.status).json(who.body);
    const now = nowSec();
    const links = (db.prepare('SELECT * FROM direct_lana_links WHERE unit_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(row.unit_id) as LinkRow[])
      .map(l => syncLink(db, l, now));
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, links: links.map(linkView) });
  });

  /**
   * POST /api/direct-lana/links/:id/cancel { link_id }
   * Close an open link. Not while a payment of it may still be mined: that
   * payment may still arrive, and cancelling would hide it. A quote nobody
   * signed yet can no longer be sent.
   */
  app.post('/api/direct-lana/links/:id/cancel', directLimiter, gateNames(db, req => ({ hex: [req.headers?.['x-lana-hex']], unit: [linkById(db, req.params?.id)?.unit_id] })), (req: Request, res: Response) => {
    let link = linkById(db, req.params.id);
    if (!link) return res.status(404).json(refusal('LINK_NOT_FOUND'));
    const who = signedSeller(db, req, sellerUnitRow(link.unit_id) || {}, nowSec());
    if (!who.ok) return res.status(who.status).json(who.body);
    const now = nowSec();
    link = syncLink(db, link, now);
    const why = db.transaction((): string | null => {
      const fresh = linkById(db, link!.id)!;
      if (fresh.status === 'paid') return 'LINK_PAID';
      if (fresh.status !== 'open') return null;
      const attempts = attemptsOfSale(db, fresh.sale_id);
      if (attempts.some(a => a.status === 'paid')) return 'LINK_PAID';
      if (saleInFlight(attempts)) return 'SALE_PAYMENT_PENDING';
      db.prepare(`UPDATE direct_lana_sales SET status = 'expired', reason = 'LINK_CANCELLED', status_at = ?, updated_at = datetime('now')
        WHERE sale_id = ? AND status = 'quoted'`).run(now, fresh.sale_id);
      db.prepare(`UPDATE direct_lana_links SET status = 'cancelled', cancelled_at = ?, updated_at = datetime('now') WHERE id = ? AND status = 'open'`).run(now, fresh.id);
      return null;
    })();
    const view = linkView(syncLink(db, linkById(db, link.id)!, now));
    res.set('Cache-Control', 'no-store');
    if (why) return res.status(409).json(refusal(why, { link: view }));
    return res.json({ success: true, link: view });
  });

  /**
   * GET /api/direct-lana/links/unseen : paid links the seller has not seen
   * yet, across every shop the signer is owner or staff of, for the home
   * screen's notice. The signature is the only word on who is asking.
   */
  app.get('/api/direct-lana/links/unseen', gateNames(db, req => ({ hex: [req.headers?.['x-lana-hex']] })), (req: Request, res: Response) => {
    const signed = verifyRequestSignature(req, {});
    if (!signed.ok) {
      const { reason } = signed as { ok: false; reason: string };
      return res.status(401).json(refusal('SIGNATURE_REQUIRED', { reason, server_time: nowSec() }));
    }
    const decision = excludedNow(db, signed.hex);
    if (decision) return res.status(403).json(exclusionRefusal(decision));
    const units = unitIdsForMerchant(db, signed.hex);
    res.set('Cache-Control', 'no-store');
    if (!units.length) return res.json({ success: true, count: 0, latest: [] });
    syncAllLinks(db, nowSec());
    const ph = units.map(() => '?').join(',');
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM direct_lana_links WHERE unit_id IN (${ph}) AND status = 'paid' AND seen_by_seller = 0`).get(...units) as any).c;
    const latest = (db.prepare(`
      SELECT * FROM direct_lana_links WHERE unit_id IN (${ph}) AND status = 'paid' AND seen_by_seller = 0
      ORDER BY paid_at DESC, rowid DESC LIMIT 3
    `).all(...units) as LinkRow[]).map(l => ({
      id: l.id, unit_id: l.unit_id, unit_name: l.unit_name, currency: l.currency, ...linkAmounts(l), paid_at: l.paid_at,
    }));
    return res.json({ success: true, count, latest });
  });

  /** POST /api/direct-lana/links/seen { unit_id } : the seller opened the shop's links. */
  app.post('/api/direct-lana/links/seen', gateNames(db, req => ({ hex: [req.headers?.['x-lana-hex']], unit: [req.body?.unit_id] })), (req: Request, res: Response) => {
    const row = sellerUnitRow(req.body?.unit_id);
    if (!row) return res.status(404).json(refusal('UNKNOWN_UNIT'));
    const who = signedSeller(db, req, row, nowSec());
    if (!who.ok) return res.status(who.status).json(who.body);
    const updated = db.prepare(`UPDATE direct_lana_links SET seen_by_seller = 1, updated_at = datetime('now') WHERE unit_id = ? AND status = 'paid' AND seen_by_seller = 0`).run(row.unit_id).changes;
    return res.json({ success: true, updated });
  });

  // ── Payment links: the customer's side (no signature; the token is the capability) ──

  /**
   * Who sells on a link, asked again at every step: the seller who made it is
   * still the shop's owner or staff, and no KIND 87058 decision is against
   * them. The person reading the answer is the CUSTOMER, who is the subject of
   * nothing here: a seller's decision is said as "this shop cannot take
   * payments" (merchantRefusal), with no ground and no name.
   */
  const linkSellerRefusal = (link: LinkRow, row: any): Answer | null => {
    if (!row || !isOwnerOrStaff(row, link.seller_hex)) return { status: 409, body: refusal('LINK_CLOSED') };
    if (excludedNow(db, link.seller_hex)) return { status: 403, body: merchantRefusal() };
    return null;
  };

  /**
   * GET /api/direct-pay/:token
   * The customer's page: the shop, the invoice, the margin, the total, LANA at
   * the price of now (said as approximate: the exact LANA come with the quote),
   * the seller's note, and the payment of this link, if one is on its way or
   * made. 'closed': the link is open, but the shop cannot take it now (why is
   * not said: the customer can do nothing about it).
   */
  app.get('/api/direct-pay/:token', linkViewLimiter, (req: Request, res: Response) => {
    let link = linkByToken(db, req.params.token);
    if (!link) return res.status(404).json(refusal('LINK_NOT_FOUND'));
    link = syncLink(db, link, nowSec());
    const payment = linkPayment(db, link);
    if (payment) settleSoon(payment);
    let status: string = linkStatusOf(link, payment);
    let unit: DirectUnit | null = null;
    let price: { rate: string; rate_event_id: string; lanoshi: string; lana: string } | null = null;
    const money = linkAmounts(link);
    if (status === 'open' || status === 'paying') {
      const row = unitRow(db, link.unit_id);
      const state = row ? directUnitState(db, row) : { ok: false };
      const sellerOk = !linkSellerRefusal(link, row) && !excludedMerchant(db, [link.unit_id]);
      if (state.ok && sellerOk && state.unit!.currency === link.currency) {
        unit = state.unit!;
        const p = params(unit.currency);
        if (p?.rate) {
          const lanoshi = lanoshiForCents(BigInt(money.pay_cents), p.rate);
          price = { rate: p.rate, rate_event_id: p.event_id, lanoshi: lanoshi.toString(), lana: lanaText(lanoshi) };
        }
      }
      if (status === 'open' && (!unit || !price)) status = 'closed';
    }
    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      link: {
        status,
        unit_id: link.unit_id,
        unit_name: unit?.name || link.unit_name,
        currency: link.currency,
        ...money,
        invoice_number: link.invoice_number,
        note: link.note,
        sale_id: link.sale_id,
        recipient: unit?.wallet ?? null,
        recipient_hex: unit?.owner_hex ?? null,
        price,
        created_at: link.created_at,
        expires_at: link.expires_at,
        paid_at: link.paid_at,
        payment: payment ? publicAttemptView(payment) : null,
      },
    });
  });

  /**
   * POST /api/direct-pay/:token/quote { public_key }
   * The plan the customer's card will sign: the till's quote (quoteSale), for
   * the link's sale, with the link's invoice, invoice number and margin, never
   * the client's. A link that is paid, cancelled or expired takes no quote; one
   * whose payment hangs takes a quote that replaces it (same card, same coins).
   */
  app.post('/api/direct-pay/:token/quote', linkActionLimiter, gateNames(db, req => {
    const card = cardOfBody(req.body);
    return { hex: [card?.hex], wallet: [card?.address], unit: [linkByToken(db, req.params?.token)?.unit_id] };
  }), async (req: Request, res: Response) => {
    const body = req.body || {};
    let link = linkByToken(db, req.params.token);
    if (!link) return res.status(404).json(refusal('LINK_NOT_FOUND'));
    link = syncLink(db, link, nowSec());
    if (link.status === 'paid') return res.status(409).json(refusal('LINK_PAID'));
    if (link.status === 'cancelled') return res.status(409).json(refusal('LINK_CANCELLED'));
    if (link.status === 'expired') return res.status(409).json(refusal('LINK_EXPIRED'));
    // Past its time, still open only because a payment of it may still be
    // mined: only a quote that can replace that payment.
    if (link.expires_at !== null && link.expires_at < nowSec() && !saleInFlight(attemptsOfSale(db, link.sale_id))) {
      return res.status(409).json(refusal('LINK_EXPIRED'));
    }
    const row = unitRow(db, link.unit_id);
    const seller = linkSellerRefusal(link, row);
    if (seller) return res.status(seller.status).json(seller.body);
    const state = directUnitState(db, row);
    if (!state.ok) return res.status(409).json(refusal(state.code));
    const u: DirectUnit = state.unit;
    if (u.currency !== link.currency) return res.status(409).json(refusal('CURRENCY_MISMATCH'));
    const card = cardOfBody(body);
    if (!card) return res.status(400).json(refusal('CARD_KEY_INVALID'));
    const p = params(u.currency);
    if (!p?.rate) return res.status(503).json(refusal('RATE_UNAVAILABLE'));
    const answer = await quoteSale({
      u, sellerHex: link.seller_hex, card, publicKey: body.public_key, p,
      cents: BigInt(link.invoice_cents), invoiceNumber: link.invoice_number, margin: link.margin_percent,
      saleId: link.sale_id, saleMustExist: false,
    });
    res.set('Cache-Control', 'no-store');
    return res.status(answer.status).json(forCustomer(answer.body));
  });

  /** An attempt of this link's sale, or nothing. */
  const attemptOfLink = (link: LinkRow, id: unknown): DirectRow | undefined => {
    const row = getAttempt(db, id);
    return row && row.sale_id === link.sale_id ? row : undefined;
  };

  /**
   * POST /api/direct-pay/:token/submit { attempt_id, raw, record }
   * The payment the customer's card signed (submitAttempt). Before anything of
   * it is kept, the link and its seller are asked once more.
   */
  app.post('/api/direct-pay/:token/submit', linkActionLimiter, gateNames(db, req => ({
    hex: [req.body?.record?.pubkey],
    unit: [linkByToken(db, req.params?.token)?.unit_id],
  })), async (req: Request, res: Response) => {
    const body = req.body || {};
    const link = linkByToken(db, req.params.token);
    if (!link) return res.status(404).json(refusal('LINK_NOT_FOUND'));
    const row = attemptOfLink(link, body.attempt_id);
    if (!row) return res.status(404).json(refusal('UNKNOWN_SALE'));
    res.set('Cache-Control', 'no-store');
    if (row.status === 'quoted') {
      if (link.status === 'cancelled') {
        move(db, row.id, ['quoted'], 'expired', nowSec(), { reason: 'LINK_CANCELLED' });
        return res.status(409).json(refusal('LINK_CANCELLED'));
      }
      const seller = linkSellerRefusal(link, unitRow(db, link.unit_id));
      if (seller) return res.status(seller.status).json(seller.body);
    }
    const answer = await submitAttempt(row, body);
    return res.status(answer.status).json(forCustomer(answer.body));
  });

  /**
   * POST /api/direct-pay/:token/resend { attempt_id }
   * The identical signed bytes of this link's payment, again (resendAttempt),
   * when the customer asks: within 30 minutes of their signature.
   */
  app.post('/api/direct-pay/:token/resend', linkActionLimiter, gateNames(db, req => ({ unit: [linkByToken(db, req.params?.token)?.unit_id] })), async (req: Request, res: Response) => {
    const link = linkByToken(db, req.params.token);
    if (!link) return res.status(404).json(refusal('LINK_NOT_FOUND'));
    const row = attemptOfLink(link, req.body?.attempt_id);
    if (!row) return res.status(404).json(refusal('UNKNOWN_SALE'));
    const seller = linkSellerRefusal(link, unitRow(db, link.unit_id));
    res.set('Cache-Control', 'no-store');
    if (seller) return res.status(seller.status).json(seller.body);
    const answer = await resendAttempt(row);
    return res.status(answer.status).json(forCustomer(answer.body));
  });

  return deps;
}
