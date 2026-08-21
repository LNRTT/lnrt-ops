import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { verifyCredentials } from "./gate";

// Temporary: proves the OPS_DEBUG_LOGIN diagnostic reports the shape of a
// rejected submission without ever printing it.
test("the login diagnostic tells a trailing space from a wrong value", async () => {
  const env = {
    OPS_ADMIN_EMAILS: "me@lnrt.cz",
    OPS_SECRET: "a-secret-at-least-32-characters-long!!",
    OPS_PASSWORD_HASH: bcrypt.hashSync("wUmZtRhLKrnGoTHb2cd4tzPq", 12),
    OPS_DEBUG_LOGIN: "1",
  };
  const lines: string[] = [];
  const real = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    assert.equal(await verifyCredentials("me@lnrt.cz", "wUmZtRhLKrnGoTHb2cd4tzPq", env), true);
    assert.equal(await verifyCredentials("me@lnrt.cz", "wUmZtRhLKrnGoTHb2cd4tzPq ", env), false);
    assert.equal(await verifyCredentials("me@lnrt.cz", "somethingElseEntirely", env), false);
  } finally {
    console.error = real;
  }
  assert.equal(lines.length, 2, "only the two rejections are reported");
  const trailing = JSON.parse(lines[0]!.slice(lines[0]!.indexOf("{")));
  assert.equal(trailing.chars, 25);
  assert.equal(trailing.charsAfterTrim, 24);
  assert.equal(trailing.trimmedWouldMatch, true, "a trailing space must be identifiable");
  const wrong = JSON.parse(lines[1]!.slice(lines[1]!.indexOf("{")));
  assert.equal(wrong.trimmedWouldMatch, false);
  assert.equal(lines.join(" ").includes("wUmZtRhLKrnGoTHb2cd4tzPq"), false, "never logs the value");
});
