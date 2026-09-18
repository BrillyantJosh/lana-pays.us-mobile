/**
 * Has the INVESTOR paid the merchant for this Lana-online sale?
 *
 * When a customer pays a Lana-online request in LANA, the brain records the
 * sale and creates FIAT payouts that investors pay on direct.lana.fund: the
 * invoice itself (`merchant_payment`, to the merchant's bank) and, sometimes, a
 * reward (`merchant_commission`, to the bank). Until now the merchant could see
 * none of that from this app.
 *
 * The brain's own payout records are the source, read through its machine door
 * GET /api/peer/purchase-payouts (Authorization: Bearer <service key>). This
 * server is a machine, so it authenticates as one — BRAIN_PEER_KEY, falling
 * back to BRAIN_PURCHASE_KEY which the brain's peer router also accepts — and
 * never with the merchant's hex.
 *
 * "Paid" here means only that the investor MARKED the payout paid on
 * direct.lana.fund. No bank statement is checked by anybody, which is why the
 * state is called `marked_paid` and the page says so.
 *
 * FAIL CLOSED. The one wrong answer that costs a merchant money is a green
 * "paid" that is not true, so `marked_paid` can only ever come out of a 200
 * JSON answer from the brain whose every invoice payout is paid or confirmed.
 * A timeout, a 500, a brain that has not been deployed yet (its SPA answers an
 * unknown /api/peer/* path with index.html and HTTP 200), a missing key, a
 * mismatched unit or invoice, or a status this file does not know — all of it
 * is `unknown`, never `waiting` and never `marked_paid`. An expired cache entry
 * is dropped on a failed refresh rather than served stale.
 */

// ── Types ────────────────────────────────────────────────────────────────

export type LegState = 'marked_paid' | 'waiting' | 'partly' | 'unknown' | 'not_applicable';

export interface Leg {
  state: LegState;
  marked_paid_at: string | null;
}

export interface RewardLeg extends Leg {
  amount_fiat: number | null;
  currency: string | null;
}

export interface InvestorStatus {
  invoice: Leg;
  /** null = no bank reward on this sale, so no reward line is shown. */
  reward: RewardLeg | null;
  /** When this server last heard the brain's answer for this sale (ISO), or null. */
  checked_at: string | null;
}

/** One brain `fiat_orders` row, as the peer route returns it. */
export interface PayoutRow {
  transaction_id?: string;
  order_type: string;
  destination_type: string;
  status: string;
  amount_fiat: number | null;
  currency: string | null;
  updated_at: string | null;
}

export type BrainTxEntry =
  | { found: true; unit_id: string; invoice_number: string; payment_type: string; payouts: PayoutRow[] }
  | { found: false };

/** What the overview route knows about one request, before asking the brain. */
export interface RequestForInvestor {
  customer_status: string;
  brain_transaction_id: string | null;
  unit_id: string;
  invoice_number: string;
}

// ── Pure classification ──────────────────────────────────────────────────

const PAID = new Set(['paid', 'confirmed']);
const KNOWN_OPEN = new Set(['sent_to_fund', 'pending']);

const UNKNOWN: Leg = Object.freeze({ state: 'unknown', marked_paid_at: null }) as Leg;
const NOT_APPLICABLE: Leg = Object.freeze({ state: 'not_applicable', marked_paid_at: null }) as Leg;

/**
 * One payout leg (the invoice, or the reward) from its brain rows.
 *
 * Cancelled rows are history — a reallocated payout leaves its superseded row
 * cancelled and a new row in its place — so only the rest count. Of those:
 * none at all → unknown; any status outside the four this file understands
 * (including `failed`) → unknown; all paid/confirmed → marked_paid, dated by
 * the latest update; none paid → waiting; otherwise partly.
 */
export function classifyLeg(rows: PayoutRow[]): Leg {
  const live = (rows || []).filter((r) => r && r.status !== 'cancelled');
  if (live.length === 0) return { ...UNKNOWN };
  if (live.some((r) => !PAID.has(r.status) && !KNOWN_OPEN.has(r.status))) return { ...UNKNOWN };
  const paid = live.filter((r) => PAID.has(r.status));
  if (paid.length === live.length) {
    const dates = paid.map((r) => (typeof r.updated_at === 'string' ? r.updated_at : '')).filter(Boolean).sort();
    return { state: 'marked_paid', marked_paid_at: dates.length ? dates[dates.length - 1] : null };
  }
  if (paid.length === 0) return { state: 'waiting', marked_paid_at: null };
  return { state: 'partly', marked_paid_at: null };
}

