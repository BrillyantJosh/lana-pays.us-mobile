/**
 * "Still waiting for a block" — when a client-signed LANA payment cannot go out
 * YET, as opposed to a payment that genuinely failed.
 *
 * Production, 19 Oct 2026 (simple.lanapays.us /pay, invoice »ziva center
 * 243640«): the buyer's wallet had sent another payment at 08:44:41 that was
 * still waiting for a block. Between 08:49 and 08:54 the page signed the new
 * payment six times; the node refused every one with -22 »TX rejected«, and the
 * page said the payment had failed and the goods must not be handed over. The
 * seventh try, at 08:56:49 — right after that earlier payment was mined — went
 * through, spending exactly the change that earlier payment had returned.
 *
 * Why it happens: the Electrum server's `listunspent` does not look at the
 * mempool. Until the previous payment is in a block it keeps offering the coin
 * that payment has already spent, the signer takes the largest coin first, and
 * the new transaction spends the same coin a second time — a double spend the
 * node refuses. The only figure that does see the mempool is `get_balance`'s
 * `unconfirmed`: below zero means a payment is leaving this wallet and is not
 * mined yet.
 *
 * Nothing here moves, prices or decides money. It only picks the words the
 * person reads, and keeps the page from signing a transaction the node cannot
 * accept until the next block.
 */

/** Which wait it is: a payment still leaving the wallet, or funds still arriving. */
export type BlockWait = 'outgoing' | 'incoming' | null;

/** What /api/balance/:address answers (LANA amounts are rounded to 2 decimals). */
export interface BalanceSnapshot {
  confirmed?: number | null;
  unconfirmed?: number | null;
  /** Exact, unrounded — a pending fee-only spend (e.g. a consolidation) rounds to 0.00. */
  unconfirmedLanoshis?: number | null;
}

const LANOSHIS = 1e8;

function unconfirmedLanoshis(b: BalanceSnapshot): number {
  if (typeof b.unconfirmedLanoshis === 'number' && Number.isFinite(b.unconfirmedLanoshis)) {
    return Math.round(b.unconfirmedLanoshis);
  }
  const u = Number(b.unconfirmed);
  return Number.isFinite(u) ? Math.round(u * LANOSHIS) : 0;
}

/**
 * Before signing: may this wallet pay `neededLanoshis` right now?
 *
 * - a payment is still leaving the wallet → 'outgoing' (the coins on offer
 *   may already be spent; the node would refuse the new transaction);
 * - funds are still arriving and the CONFIRMED coins do not cover the payment
 *   → 'incoming' (the arriving coins cannot be spent before their block);
 * - otherwise null — go ahead. An unreadable balance is also null: the node
 *   refuses a double spend by itself, so this check only ever saves a doomed try.
 */
export function blockWaitBeforeSigning(b: BalanceSnapshot | null | undefined, neededLanoshis: number): BlockWait {
  if (!b) return null;
  const u = unconfirmedLanoshis(b);
  if (u < 0) return 'outgoing';
  if (u > 0) {
    const confirmed = Math.round((Number(b.confirmed) || 0) * LANOSHIS);
    if (confirmed < neededLanoshis) return 'incoming';
  }
  return null;
}

/**
 * The node's words for "this transaction spends a coin that is already spent or
 * not usable yet". On this chain the python Electrum server passes the node's
 * refusal on as `{u'message': u'TX rejected', u'code': -22}`; the others are the
 * reasons newer nodes give for the same thing.
 */
const STALE_INPUT = /-22\b|TX rejected|txn-mempool-conflict|missingorspent|missing inputs|already spent|too-long-mempool-chain/i;

export function isStaleInputRejection(reason: unknown): boolean {
  return typeof reason === 'string' && STALE_INPUT.test(reason);
}

/**
 * After the brain answered CUSTOMER_LANA_FAILED: was it the wait for a block?
 * Only when the node's reason is a spent/unusable-coin refusal AND the wallet,
 * read again just now, still has something unconfirmed. Anything else stays a
 * genuine failure, with the genuine-failure message.
 */
export function blockWaitAfterRejection(reason: unknown, b: BalanceSnapshot | null | undefined): BlockWait {
  if (!b || !isStaleInputRejection(reason)) return null;
  const u = unconfirmedLanoshis(b);
  if (u < 0) return 'outgoing';
  if (u > 0) return 'incoming';
  return null;
}

/**
 * The brain could not tell whether the customer's LANA moved: it stopped waiting
 * for the broadcast (409 CUSTOMER_LANA_IN_DOUBT), or this app never heard the
 * brain's answer (502 from our own proxy). "Failed" would be a guess — the money
 * may be on its way — so these are shown as "being verified".
 */
export function isOutcomeUnknown(status: number, body: { error?: unknown } | null | undefined): boolean {
  if (status === 409 && body?.error === 'CUSTOMER_LANA_IN_DOUBT') return true;
  if (status === 502 && body?.error === 'Failed to reach Brain service') return true;
  return false;
}

/** Read the wallet's balance for the checks above; null when it cannot be read. */
export async function readBalanceSnapshot(walletId: string): Promise<BalanceSnapshot | null> {
  try {
    const res = await fetch(`/api/balance/${encodeURIComponent(walletId)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    if (j?.status === 'error') return null;
    return { confirmed: j?.confirmed, unconfirmed: j?.unconfirmed, unconfirmedLanoshis: j?.unconfirmedLanoshis };
  } catch {
    return null;
  }
}
