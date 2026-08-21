import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRateLimiter } from "./ratelimit";

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
