import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCookie, serializeCookie } from "./cookies";

test("a malformed percent-escape does not throw and falls back to the raw value", () => {
  assert.doesNotThrow(() => parseCookie("lnrt_ops=%; other=1", "lnrt_ops"));
  assert.equal(parseCookie("lnrt_ops=%; other=1", "lnrt_ops"), "%");
});

test("a value containing '=' round-trips", () => {
  assert.equal(parseCookie("a=b=c", "a"), "b=c");
});

test("duplicate cookie names return the first match", () => {
  assert.equal(parseCookie("a=1; a=2", "a"), "1");
});

test("a value containing ';' round-trips through serializeCookie/parseCookie", () => {
  const header = serializeCookie("x", "a;b", {});
  assert.equal(parseCookie(header, "x"), "a;b");
});

test("serializeCookie throws when the name carries an injected attribute", () => {
  assert.throws(() => serializeCookie("lnrt_ops; evil=1", "v", {}));
});

test("serializeCookie throws when path or sameSite carry CR/LF or ';'", () => {
  assert.throws(() => serializeCookie("x", "v", { path: "/ops\r\nSet-Cookie: evil=1" }));
  assert.throws(() => serializeCookie("x", "v", { sameSite: "strict; evil=1" }));
});

test("serializeCookie throws when maxAge is not an integer", () => {
  assert.throws(() => serializeCookie("x", "v", { maxAge: 1.5 }));
});
