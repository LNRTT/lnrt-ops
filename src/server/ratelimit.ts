export type RateLimiter = {
  check(key: string): { ok: true } | { ok: false; retryAfterMs: number };
  fail(key: string): void;
  reset(key: string): void;
};

type Entry = { failures: number[]; blockedUntil: number };

/**
 * In-memory sliding-window limiter.
 *
 * Known limitation, accepted for v0.1: state is per process, so it resets on
 * deploy and is not shared across instances. It raises the cost of online
 * guessing; it is not a distributed lockout.
 */
export function makeRateLimiter(opts: {
  limit: number; windowMs: number; blockMs: number; now?: () => number;
}): RateLimiter {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function prune(e: Entry, t: number): void {
    e.failures = e.failures.filter((at) => t - at < opts.windowMs);
  }

  return {
    check(key) {
      const t = now();
      const e = entries.get(key);
      if (!e) return { ok: true };
      if (e.blockedUntil > t) return { ok: false, retryAfterMs: e.blockedUntil - t };
      prune(e, t);
      if (e.failures.length >= opts.limit) return { ok: false, retryAfterMs: opts.blockMs };
      return { ok: true };
    },
    fail(key) {
      const t = now();
      const e = entries.get(key) ?? { failures: [], blockedUntil: 0 };
      prune(e, t);
      e.failures.push(t);
      if (e.failures.length >= opts.limit) e.blockedUntil = t + opts.blockMs;
      entries.set(key, e);
    },
    reset(key) { entries.delete(key); },
  };
}
