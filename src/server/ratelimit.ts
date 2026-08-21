export type RateLimiter = {
  check(key: string): { ok: true } | { ok: false; retryAfterMs: number };
  fail(key: string): void;
  reset(key: string): void;
};

export type Entry = { failures: number[]; blockedUntil: number };

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

function prune(e: Entry, windowMs: number, t: number): void {
  e.failures = e.failures.filter((at) => t - at < windowMs);
}

// An entry is "dead" once its block (if any) has expired and it has no
// failures left inside the window: at that point it is indistinguishable
// from a key that was never seen, so dropping it changes no observable
// behaviour — a later check()/fail() just recreates it from scratch.
function isDead(e: Entry, t: number): boolean {
  return e.blockedUntil <= t && e.failures.length === 0;
}

/**
 * Delete dead entries from the map in place: entries whose block (if any)
 * has expired and which have no failures left inside the window. Pure given
 * its explicit inputs — no dependency on a limiter instance — so it can be
 * tested directly instead of through a test-only introspection seam.
 */
export function sweep(entries: Map<string, Entry>, opts: { windowMs: number }, t: number): void {
  for (const [key, e] of entries) {
    prune(e, opts.windowMs, t);
    if (isDead(e, t)) entries.delete(key);
  }
}

export function makeRateLimiter(opts: {
  limit: number; windowMs: number; blockMs: number; now?: () => number;
}): RateLimiter {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let failsSinceSweep = 0;

  return {
    check(key: string) {
      const t = now();
      const e = entries.get(key);
      if (!e) return { ok: true as const };
      if (e.blockedUntil > t) return { ok: false as const, retryAfterMs: e.blockedUntil - t };
      prune(e, opts.windowMs, t);
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
      prune(e, opts.windowMs, t);
      e.failures.push(t);
      if (e.failures.length >= opts.limit) e.blockedUntil = t + opts.blockMs;
      entries.set(key, e);

      failsSinceSweep++;
      if (failsSinceSweep >= SWEEP_EVERY) {
        failsSinceSweep = 0;
        sweep(entries, opts, t);
      }
    },
    reset(key: string) { entries.delete(key); },
  };
}
