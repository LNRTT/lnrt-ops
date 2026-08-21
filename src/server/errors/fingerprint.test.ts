import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, normalizeMessage } from "./fingerprint";
import { redactContext } from "./redact";

test("normalising strips the parts that differ between identical bugs", () => {
  assert.equal(
    normalizeMessage("No user 7b3f4a9c-1d2e-4f5a-8b6c-9d0e1f2a3b4c in project 4821"),
    normalizeMessage("No user 0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d in project 99"),
  );
  assert.equal(normalizeMessage('Cannot read "foo" of null'), normalizeMessage('Cannot read "bar" of null'));
});

test("the same bug from two requests shares a fingerprint", () => {
  const a = { type: "TypeError", message: "x of undefined at row 12", stack: "TypeError\n    at save (/app/src/lib/purchases.ts:44:9)" };
  const b = { type: "TypeError", message: "x of undefined at row 87", stack: "TypeError\n    at save (/app/src/lib/purchases.ts:44:9)" };
  assert.equal(fingerprint(a), fingerprint(b));
});

test("different bugs do not collide", () => {
  const a = { type: "TypeError", message: "boom", stack: "at save (/app/src/a.ts:1:1)" };
  assert.notEqual(fingerprint(a), fingerprint({ ...a, type: "RangeError" }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, stack: "at save (/app/src/b.ts:1:1)" }));
});

test("the frame chosen is the first that is not a dependency", () => {
  const stack = [
    "Error: nope",
    "    at inner (/app/node_modules/pg/lib/client.js:1:1)",
    "    at query (/app/node_modules/pg/lib/pool.js:2:2)",
    "    at loadPurchases (/app/src/lib/purchases.server.ts:31:7)",
  ].join("\n");
  const other = stack.replace("/app/node_modules/pg/lib/client.js:1:1", "/app/node_modules/pg/lib/other.js:9:9");
  assert.equal(fingerprint({ type: "Error", message: "nope", stack }),
               fingerprint({ type: "Error", message: "nope", stack: other }));
});

test("an error with no usable stack still groups by type and message", () => {
  const f = fingerprint({ type: "Error", message: "plain" });
  assert.equal(typeof f, "string");
  assert.equal(f, fingerprint({ type: "Error", message: "plain", stack: "" }));
});

test("redaction removes anything that looks like a credential", () => {
  const out = redactContext({
    userId: "u1",
    password: "hunter2",
    apiToken: "abc",
    SESSION_SECRET: "s",
    "x-api-key": "k",
    nested: { refreshToken: "r", safe: 1 },
    cookie: "a=b",
    authorization: "Bearer x",
  });
  const flat = JSON.stringify(out);
  for (const leaked of ["hunter2", "abc", "\"s\"", "\"k\"", "\"r\"", "a=b", "Bearer x"]) {
    assert.equal(flat.includes(leaked), false, `leaked ${leaked}`);
  }
  assert.equal(out.userId, "u1");
  assert.equal((out.nested as Record<string, unknown>).safe, 1);
});

test("redaction survives cycles and does not explode on depth", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => redactContext(cyclic));
});