function rewardAmount(rows: PayoutRow[]): { amount_fiat: number | null; currency: string | null } {
  const live = rows.filter((r) => r.status !== 'cancelled');
  if (live.length === 0) return { amount_fiat: null, currency: null };
  const currencies = new Set(live.map((r) => r.currency));
  const [currency] = [...currencies];
  if (currencies.size !== 1 || typeof currency !== 'string' || !currency) return { amount_fiat: null, currency: null };
  if (live.some((r) => typeof r.amount_fiat !== 'number' || !Number.isFinite(r.amount_fiat))) {
    return { amount_fiat: null, currency };
  }
  const sum = live.reduce((s, r) => s + (r.amount_fiat as number), 0);
  return { amount_fiat: Math.round(sum * 100) / 100, currency };
}

/**
 * Both legs of one sale from the brain's entry for it.
 *
 * The brain transaction must be the one this request made: a LANA sale, on
 * this request's unit, for this request's invoice. Anything else is unknown —
 * a payout for somebody else's sale is not an answer about this one.
 */
export function investorFromEntry(
  entry: BrainTxEntry | null | undefined,
  req: { unit_id: string; invoice_number: string },
): { invoice: Leg; reward: RewardLeg | null } {
  if (!entry || entry.found !== true) return { invoice: { ...UNKNOWN }, reward: null };
  if (entry.payment_type !== 'lana' || entry.unit_id !== req.unit_id || entry.invoice_number !== req.invoice_number) {
    return { invoice: { ...UNKNOWN }, reward: null };
  }

  // The invoice is paid to the merchant's BANK. A merchant_payment going
  // anywhere else is not the payout this page describes.
  const invoiceRows = entry.payouts.filter((p) => p.order_type === 'merchant_payment');
  const invoice = invoiceRows.some((p) => p.destination_type !== 'bank') ? { ...UNKNOWN } : classifyLeg(invoiceRows);

  // Only a reward paid to the bank is the merchant's to see as "the investor
  // paid". A reward in LANA is paid to Lana Discount, not to the merchant.
  const rewardRows = entry.payouts.filter((p) => p.order_type === 'merchant_commission' && p.destination_type === 'bank');
  const reward: RewardLeg | null = rewardRows.length === 0 ? null : { ...classifyLeg(rewardRows), ...rewardAmount(rewardRows) };

  return { invoice, reward };
}

// ── Shape check on the brain's answer ────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const strOrNull = (v: unknown) => v === null || v === undefined || typeof v === 'string';
const numOrNull = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));

function validPayout(p: unknown, txId: string): p is PayoutRow {
  if (!isObj(p)) return false;
  if (typeof p.order_type !== 'string' || typeof p.destination_type !== 'string' || typeof p.status !== 'string') return false;
  if (!numOrNull(p.amount_fiat) || !strOrNull(p.currency) || !strOrNull(p.updated_at)) return false;
  if (p.transaction_id !== undefined && String(p.transaction_id).toLowerCase() !== txId) return false;
  return true;
}

/** The entry for `txId`, or null when it is missing or not the shape agreed. */
export function validEntry(raw: unknown, txId: string): BrainTxEntry | null {
  if (!isObj(raw)) return null;
  if (raw.found === false) return { found: false };
  if (raw.found !== true) return null;
  if (typeof raw.unit_id !== 'string' || typeof raw.invoice_number !== 'string' || typeof raw.payment_type !== 'string') return null;
  if (!Array.isArray(raw.payouts) || !raw.payouts.every((p: unknown) => validPayout(p, txId))) return null;
  return {
    found: true,
    unit_id: raw.unit_id,
    invoice_number: raw.invoice_number,
    payment_type: raw.payment_type,
    payouts: raw.payouts.map((p: any) => ({
      order_type: p.order_type,
      destination_type: p.destination_type,
      status: p.status,
      amount_fiat: typeof p.amount_fiat === 'number' ? p.amount_fiat : null,
      currency: typeof p.currency === 'string' ? p.currency : null,
      updated_at: typeof p.updated_at === 'string' ? p.updated_at : null,
    })),
  };
}

// ── Reader: fetch + cache ────────────────────────────────────────────────

export const FINAL_TTL_MS = 6 * 60 * 60 * 1000;
export const OPEN_TTL_MS = 60 * 1000;
export const CACHE_MAX = 5000;
export const FETCH_TIMEOUT_MS = 4000;
export const MAX_IDS_PER_CALL = 50;

export interface BrainPayoutDeps {
  fetchImpl?: typeof fetch;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Read on every call, so a restart with a new key — or a test — takes effect. */
  env?: () => { url: string; key: string };
  timeoutMs?: number;
  log?: Pick<Console, 'warn'>;
}

interface CacheEntry { entry: BrainTxEntry; fetchedAt: number; expiresAt: number }

