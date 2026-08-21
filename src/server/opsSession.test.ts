import { test } from "node:test";
import assert from "node:assert/strict";
import { signOpsToken, verifyOpsToken, opsCookieAttrs, OPS_COOKIE } from "./opsSession";

const SECRET = "a-secret-at-least-32-characters-long!!";

test("round-trips an email", async () => {
  const token = await signOpsToken("me@lnrt.cz", SECRET);
  assert.deepEqual(await verifyOpsToken(token, SECRET), { email: "me@lnrt.cz" });
});

test("rejects a token signed with another secret", async () => {
  const token = await signOpsToken("me@lnrt.cz", SECRET);
  assert.equal(await verifyOpsToken(token, "different-secret-that-is-long-enough!"), null);
});

test("rejects tampered, empty and missing tokens", async () => {
  const token = await signOpsToken("me@lnrt.cz", SECRET);
  assert.equal(await verifyOpsToken(token.slice(0, -3) + "aaa", SECRET), null);
  assert.equal(await verifyOpsToken("", SECRET), null);
  assert.equal(await verifyOpsToken(undefined, SECRET), null);
});

test("rejects an expired token", async () => {
  const token = await signOpsToken("me@lnrt.cz", SECRET, -1);
  assert.equal(await verifyOpsToken(token, SECRET), null);
});

test("cookie is scoped to /ops and locked down", () => {
  const a = opsCookieAttrs(8 * 3600);
  assert.equal(OPS_COOKIE, "lnrt_ops");
  assert.equal(a.httpOnly, true);
  assert.equal(a.sameSite, "strict");
  assert.equal(a.path, "/ops");
  assert.equal(a.maxAge, 8 * 3600);
});
