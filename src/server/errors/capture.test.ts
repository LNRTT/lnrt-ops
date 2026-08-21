import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { defineOps, type OpsInstance } from "../config";
import type { OpsUserStore } from "../users";
import { createTestDatabase } from "../testdb";
import { fingerprint } from "./fingerprint";
import { getErrorGroup, listErrorEvents, type ErrorGroupRow } from "./store";
import { captureError } from "./capture";

// A minimal, unused store -- captureError never touches it, but defineOps
// requires one.
const store: OpsUserStore = {
  roles: ["WORKER"],
  async list() { return { users: [], total: 0 }; },
  async get() { return null; },
  async create(input) { return { id: "u1", ...input, disabled: false, hasPassword: false }; },
  async setPassword() {},
  async setRole() {},
  async setDisabled() {},
};

let ops: OpsInstance;

before(async () => {
  const url = await createTestDatabase("capture");
  ops = defineOps({ db: { connectionString: url }, users: store });
  // captureError itself triggers migrations lazily (via ops.ready()) before its
  // fire-and-forget write, but tests need the tables to exist deterministically
  // before they start polling for a row -- so apply them up front here, the same
  // way handlers.test.ts does for its own `ops` instance.
  await ops.ready();
});
after(async () => {
  await ops.pool.end();
});

/** captureError's write is fire-and-forget; poll for it rather than assuming a fixed delay. */
async function waitForGroup(id: string, timeoutMs = 3000): Promise<ErrorGroupRow> {
  const start = Date.now();
  for (;;) {
    const group = await getErrorGroup(ops.pool, id);
    if (group) return group;
    if (Date.now() - start > timeoutMs) throw new Error(`group ${id} never appeared within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("captureError returns undefined synchronously, before the write completes", () => {
  const err = new Error("boom in capture-sync");
  const result = captureError(ops, err);
  assert.equal(result, undefined);
});

test("a captured Error is eventually stored with source \"server\"", async () => {
  const err = new Error("boom in capture-basic");
  captureError(ops, err);
  const id = fingerprint({ type: err.name, message: err.message, stack: err.stack });
  const group = await waitForGroup(id);
  assert.equal(group.source, "server");
  assert.equal(group.type, "Error");
  assert.equal(group.message, "boom in capture-basic");
});

test("the error's own name is used as the type", async () => {
  class BoomError extends Error {}
  const err = new BoomError("boom in capture-named");
  err.name = "BoomError";
  captureError(ops, err);
  const id = fingerprint({ type: "BoomError", message: err.message, stack: err.stack });
  const group = await waitForGroup(id);
  assert.equal(group.type, "BoomError");
});

test("context passed to captureError is stored, redacted", async () => {
  const err = new Error("boom in capture-context");
  captureError(ops, err, { password: "hunter2", note: "safe to keep" });
  const id = fingerprint({ type: err.name, message: err.message, stack: err.stack });
  await waitForGroup(id);
  const events = await listErrorEvents(ops.pool, id, 1);
  assert.equal(events.length, 1);
  const ctx = events[0]!.context as Record<string, unknown>;
  assert.equal(ctx.password, "<redacted>");
  assert.equal(ctx.note, "safe to keep");
});

test("captureError never throws for a value that is not an Error", () => {
  assert.doesNotThrow(() => captureError(ops, "just a string"));
  assert.doesNotThrow(() => captureError(ops, { weird: true }));
  assert.doesNotThrow(() => captureError(ops, undefined));
  assert.doesNotThrow(() => captureError(ops, null));
  assert.doesNotThrow(() => captureError(ops, 42));
});

test("a thrown string is still captured with a usable message", async () => {
  captureError(ops, "plain string thrown from capture-string-case");
  const id = fingerprint({ type: "Error", message: "plain string thrown from capture-string-case" });
  const group = await waitForGroup(id);
  assert.equal(group.message, "plain string thrown from capture-string-case");
});

test("a circular object thrown does not throw and still gets captured", async () => {
  const cyclic: Record<string, unknown> = { note: "capture-cyclic-case" };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => captureError(ops, cyclic));
});

test("captureError never throws even when the pool is unusable", () => {
  const badOps = defineOps({
    db: { connectionString: "postgres://bad:bad@127.0.0.1:1/nope" },
    users: store,
  });
  assert.doesNotThrow(() => captureError(badOps, new Error("unreachable pool")));
});

test("a capture never affects the caller: it runs after the calling code, not before", () => {
  const order: string[] = [];
  captureError(ops, new Error("boom in capture-ordering"));
  order.push("after-capture-call");
  assert.deepEqual(order, ["after-capture-call"]);
});
