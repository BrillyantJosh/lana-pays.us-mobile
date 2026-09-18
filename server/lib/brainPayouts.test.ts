// @vitest-environment node
/**
 * "Has the investor paid?" — the classifier, the fetch and the cache.
 *
 * The one wrong answer that costs a merchant money is a green "marked paid"
 * that is not true. So besides every classifier branch, this pins that a
 * network error, a timeout, a 500 and a 200 HTML page (the brain before its
 * route is deployed) are all `unknown`; that a cache entry past its lifetime is
 * dropped on a failed refresh instead of served stale; and that `marked_paid`
 * only ever comes out of a 200 JSON answer.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  classifyLeg, investorFromEntry, validEntry, createBrainPayoutReader,
  FINAL_TTL_MS, OPEN_TTL_MS, type PayoutRow, type BrainTxEntry, type RequestForInvestor,
} from './brainPayouts.js';

const TX1 = '11111111-1111-4111-8111-111111111111';
const TX2 = '22222222-2222-4222-8222-222222222222';
const UNIT = 'u'.repeat(32);

const row = (status: string, over: Partial<PayoutRow> = {}): PayoutRow => ({
  order_type: 'merchant_payment', destination_type: 'bank', status,
  amount_fiat: 10, currency: 'EUR', updated_at: '2026-09-17 10:00:00', ...over,
});

const entry = (payouts: PayoutRow[], over: Partial<{ unit_id: string; invoice_number: string; payment_type: string }> = {}): BrainTxEntry => ({
  found: true, unit_id: UNIT, invoice_number: 'INV-1', payment_type: 'lana', payouts, ...over,
});

const req = (over: Partial<RequestForInvestor> = {}): RequestForInvestor => ({
  customer_status: 'paid', brain_transaction_id: TX1, unit_id: UNIT, invoice_number: 'INV-1', ...over,
});

describe('classifyLeg', () => {
  it('no rows → unknown', () => {
    expect(classifyLeg([]).state).toBe('unknown');
  });

  it('all cancelled → unknown', () => {
    expect(classifyLeg([row('cancelled'), row('cancelled')]).state).toBe('unknown');
  });

  it('all paid/confirmed → marked_paid, dated by the latest update', () => {
    const leg = classifyLeg([row('paid', { updated_at: '2026-09-10 08:00:00' }), row('confirmed', { updated_at: '2026-09-12 09:30:00' })]);
    expect(leg).toEqual({ state: 'marked_paid', marked_paid_at: '2026-09-12 09:30:00' });
  });

  it('none paid → waiting', () => {
    expect(classifyLeg([row('pending'), row('sent_to_fund')]).state).toBe('waiting');
  });

  it('some paid → partly', () => {
    expect(classifyLeg([row('paid'), row('pending')]).state).toBe('partly');
  });

  it('failed → unknown, even beside a paid row', () => {
    expect(classifyLeg([row('failed')]).state).toBe('unknown');
    expect(classifyLeg([row('paid'), row('failed')]).state).toBe('unknown');
  });

  it('a status this file does not know → unknown', () => {
    expect(classifyLeg([row('refunded')]).state).toBe('unknown');
    expect(classifyLeg([row('paid'), row('PAID')]).state).toBe('unknown');
  });

  it('a superseded (cancelled) payout next to its replacement counts only the replacement', () => {
    expect(classifyLeg([row('cancelled'), row('paid')]).state).toBe('marked_paid');
    expect(classifyLeg([row('cancelled'), row('pending')]).state).toBe('waiting');
  });
});

describe('investorFromEntry', () => {
  it('found:false → unknown', () => {
    expect(investorFromEntry({ found: false }, req()).invoice.state).toBe('unknown');
  });

  it('a merchant_payment that does not go to the bank → unknown', () => {
    expect(investorFromEntry(entry([row('paid', { destination_type: 'merchant' })]), req()).invoice.state).toBe('unknown');
    expect(investorFromEntry(entry([row('paid'), row('paid', { destination_type: 'lana_discount' })]), req()).invoice.state).toBe('unknown');
  });

  it('a different unit, invoice or payment type → unknown', () => {
    const paid = [row('paid')];
    expect(investorFromEntry(entry(paid, { unit_id: 'x'.repeat(32) }), req()).invoice.state).toBe('unknown');
    expect(investorFromEntry(entry(paid, { invoice_number: 'INV-2' }), req()).invoice.state).toBe('unknown');
    expect(investorFromEntry(entry(paid, { payment_type: 'cash' }), req()).invoice.state).toBe('unknown');
    expect(investorFromEntry(entry(paid), req()).invoice.state).toBe('marked_paid');
  });

  it('the bank reward is its own line; a LANA reward is not shown at all', () => {
    const v = investorFromEntry(entry([
      row('pending'),
      row('paid', { order_type: 'merchant_commission', amount_fiat: 1.1 }),
      row('paid', { order_type: 'merchant_commission', amount_fiat: 2.2 }),
      row('paid', { order_type: 'merchant_commission', destination_type: 'lana_discount', amount_fiat: 99 }),
    ]), req());
    expect(v.invoice.state).toBe('waiting');
    expect(v.reward).toMatchObject({ state: 'marked_paid', amount_fiat: 3.3, currency: 'EUR' });

    const noReward = investorFromEntry(entry([row('paid'), row('paid', { order_type: 'merchant_commission', destination_type: 'lana_discount' })]), req());
    expect(noReward.reward).toBeNull();
  });

  it('caretaker and LANA-purchase rows never count toward the invoice', () => {
    const v = investorFromEntry(entry([
      row('paid'),
      row('pending', { order_type: 'caretaker_via_discount', destination_type: 'lana_discount' }),
      row('pending', { order_type: 'lana_purchase', destination_type: 'merchant' }),
    ]), req());
    expect(v.invoice.state).toBe('marked_paid');
    expect(v.reward).toBeNull();
  });
});

describe('validEntry', () => {
  it('rejects a payout of the wrong shape or for another transaction', () => {
    expect(validEntry({ found: true, unit_id: UNIT, invoice_number: 'I', payment_type: 'lana', payouts: [{ status: 'paid' }] }, TX1)).toBeNull();
    expect(validEntry({ found: true, unit_id: UNIT, invoice_number: 'I', payment_type: 'lana', payouts: [{ ...row('paid'), transaction_id: TX2 }] }, TX1)).toBeNull();
    expect(validEntry({ found: 'yes' }, TX1)).toBeNull();
    expect(validEntry(undefined, TX1)).toBeNull();
    expect(validEntry({ found: false }, TX1)).toEqual({ found: false });
  });
});

// ── the reader ──────────────────────────────────────────────────────────

const jsonResponse = (body: unknown, status = 200, contentType = 'application/json; charset=utf-8') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });

function setup(opts: { env?: { url: string; key: string } } = {}) {
  let now = 1_800_000_000_000;
  const fetchImpl = vi.fn<typeof fetch>();
  const warn = vi.fn();
  const reader = createBrainPayoutReader({
    fetchImpl,
    now: () => now,
    env: () => opts.env ?? { url: 'http://brain.test', key: 'peer-key' },
    log: { warn },
    timeoutMs: 50,
  });
  return { reader, fetchImpl, warn, advance: (ms: number) => { now += ms; } };
}

const answer = (transactions: Record<string, unknown>) => jsonResponse({ checked_at: '2026-09-18T10:00:00Z', transactions });

describe('the reader', () => {
  it('asks with the peer key in a Bearer header, for the paid requests only', async () => {
    const { reader, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(answer({ [TX1]: entry([row('paid')]) }));
    const out = await reader.statuses([
      req(),
      req({ customer_status: 'waiting', brain_transaction_id: null }),
      req({ customer_status: 'expired', brain_transaction_id: null }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(`http://brain.test/api/peer/purchase-payouts?tx=${TX1}`);
    expect((init as any).headers.Authorization).toBe('Bearer peer-key');
    expect(out[0].invoice.state).toBe('marked_paid');
    expect(out[0].checked_at).toBeTruthy();
    expect(out[1]).toEqual({ invoice: { state: 'not_applicable', marked_paid_at: null }, reward: null, checked_at: null });
    expect(out[2].invoice.state).toBe('not_applicable');
  });

  it('a customer payment that cannot be verified is unknown and never asked about', async () => {
    const { reader, fetchImpl } = setup();
    const out = await reader.statuses([req({ customer_status: 'unverified', brain_transaction_id: null })]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out[0].invoice.state).toBe('unknown');
  });

  it('a brain id that is not a UUID is unknown and not sent', async () => {
    const { reader, fetchImpl } = setup();
    const out = await reader.statuses([req({ brain_transaction_id: 'not-a-uuid' })]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out[0].invoice.state).toBe('unknown');
  });

  for (const [label, respond] of [
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['a 500', () => Promise.resolve(jsonResponse({ error: 'boom' }, 500))],
    ['a 401', () => Promise.resolve(jsonResponse({ error: 'Peer API key required' }, 401))],
    ['a 200 HTML page (brain route not deployed yet)', () => Promise.resolve(new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }))],
    ['a 200 JSON of the wrong shape', () => Promise.resolve(jsonResponse({ transactions: [] }))],
    ['a 200 JSON missing this transaction', () => Promise.resolve(answer({}))],
  ] as const) {
    it(`${label} → unknown`, async () => {
      const { reader, fetchImpl } = setup();
      fetchImpl.mockImplementationOnce(respond as any);
      const out = await reader.statuses([req()]);
      expect(out[0].invoice.state).toBe('unknown');
      expect(out[0].checked_at).toBeNull();
    });
  }

  it('a timeout → unknown', async () => {
    const { reader, fetchImpl } = setup();
    fetchImpl.mockImplementationOnce((_url, init) => new Promise((_, reject) => {
      (init as any).signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const out = await reader.statuses([req()]);
    expect(out[0].invoice.state).toBe('unknown');
  });

  it('no key or no URL → unknown, no call, and one warning naming BRAIN_PEER_KEY', async () => {
    const { reader, fetchImpl, warn } = setup({ env: { url: 'http://brain.test', key: '' } });
    await reader.statuses([req()]);
    const out = await reader.statuses([req()]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out[0].invoice.state).toBe('unknown');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('BRAIN_PEER_KEY');

    const noUrl = setup({ env: { url: '', key: 'k' } });
    expect((await noUrl.reader.statuses([req()]))[0].invoice.state).toBe('unknown');
    expect(noUrl.fetchImpl).not.toHaveBeenCalled();
  });

  it('a final state is served from the cache for 6 h', async () => {
    const { reader, fetchImpl, advance } = setup();
    fetchImpl.mockResolvedValueOnce(answer({ [TX1]: entry([row('paid')]) }));
    await reader.statuses([req()]);
    advance(FINAL_TTL_MS - 1000);
    const out = await reader.statuses([req()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(out[0].invoice.state).toBe('marked_paid');
  });

  it('a non-final state is fetched again after 60 s', async () => {
    const { reader, fetchImpl, advance } = setup();
    fetchImpl.mockResolvedValueOnce(answer({ [TX1]: entry([row('pending')]) }));
    fetchImpl.mockResolvedValueOnce(answer({ [TX1]: entry([row('paid')]) }));
    expect((await reader.statuses([req()]))[0].invoice.state).toBe('waiting');
    advance(OPEN_TTL_MS - 1000);
    expect((await reader.statuses([req()]))[0].invoice.state).toBe('waiting');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    advance(2000);
    expect((await reader.statuses([req()]))[0].invoice.state).toBe('marked_paid');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('an error after expiry → unknown, not the stale state, and the entry is dropped', async () => {
    const { reader, fetchImpl, advance } = setup();
    fetchImpl.mockResolvedValueOnce(answer({ [TX1]: entry([row('paid')]) }));
    await reader.statuses([req()]);
    expect(reader.cacheSize()).toBe(1);
    advance(FINAL_TTL_MS + 1);
    fetchImpl.mockRejectedValueOnce(new TypeError('fetch failed'));
    const out = await reader.statuses([req()]);
    expect(out[0].invoice.state).toBe('unknown');
    expect(reader.cacheSize()).toBe(0);
  });

  it('a pending invoice with a paid reward is not final — both lines are re-read after 60 s', async () => {
    const { reader, fetchImpl, advance } = setup();
    fetchImpl.mockResolvedValue(answer({ [TX1]: entry([row('paid'), row('pending', { order_type: 'merchant_commission' })]) }));
    await reader.statuses([req()]);
    advance(OPEN_TTL_MS + 1);
    await reader.statuses([req()]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('BRAIN_PEER_KEY wins over BRAIN_PURCHASE_KEY in the default environment', async () => {
    const saved = { url: process.env.BRAIN_API_URL, peer: process.env.BRAIN_PEER_KEY, purchase: process.env.BRAIN_PURCHASE_KEY };
    try {
      process.env.BRAIN_API_URL = 'http://brain.test';
      process.env.BRAIN_PURCHASE_KEY = 'purchase-key';
      process.env.BRAIN_PEER_KEY = 'peer-key';
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(answer({ [TX1]: entry([row('paid')]) }));
      const reader = createBrainPayoutReader({ fetchImpl, log: { warn: vi.fn() } });
      await reader.statuses([req()]);
      expect((fetchImpl.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer peer-key');

      delete process.env.BRAIN_PEER_KEY;
      reader.reset();
      await reader.statuses([req()]);
      expect((fetchImpl.mock.calls[1][1] as any).headers.Authorization).toBe('Bearer purchase-key');
    } finally {
      for (const [k, v] of [['BRAIN_API_URL', saved.url], ['BRAIN_PEER_KEY', saved.peer], ['BRAIN_PURCHASE_KEY', saved.purchase]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it('asks once per page for several transactions, de-duplicated', async () => {
    const { reader, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(answer({ [TX1]: entry([row('paid')]), [TX2]: entry([row('pending')], { invoice_number: 'INV-2' }) }));
    const out = await reader.statuses([req(), req({ brain_transaction_id: TX2, invoice_number: 'INV-2' }), req()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`tx=${TX1},${TX2}`);
    expect(out.map(o => o.invoice.state)).toEqual(['marked_paid', 'waiting', 'marked_paid']);
  });

  it('INVARIANT: marked_paid only ever comes out of a 200 JSON answer', async () => {
    const paidBody = { checked_at: 'x', transactions: { [TX1]: entry([row('paid')]) } };
    const variants: Array<() => Response> = [
      () => new Response(JSON.stringify(paidBody), { status: 201, headers: { 'content-type': 'application/json' } }),
      () => new Response(JSON.stringify(paidBody), { status: 203, headers: { 'content-type': 'application/json' } }),
      () => new Response(JSON.stringify(paidBody), { status: 500, headers: { 'content-type': 'application/json' } }),
      () => new Response(JSON.stringify(paidBody), { status: 200, headers: { 'content-type': 'text/html' } }),
      () => new Response(JSON.stringify(paidBody), { status: 200, headers: { 'content-type': 'text/plain' } }),
    ];
    for (const make of variants) {
      const { reader, fetchImpl } = setup();
      fetchImpl.mockResolvedValueOnce(make());
      expect((await reader.statuses([req()]))[0].invoice.state).not.toBe('marked_paid');
    }
    const { reader, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(jsonResponse(paidBody));
    expect((await reader.statuses([req()]))[0].invoice.state).toBe('marked_paid');
  });
});
