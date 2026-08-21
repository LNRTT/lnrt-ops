import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { opsEnabled, isAllowedEmail, verifyCredentials } from "./gate";

const HASH = bcrypt.hashSync("correct horse", 10);
const ENV = { OPS_ADMIN_EMAILS: "me@lnrt.cz, Other@LNRT.cz", OPS_PASSWORD_HASH: HASH, OPS_SECRET: "s" };

test("is disabled unless all three variables are present", () => {
  assert.equal(opsEnabled(ENV), true);
  assert.equal(opsEnabled({ ...ENV, OPS_PASSWORD_HASH: undefined }), false);
  assert.equal(opsEnabled({ ...ENV, OPS_ADMIN_EMAILS: undefined }), false);
  assert.equal(opsEnabled({ ...ENV, OPS_SECRET: undefined }), false);
  assert.equal(opsEnabled({ ...ENV, OPS_ADMIN_EMAILS: "   " }), false);
});

test("matches allowed emails case-insensitively and ignores whitespace", () => {
  assert.equal(isAllowedEmail("ME@lnrt.cz", ENV), true);
  assert.equal(isAllowedEmail("other@lnrt.cz", ENV), true);
  assert.equal(isAllowedEmail("someone@else.cz", ENV), false);
});

test("accepts the right password from an allowed email", async () => {
  assert.equal(await verifyCredentials("me@lnrt.cz", "correct horse", ENV), true);
});

test("rejects a wrong password and an unlisted email", async () => {
  assert.equal(await verifyCredentials("me@lnrt.cz", "wrong", ENV), false);
  assert.equal(await verifyCredentials("someone@else.cz", "correct horse", ENV), false);
});

test("does an equal amount of work for a listed and an unlisted email", async () => {
  // Guards against turning the email list into a user enumeration oracle.
  const time = async (fn: () => Promise<unknown>) => {
    const t0 = process.hrtime.bigint(); await fn();
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  const listed = await time(() => verifyCredentials("me@lnrt.cz", "wrong", ENV));
  const unlisted = await time(() => verifyCredentials("nope@else.cz", "wrong", ENV));
  const ratio = Math.max(listed, unlisted) / Math.max(1, Math.min(listed, unlisted));
  assert.ok(ratio < 3, `bcrypt must run in both paths (ratio ${ratio.toFixed(2)})`);
});

test("returns false rather than throwing when disabled", async () => {
  assert.equal(await verifyCredentials("me@lnrt.cz", "correct horse", {}), false);
});
