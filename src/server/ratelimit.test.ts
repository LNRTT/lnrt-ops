import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRateLimiter, __entryCount } from "./ratelimit";

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

test("evicts dead entries during fail() sweeps, keeping memory bounded", () => {
  const clock = { t: 0 };
  const rl = limiterAt(clock);

  // Simulate a credential-stuffing bot rotating through many source IPs, each
  // failing once (never reaching the block threshold).
  const ROTATED_IPS = 50;
  for (let i = 0; i < ROTATED_IPS; i++) rl.fail(`ip-${i}`);
  assert.equal(__entryCount(rl), ROTATED_IPS);

  // Move the clock past the window (and block) so every existing entry is now
  // "dead": no failures left inside the window, and no active block.
  clock.t += 15 * 60_000 + 1;

  // Drive enough fail() calls (on a fresh key, so we don't resurrect any of the
  // old entries) to cross the sweep trigger at least once.
  for (let i = 0; i < 1000; i++) rl.fail("sweeper");

  // All ROTATED_IPS dead entries should have been evicted; only "sweeper" is left.
  assert.equal(__entryCount(rl), 1, `expected the map to shrink to just the live key`);
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
