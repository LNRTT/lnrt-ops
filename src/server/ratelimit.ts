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
// Sweep the entries map at most once every this many fail() calls. A full
// sweep is O(entries.size), so triggering it unconditionally on every failed
// login would itself be a cheap denial-of-service lever for the same
// credential-stuffing traffic this limiter exists to blunt. Amortized over
// SWEEP_EVERY calls the added cost per fail() is O(entries.size / SWEEP_EVERY),
// and a burst of failures against a single key just delays the next sweep by
// a bit — it never grows the map, since sweeping only ever removes entries.
const SWEEP_EVERY = 1000;

export function makeRateLimiter(opts: {
  limit: number; windowMs: number; blockMs: number; now?: () => number;
}): RateLimiter {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let failsSinceSweep = 0;

  function prune(e: Entry, t: number): void {
    e.failures = e.failures.filter((at) => t - at < opts.windowMs);
  }

  // An entry is "dead" once its block (if any) has expired and it has no
  // failures left inside the window: at that point it is indistinguishable
  // from a key that was never seen, so dropping it changes no observable
  // behaviour — a later check()/fail() just recreates it from scratch.
  function isDead(e: Entry, t: number): boolean {
    return e.blockedUntil <= t && e.failures.length === 0;
  }

  function sweep(t: number): void {
    for (const [key, e] of entries) {
      prune(e, t);
      if (isDead(e, t)) entries.delete(key);
    }
  }

  const limiter = {
    check(key: string) {
      const t = now();
      const e = entries.get(key);
      if (!e) return { ok: true as const };
      if (e.blockedUntil > t) return { ok: false as const, retryAfterMs: e.blockedUntil - t };
      prune(e, t);
      if (e.failures.length >= opts.limit) {
        // Consistent with fail(): once the failure count is (still) at or
        // above the limit, the key is blocked for blockMs from now, and the
        // reported wait is read back the same way the blockedUntil branch
        // above reads it — so it actually counts down on later calls instead
        // of returning a static, never-decreasing opts.blockMs.
        e.blockedUntil = t + opts.blockMs;
        return { ok: false as const, retryAfterMs: e.blockedUntil - t };
      }
      return { ok: true as const };
    },
    fail(key: string) {
      const t = now();
      const e = entries.get(key) ?? { failures: [], blockedUntil: 0 };
      prune(e, t);
      e.failures.push(t);
      if (e.failures.length >= opts.limit) e.blockedUntil = t + opts.blockMs;
      entries.set(key, e);

      failsSinceSweep++;
      if (failsSinceSweep >= SWEEP_EVERY) {
        failsSinceSweep = 0;
        sweep(t);
      }
    },
    reset(key: string) { entries.delete(key); },
    // Introspection for tests only — not part of the RateLimiter contract.
    __size(): number { return entries.size; },
  };

  return limiter;
}

/**
 * Test-only introspection of how many keys a limiter is currently tracking.
 * Not part of the RateLimiter contract — used to assert eviction actually
 * shrinks the map, without exposing internals through the public interface.
 */
export function __entryCount(rl: RateLimiter): number {
  return (rl as unknown as { __size(): number }).__size();
}
