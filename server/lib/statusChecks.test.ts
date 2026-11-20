import { describe, it, expect } from 'vitest';
import { createStatusChecker, settleWithin } from './statusChecks';

const tick = () => new Promise(r => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('createStatusChecker', () => {
  it('runs ONE lookup per key while it is in flight, however many ask', async () => {
    let calls = 0;
    const d = deferred<string>();
    const c = createStatusChecker<string>({
      fetchOne: async () => { calls++; return d.promise; },
      cacheable: () => true, concurrency: 6, ttlMs: 1000,
    });
    const a = c.get('x'); const b = c.get('x');
    await tick();
    expect(calls).toBe(1);
    d.resolve('v');
    expect(await a).toBe('v');
    expect(await b).toBe('v');
  });

  it('caps concurrency across ALL callers, not per request', async () => {
    let active = 0, peak = 0;
    const gates: Array<() => void> = [];
    const c = createStatusChecker<number>({
      fetchOne: () => new Promise(r => { active++; peak = Math.max(peak, active); gates.push(() => { active--; r(1); }); }),
      cacheable: () => true, concurrency: 3, ttlMs: 1000,
    });
    const all = [...Array(10).keys()].map(i => c.get(`k${i}`));
    await tick();
    expect(active).toBe(3);
    while (gates.length) { gates.shift()!(); await tick(); await tick(); }
    await Promise.all(all);
    expect(peak).toBe(3);
    expect(c.pending()).toBe(0);
  });

  it('serves the cache inside the TTL and looks again after it', async () => {
    let t = 0, calls = 0;
    const c = createStatusChecker<number>({
      fetchOne: async () => ++calls, cacheable: () => true, concurrency: 2, ttlMs: 100, now: () => t,
    });
    expect(await c.get('x')).toBe(1);
    t = 50; expect(await c.get('x')).toBe(1);
    t = 151; expect(await c.get('x')).toBe(2);
  });

  it('never caches a value marked not cacheable (a total failure)', async () => {
    let calls = 0;
    const c = createStatusChecker<{ ok: boolean }>({
      fetchOne: async () => { calls++; return { ok: false }; },
      cacheable: v => v.ok, concurrency: 2, ttlMs: 10_000,
    });
    await c.get('x'); await c.get('x');
    expect(calls).toBe(2);
  });

  it('a rejected lookup frees its slot and is retried on the next ask', async () => {
    let calls = 0;
    const c = createStatusChecker<number>({
      fetchOne: async () => { calls++; if (calls === 1) throw new Error('down'); return 7; },
      cacheable: () => true, concurrency: 1, ttlMs: 10_000,
    });
    await expect(c.get('x')).rejects.toThrow('down');
    expect(await c.get('x')).toBe(7);
    expect(c.pending()).toBe(0);
  });
});

describe('settleWithin', () => {
  it('answers by the deadline with what is ready; the rest is undefined and not settled', async () => {
    const slow = deferred<number>();
    const r = await settleWithin([Promise.resolve(1), slow.promise, Promise.resolve(3)], 20);
    expect(r.values).toEqual([1, undefined, 3]);
    expect(r.settled).toEqual([true, false, true]);
    expect(r.complete).toBe(false);
    slow.resolve(2); // still allowed to finish later, nothing throws
  });

  it('answers at once when everything is ready', async () => {
    const t0 = Date.now();
    const r = await settleWithin([Promise.resolve('a'), Promise.resolve('b')], 5000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r).toEqual({ values: ['a', 'b'], settled: [true, true], complete: true });
  });

  it('a rejection counts as settled without a value, and never rejects the whole', async () => {
    const r = await settleWithin([Promise.reject(new Error('x')), Promise.resolve(2)], 50);
    expect(r.values).toEqual([undefined, 2]);
    expect(r.settled).toEqual([true, true]);
    expect(r.complete).toBe(true);
  });
});
