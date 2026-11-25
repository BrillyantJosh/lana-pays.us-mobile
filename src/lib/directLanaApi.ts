/**
 * The till's calls to LANA neposredno (server/directLana.ts). Every call is
 * signed with the seller's session key (NIP-98, lib/signedRequest.ts), bound to
 * the exact body of a POST; the server refuses an unsigned one. A token the
 * server calls stale (a phone with a wrong clock) or already used is signed
 * afresh once, as the brain sale does (lib/purchaseRequest.ts): a 401 means
 * the server did nothing with the request.
 */
import { signedAuthHeaders } from './signedRequest';
import { withCallerHex } from './callerIdentity';

export interface DirectSession {
  privateKeyHex?: string | null;
}

export interface DirectAnswer {
  status: number;
  data: any;
}

async function call(session: DirectSession | null | undefined, method: 'GET' | 'POST', url: string, body?: unknown): Promise<DirectAnswer> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const send = (nowSec?: number) => fetch(url, {
    method,
    headers: withCallerHex({
      ...(text !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...signedAuthHeaders(session?.privateKeyHex, method, url, { body: text, nowSec }),
    }),
    body: text,
  });
  let res = await send();
  if (res.status === 401) {
    const refusal = await res.clone().json().catch(() => null);
    if (refusal?.reason === 'STALE' && Number.isInteger(refusal?.server_time)) res = await send(refusal.server_time);
    else if (refusal?.reason === 'REPLAYED') res = await send();
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

const q = encodeURIComponent;

export const fetchDirectPrice = (s: DirectSession | null | undefined, unitId: string, amount: string) =>
  call(s, 'GET', `/api/direct-lana/price?unit_id=${q(unitId)}&amount=${q(amount)}`);

export const requestDirectQuote = (s: DirectSession | null | undefined, body: {
  unit_id: string; amount: string; currency: string; public_key: string; invoice_number?: string; sale_id?: string;
}) => call(s, 'POST', '/api/direct-lana/quote', body);

export const submitDirectSale = (s: DirectSession | null | undefined, body: { attempt_id: string; raw: string; record: unknown }) =>
  call(s, 'POST', '/api/direct-lana/submit', body);

export const fetchDirectSale = (s: DirectSession | null | undefined, attemptId: string) =>
  call(s, 'GET', `/api/direct-lana/sales/${q(attemptId)}`);

export const fetchDirectSales = (s: DirectSession | null | undefined, unitId: string) =>
  call(s, 'GET', `/api/direct-lana/sales?unit_id=${q(unitId)}`);

export const resendDirectSale = (s: DirectSession | null | undefined, attemptId: string) =>
  call(s, 'POST', `/api/direct-lana/sales/${q(attemptId)}/resend`, { attempt_id: attemptId });

/** Statuses after which a payment may still change: the till keeps asking. */
export const OPEN_STATUSES = ['validating', 'broadcasting', 'sent', 'unknown'];

/** Reasons said in their own words (directLana.reason.<code>); every other code has a group. */
const OWN_REASONS = [
  'PAYEE_FROZEN', 'MARGIN_INVALID', 'RATE_UNAVAILABLE', 'RATE_CHANGED', 'AMOUNT_INVALID', 'AMOUNT_TOO_SMALL',
  'INVOICE_NUMBER_INVALID', 'INVOICE_USED', 'REGISTRAR_UNAVAILABLE', 'PAYER_NOT_REGISTERED', 'PAYER_FROZEN',
  'PAYER_TYPE_NOT_ALLOWED', 'PAYER_OWNER_UNKNOWN', 'SELF_PAYMENT', 'CHAIN_UNAVAILABLE', 'CHAIN_PENDING',
  'CARD_PAYMENT_PENDING', 'SALE_PAYMENT_PENDING', 'SALE_ALREADY_PAID', 'INSUFFICIENT_FUNDS', 'INPUT_LIMIT',
  'WALLET_STATE_CHANGED', 'QUOTE_EXPIRED', 'DEVICE_CLOCK', 'BROADCAST_REFUSED', 'NETWORK',
  // The owner saved another (valid) wallet meanwhile: nothing to fix, only to try again.
  'WALLET_CHANGED',
  // A re-send long after the card signed: pay again with the same card instead.
  'RESEND_TOO_LATE',
  // The till's own: its submit never got an answer, and the server says the quote ran out unused.
  'NOT_RECEIVED',
  // Payment links: a paid link cannot be cancelled; an invoice number already on an open link.
  'LINK_PAID', 'INVOICE_HAS_LINK',
];
const GROUPS: Record<string, string> = {
  UNKNOWN_UNIT: 'UNIT', UNIT_NOT_DIRECT: 'UNIT', DIRECT_LANA_OFF: 'UNIT', UNIT_BLOCKED: 'UNIT',
  UNIT_AUTHOR_MISMATCH: 'UNIT', CURRENCY_UNSUPPORTED: 'UNIT', CURRENCY_MISMATCH: 'UNIT',
  WALLET_INVALID: 'WALLET', PAYEE_NOT_REGISTERED: 'WALLET',
  PAYEE_TYPE_NOT_ALLOWED: 'WALLET', PAYEE_OWNER_MISMATCH: 'WALLET',
  PLAN_INVALID: 'PLAN', PLAN_AMOUNTS_CHANGED: 'PLAN', PLAN_INPUT_MISMATCH: 'PLAN', PLAN_RECIPIENT_CHANGED: 'PLAN',
  CARD_MISMATCH: 'PLAN', TX_INVALID: 'PLAN', RECORD_INVALID: 'PLAN', SALE_CONFLICT: 'PLAN', SALE_MISMATCH: 'PLAN',
  TX_TOO_LARGE: 'PLAN', SIGNATURE_FAILED: 'PLAN', UNKNOWN_SALE: 'PLAN', RESEND_NOT_ALLOWED: 'PLAN', TX_ALREADY_KNOWN: 'PLAN',
  LINK_NOT_FOUND: 'PLAN', LINK_CANCELLED: 'PLAN', LINK_EXPIRED: 'PLAN', LINK_CLOSED: 'UNIT',
};
/** Codes this app already has words for elsewhere. */
const SHARED: Record<string, string> = {
  SIGNATURE_REQUIRED: 'purchase.sellerNotConfirmed',
  SELLER_CHECK_FAILED: 'purchase.sellerNotConfirmed',
  NOT_ENTITLED: 'purchase.sellerNotEntitled',
  PERSON_EXCLUDED: 'purchase.personExcluded',
  MERCHANT_UNAVAILABLE: 'purchase.merchantUnavailable',
  CARD_ADDRESS_NOT_KEY: 'lana.walletAddressNotWif',
  CARD_NOSTR_KEY: 'lana.nostrKeyNotWif',
  CARD_KEY_INVALID: 'lana.invalidWifKey',
  // The till's own, about a payment that may still be mined: whole sentences,
  // never after "LANA were not sent".
  RESEND_REFUSED_BY_NETWORK: 'directLana.resendRefusedByNetwork',
  PREVIOUS_PAYMENT_PENDING: 'directLana.previousStillChecked',
};

/**
 * The i18n key of a refusal's reason. SHARED keys are whole sentences; every
 * directLana.reason.* key is the part after "LANA were not sent: ".
 */
export function directReasonKey(code: unknown): { key: string; sentence: boolean } {
  const c = typeof code === 'string' ? code : '';
  if (SHARED[c]) return { key: SHARED[c], sentence: true };
  if (OWN_REASONS.includes(c)) return { key: `directLana.reason.${c}`, sentence: false };
  if (GROUPS[c]) return { key: `directLana.reason.${GROUPS[c]}`, sentence: false };
  return { key: 'directLana.reason.GENERIC', sentence: false };
}

/** The code of an answer (this server puts it in `code`; a KIND 87058 refusal does too). */
export const answerCode = (data: any): string => (typeof data?.code === 'string' ? data.code : '');

// ── Payment links (server/directLana.ts, lib/directLanaLinks.ts) ────────────
// The seller's calls are signed like every other call above. The customer's
// page signs nothing: the link's token is its capability.

export const createDirectLink = (s: DirectSession | null | undefined, body: {
  unit_id: string; amount: string; currency: string; invoice_number?: string; note?: string;
}) => call(s, 'POST', '/api/direct-lana/links', body);

export const fetchDirectLinks = (s: DirectSession | null | undefined, unitId: string) =>
  call(s, 'GET', `/api/direct-lana/links?unit_id=${q(unitId)}`);

export const cancelDirectLink = (s: DirectSession | null | undefined, linkId: string) =>
  call(s, 'POST', `/api/direct-lana/links/${q(linkId)}/cancel`, { link_id: linkId });

export const fetchDirectLinksUnseen = (s: DirectSession | null | undefined) =>
  call(s, 'GET', '/api/direct-lana/links/unseen');

export const markDirectLinksSeen = (s: DirectSession | null | undefined, unitId: string) =>
  call(s, 'POST', '/api/direct-lana/links/seen', { unit_id: unitId });

/** The public address of a link's page, for the seller to send. */
export const directLinkUrl = (link: { path?: string; token?: string }) =>
  `${typeof window !== 'undefined' ? window.location.origin : ''}${link.path || `/pay-direct/${link.token}`}`;

async function publicCall(method: 'GET' | 'POST', url: string, body?: unknown): Promise<DirectAnswer> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, {
    method,
    headers: text !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: text,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

/** The link's page; with `attemptId`, also that payment of it as it is now (`link.asked`). */
export const fetchPayLink = (token: string, attemptId?: string) =>
  publicCall('GET', `/api/direct-pay/${q(token)}${attemptId ? `?attempt=${q(attemptId)}` : ''}`);

export const quotePayLink = (token: string, publicKey: string) =>
  publicCall('POST', `/api/direct-pay/${q(token)}/quote`, { public_key: publicKey });

export const submitPayLink = (token: string, body: { attempt_id: string; raw: string; record: unknown }) =>
  publicCall('POST', `/api/direct-pay/${q(token)}/submit`, body);

export const resendPayLink = (token: string, attemptId: string) =>
  publicCall('POST', `/api/direct-pay/${q(token)}/resend`, { attempt_id: attemptId });

/**
 * The customer's words for a refusal on a link's page (directPay.reason.*,
 * said to the person who pays: "your card"), or a whole sentence this app
 * already has. Each directPay.reason.* key is the part after "The payment was
 * not made: ".
 */
const PAY_OWN_REASONS = [
  'RATE_UNAVAILABLE', 'RATE_CHANGED', 'AMOUNT_TOO_SMALL', 'INVOICE_USED', 'REGISTRAR_UNAVAILABLE',
  'PAYER_NOT_REGISTERED', 'PAYER_FROZEN', 'PAYER_OWNER_UNKNOWN', 'PAYER_TYPE_NOT_ALLOWED', 'SELF_PAYMENT',
  'CHAIN_UNAVAILABLE', 'CHAIN_PENDING', 'CARD_PAYMENT_PENDING', 'SALE_PAYMENT_PENDING', 'SALE_ALREADY_PAID',
  'INSUFFICIENT_FUNDS', 'INPUT_LIMIT', 'WALLET_STATE_CHANGED', 'WALLET_CHANGED', 'QUOTE_EXPIRED', 'DEVICE_CLOCK',
  'BROADCAST_REFUSED', 'NETWORK', 'NOT_RECEIVED', 'RESEND_TOO_LATE', 'TOO_MANY_TRIES',
];
const PAY_GROUPS: Record<string, string> = {
  UNKNOWN_UNIT: 'UNIT', UNIT_NOT_DIRECT: 'UNIT', DIRECT_LANA_OFF: 'UNIT', UNIT_BLOCKED: 'UNIT', UNIT_AUTHOR_MISMATCH: 'UNIT',
  CURRENCY_UNSUPPORTED: 'UNIT', CURRENCY_MISMATCH: 'UNIT', MARGIN_INVALID: 'UNIT', WALLET_INVALID: 'UNIT',
  PAYEE_NOT_REGISTERED: 'UNIT', PAYEE_FROZEN: 'UNIT', PAYEE_TYPE_NOT_ALLOWED: 'UNIT', PAYEE_OWNER_MISMATCH: 'UNIT',
  LINK_CLOSED: 'UNIT', AMOUNT_INVALID: 'UNIT', INVOICE_NUMBER_INVALID: 'UNIT',
  PLAN_INVALID: 'PLAN', PLAN_AMOUNTS_CHANGED: 'PLAN', PLAN_INPUT_MISMATCH: 'PLAN', PLAN_RECIPIENT_CHANGED: 'PLAN',
  CARD_MISMATCH: 'PLAN', TX_INVALID: 'PLAN', RECORD_INVALID: 'PLAN', SALE_CONFLICT: 'PLAN', SALE_MISMATCH: 'PLAN',
  TX_TOO_LARGE: 'PLAN', SIGNATURE_FAILED: 'PLAN', UNKNOWN_SALE: 'PLAN', RESEND_NOT_ALLOWED: 'PLAN', TX_ALREADY_KNOWN: 'PLAN',
  LINK_PAID: 'SALE_ALREADY_PAID',
};
const PAY_SHARED: Record<string, string> = {
  PERSON_EXCLUDED: 'purchase.personExcluded',
  MERCHANT_UNAVAILABLE: 'purchase.merchantUnavailable',
  CARD_ADDRESS_NOT_KEY: 'directPay.addressNotKey',
  CARD_NOSTR_KEY: 'lana.nostrKeyNotWif',
  CARD_KEY_INVALID: 'lana.invalidWifKey',
  LINK_CANCELLED: 'directPay.cancelledInfo',
  LINK_EXPIRED: 'directPay.expiredInfo',
  LINK_NOT_FOUND: 'directPay.notFound',
  RESEND_REFUSED_BY_NETWORK: 'directPay.resendRefusedByNetwork',
  PREVIOUS_PAYMENT_PENDING: 'directPay.previousStillChecked',
};

export function directPayReasonKey(code: unknown): { key: string; sentence: boolean } {
  const c = typeof code === 'string' ? code : '';
  if (PAY_SHARED[c]) return { key: PAY_SHARED[c], sentence: true };
  if (PAY_OWN_REASONS.includes(c)) return { key: `directPay.reason.${c}`, sentence: false };
  if (PAY_GROUPS[c]) return { key: `directPay.reason.${PAY_GROUPS[c]}`, sentence: false };
  return { key: 'directPay.reason.GENERIC', sentence: false };
}

/** The reasons the customer's page can show: every key it may ask for (the key-coverage test reads it). */
export const DIRECT_PAY_REASON_KEYS = [
  ...PAY_OWN_REASONS.map(c => `directPay.reason.${c}`),
  ...[...new Set(Object.values(PAY_GROUPS))].filter(g => !PAY_OWN_REASONS.includes(g)).map(g => `directPay.reason.${g}`),
  'directPay.reason.GENERIC',
  ...Object.values(PAY_SHARED),
];
