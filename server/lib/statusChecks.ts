/**
 * Per-person lookups for the regulars list (Lana8Wonder enrolment + wallets /
 * freeze from check.lanapays.us), shared across requests.
 *
 * Why this exists: /api/customers-status used to await EVERY person's lookup
 * before answering. check.lanapays.us takes ~1.4 s per call, two calls per
 * person, six at a time — at 441 regulars that is ~120 s, and the balances
 * (which need nothing from check.lanapays.us) waited behind it. The phone gave
 * up long before that and the list sat on "loading balance" for good.
 *
 * Now:
 *  - one lookup per person at a time, whoever asks (in-flight dedupe), so a
 *    merchant who re-asks does not start the same 441 lookups again;
 *  - ONE concurrency cap for the whole process, not one per request, so polls
 *    stacking up cannot multiply the load on check.lanapays.us;
 *  - a result is cached for `ttlMs`; a total failure is never cached;
 *  - `settleWithin` lets a request answer with what is ready by a deadline while
 *    the rest keeps filling the cache for the next ask.
 */

export interface StatusChecker<V> {
  /** The cached value, or the running lookup, or a new one (queued under the cap). */
  get(key: string): Promise<V>;
  /** Number of lookups waiting or running right now. */
  pending(): number;
}

export function createStatusChecker<V>(opts: {
  fetchOne: (key: string) => Promise<V>;
  /** Cache only when this says the value is worth keeping (not a total failure). */
  cacheable: (value: V) => boolean;
  concurrency: number;
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
}): StatusChecker<V> {
  const now = opts.now ?? Date.now;
  const maxEntries = opts.maxEntries ?? 5000;
  const cache = new Map<string, { at: number; value: V }>();
  const inflight = new Map<string, Promise<V>>();
  const queue: Array<() => void> = [];
  let running = 0;

  const pump = () => {
    while (running < opts.concurrency && queue.length > 0) {
      running++;
      queue.shift()!();
    }
  };

  const fresh = (key: string): V | undefined => {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (now() - hit.at > opts.ttlMs) { cache.delete(key); return undefined; }
    return hit.value;
  };

  return {
    get(key: string): Promise<V> {
      const cached = fresh(key);
      if (cached !== undefined) return Promise.resolve(cached);
      const running0 = inflight.get(key);
      if (running0) return running0;

      const p = new Promise<V>((resolve, reject) => {
        queue.push(() => {
          // Free the slot and the in-flight entry BEFORE settling, so whoever
          // asks right after the answer starts a fresh lookup (or hits the cache)
          // instead of being handed this finished promise again.
          const release = () => { inflight.delete(key); running--; pump(); };
          let started: Promise<V>;
          try { started = opts.fetchOne(key); } catch (e) { started = Promise.reject(e); }
          started.then(
            value => {
              if (opts.cacheable(value)) {
                if (cache.size >= maxEntries) {
                  for (const [k, v] of cache) if (now() - v.at > opts.ttlMs) cache.delete(k);
                  if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
                }
                cache.set(key, { at: now(), value });
              }
              release();
              resolve(value);
            },
            err => { release(); reject(err); }
          );
        });
      });
      inflight.set(key, p);
      pump();
      return p;
    },
    pending: () => inflight.size,
  };
}

/**
 * Wait for the promises until they all settle or `ms` passes, whichever is
 * first. Slot i is the value, or `undefined` if it was not ready (or failed);
 * `settled[i]` says whether it finished at all.
 * Never rejects; a promise still running keeps running.
 */
export async function settleWithin<V>(
  promises: Promise<V>[],
  ms: number
): Promise<{ values: Array<V | undefined>; settled: boolean[]; complete: boolean }> {
  const values = new Array<V | undefined>(promises.length).fill(undefined);
  const done = new Array<boolean>(promises.length).fill(false);
  const all = Promise.all(promises.map((p, i) =>
    p.then(v => { values[i] = v; done[i] = true; }, () => { done[i] = true; })
  ));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([all, deadline]);
  } finally {
    clearTimeout(timer);
  }
  return { values: [...values], settled: [...done], complete: done.every(Boolean) };
}
