import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRateLimiter, sweep, type Entry } from "./ratelimit";

function limiterAt(clock: { t: number }) {
  return makeRateLimiter({ limit: 5, windowMs: 15 * 60_000, blockMs: 15 * 60_000, now: () => clock.t });
}

test("allows attempts below the limit", () => {
  const clock = { t: 0 };
  const rl = limiterAt(clock);
  for (let i = 0; i < 4; i++) { assert.equal(rl.check("ip").ok, true); rl.fail("ip"); }
  assert.equal(rl.check("ip").ok, true);
});

test("blocks after the fifth failure and reports the wait", () => {
  const clock = { t: 0 };
  const rl = limiterAt(clock);
  for (let i = 0; i < 5; i++) { rl.fail("ip"); }
  const res = rl.check("ip");
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.retryAfterMs, 15 * 60_000);
});

test("unblocks once the block window elapses", () => {
  const clock = { t: 0 };
  const rl = limiterAt(clock);
  for (let i = 0; i < 5; i++) { rl.fail("ip"); }
  clock.t += 15 * 60_000 + 1;
  assert.equal(rl.check("ip").ok, true);
});

test("failures older than the window do not count", () => {
  const clock = { t: 0 };
  const rl = limiterAt(clock);
  for (let i = 0; i < 4; i++) { rl.fail("ip"); }
  clock.t += 15 * 60_000 + 1;
  rl.fail("ip");
  assert.equal(rl.check("ip").ok, true);
});

test("keys are independent and reset clears one", () => {
  const clock = { t: 0 };
  const rl = limiterAt(clock);
  for (let i = 0; i < 5; i++) { rl.fail("a"); }
  assert.equal(rl.check("a").ok, false);
  assert.equal(rl.check("b").ok, true);
  rl.reset("a");
  assert.equal(rl.check("a").ok, true);
});

test("sweep evicts entries whose block has expired and which have no failures left in the window, keeping the rest", () => {
  const windowMs = 15 * 60_000;
  const t = 1_000_000;

  const entries = new Map<string, Entry>([
    // Dead: no active block, and its only failure is older than the window.
    ["dead-expired-failure", { failures: [t - windowMs - 1], blockedUntil: 0 }],
    // Dead: block already expired, and no failures recorded at all.
    ["dead-block-expired", { failures: [], blockedUntil: t - 1 }],
    // Live: block still in effect, even though there are no failures on file.
    ["live-blocked", { failures: [], blockedUntil: t + 1 }],
    // Live: has a failure still inside the window.
    ["live-recent-failure", { failures: [t - 1], blockedUntil: 0 }],
    // Live: a mix of an out-of-window failure and a recent one. The entry
    // survives, and the stale failure is pruned away as a side effect.
    ["live-mixed-failures", { failures: [t - windowMs - 1, t - 10], blockedUntil: 0 }],
  ]);

  sweep(entries, { windowMs }, t);

  assert.deepEqual(
    [...entries.keys()].sort(),
    ["live-blocked", "live-mixed-failures", "live-recent-failure"],
  );
  assert.deepEqual(entries.get("live-mixed-failures")?.failures, [t - 10]);
});

test("check()'s over-limit branch reports a real, counting-down wait when blockMs < windowMs", () => {
  const clock = { t: 0 };
  const rl = makeRateLimiter({ limit: 5, windowMs: 15 * 60_000, blockMs: 5 * 60_000, now: () => clock.t });
  for (let i = 0; i < 5; i++) rl.fail("ip");

  // The 5-minute block has elapsed, but the 15-minute window has not, so the
  // failures are still all present and check() must report we're still blocked.
  clock.t += 5 * 60_000 + 1;
  const first = rl.check("ip");
  assert.equal(first.ok, false);
  const firstWait = first.ok === false ? first.retryAfterMs : -1;
  assert.ok(firstWait > 0 && firstWait <= 5 * 60_000, `expected a bounded positive wait, got ${firstWait}`);

  // Advance partway through that renewed block and confirm the reported wait
  // actually counts down instead of returning the same static blockMs forever.
  clock.t += 60_000;
  const second = rl.check("ip");
  assert.equal(second.ok, false);
  const secondWait = second.ok === false ? second.retryAfterMs : -1;
  assert.ok(secondWait < firstWait, `expected the wait to decrease: ${secondWait} vs ${firstWait}`);
});

test("interleaved check/fail matches the real login-handler call pattern", () => {
  const clock = { t: 0 };
  const rl = limiterAt(clock);
  for (let i = 0; i < 5; i++) {
    const res = rl.check("ip");
    assert.equal(res.ok, true, `attempt ${i + 1} should have been admitted`);
    rl.fail("ip");
  }
  const sixth = rl.check("ip");
  assert.equal(sixth.ok, false, "the sixth attempt should be refused");
});