const defaultEnv = () => ({
  url: String(process.env.BRAIN_API_URL || ''),
  key: String(process.env.BRAIN_PEER_KEY || '') || String(process.env.BRAIN_PURCHASE_KEY || ''),
});

/** Final when every leg that will be shown is marked paid. */
function isFinal(v: { invoice: Leg; reward: RewardLeg | null }): boolean {
  return v.invoice.state === 'marked_paid' && (v.reward === null || v.reward.state === 'marked_paid');
}

export function createBrainPayoutReader(deps: BrainPayoutDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? (() => Date.now());
  const env = deps.env ?? defaultEnv;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const log = deps.log ?? console;

  const cache = new Map<string, CacheEntry>();
  let warnedUnconfigured = false;

  const remember = (id: string, value: CacheEntry) => {
    cache.delete(id);
    cache.set(id, value);
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  /** Ask the brain for up to 50 transactions. Null on ANY failure. */
  async function fetchEntries(ids: string[]): Promise<Record<string, unknown> | null> {
    const { url, key } = env();
    if (!url || !key) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        log.warn(`[online-payments] investor status unavailable: ${!url ? 'BRAIN_API_URL' : 'BRAIN_PEER_KEY (or BRAIN_PURCHASE_KEY)'} is not set — every investor status shows as unknown`);
      }
      return null;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${url.replace(/\/+$/, '')}/api/peer/purchase-payouts?tx=${ids.join(',')}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (res.status !== 200) {
        log.warn(`[online-payments] brain purchase-payouts answered HTTP ${res.status} — investor status unknown`);
        return null;
      }
      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('application/json')) {
        // The brain without this route answers its SPA shell with 200.
        log.warn(`[online-payments] brain purchase-payouts answered ${ct || 'no content-type'}, not JSON — is the brain route deployed?`);
        return null;
      }
      const body: any = await res.json();
      if (!isObj(body) || !isObj(body.transactions)) {
        log.warn('[online-payments] brain purchase-payouts answered an unexpected shape — investor status unknown');
        return null;
      }
      return body.transactions;
    } catch (e: any) {
      log.warn(`[online-payments] brain purchase-payouts unreachable (${e?.name === 'AbortError' ? 'timeout' : e?.message || 'error'}) — investor status unknown`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The investor status of each request, in the same order. At most ONE brain
   * call, for the paid requests that are not fresh in the cache.
   */
  async function statuses(requests: RequestForInvestor[]): Promise<InvestorStatus[]> {
    const t = now();
    const need: string[] = [];

    for (const r of requests) {
      if (r.customer_status !== 'paid') continue;
      const id = String(r.brain_transaction_id || '').toLowerCase();
      if (!UUID.test(id) || need.includes(id)) continue;
      const hit = cache.get(id);
      if (hit && hit.expiresAt > t) continue;
      if (need.length < MAX_IDS_PER_CALL) need.push(id);
    }

    if (need.length > 0) {
      const answered = await fetchEntries(need);
      const at = now();
      for (const id of need) {
        const entry = answered ? validEntry(answered[id], id) : null;
        if (!entry) {
          // Never serve an expired answer as if it were still true.
          cache.delete(id);
          continue;
        }
        const ctx = requests.find((r) => String(r.brain_transaction_id || '').toLowerCase() === id)!;
        const ttl = isFinal(investorFromEntry(entry, ctx)) ? FINAL_TTL_MS : OPEN_TTL_MS;
        remember(id, { entry, fetchedAt: at, expiresAt: at + ttl });
      }
    }

    const t2 = now();
    return requests.map((r): InvestorStatus => {
      if (r.customer_status === 'waiting' || r.customer_status === 'expired' || r.customer_status === 'cancelled') {
        return { invoice: { ...NOT_APPLICABLE }, reward: null, checked_at: null };
      }
      if (r.customer_status !== 'paid') return { invoice: { ...UNKNOWN }, reward: null, checked_at: null };
      const id = String(r.brain_transaction_id || '').toLowerCase();
      const hit = UUID.test(id) ? cache.get(id) : undefined;
      if (!hit || hit.expiresAt <= t2) return { invoice: { ...UNKNOWN }, reward: null, checked_at: null };
      return { ...investorFromEntry(hit.entry, r), checked_at: new Date(hit.fetchedAt).toISOString() };
    });
  }

  return {
    statuses,
    /** Test seam. */
    reset() { cache.clear(); warnedUnconfigured = false; },
    /** Test seam. */
    cacheSize() { return cache.size; },
  };
}

export type BrainPayoutReader = ReturnType<typeof createBrainPayoutReader>;

/** The one reader the running server uses. */
export const brainPayoutReader: BrainPayoutReader = createBrainPayoutReader();
