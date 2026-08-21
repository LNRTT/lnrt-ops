import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { migrate } from "../migrate";
import { ALL_MIGRATIONS } from "../migrations/index";
import { createTestDatabase } from "../testdb";
import { fingerprint } from "./fingerprint";
import {
  recordError,
  listErrorGroups,
  getErrorGroup,
  listErrorEvents,
  setErrorGroupStatus,
  pruneErrors,
  type CapturedError,
} from "./store";

let pool: Pool;

before(async () => {
  pool = new Pool({ connectionString: await createTestDatabase("errors") });
  await migrate(pool, ALL_MIGRATIONS);
});
after(async () => {
  await pool.end();
});

// `label` drives both the message and the stack frame's filename, so each
// caller gets its own fingerprint unless it deliberately reuses the same
// CapturedError. Digits are avoided in the message text because
// normalizeMessage replaces numbers with a placeholder — two labels that
// differ only by digit would collide onto the same group.
function makeError(label: string, overrides: Partial<CapturedError> = {}): CapturedError {
  return {
    type: "TypeError",
    message: `boom in ${label}`,
    stack: `TypeError: boom\n    at save (/app/src/lib/${label}.ts:44:9)`,
    source: "server",
    ...overrides,
  };
}

test("a first error creates a group with count 1", async () => {
  const err = makeError("alpha");
  await recordError(pool, err);
  const id = fingerprint(err);
  const group = await getErrorGroup(pool, id);
  assert.ok(group);
  assert.equal(group!.eventCount, 1);
  assert.equal(group!.storedCount, 1);
  assert.equal(group!.status, "open");
  assert.equal(group!.type, "TypeError");
});

test("the same error twice shares one group with count 2 and two events", async () => {
  const err = makeError("bravo");
  await recordError(pool, err);
  await recordError(pool, err);
  const id = fingerprint(err);
  const group = await getErrorGroup(pool, id);
  assert.equal(group!.eventCount, 2);
  assert.equal(group!.storedCount, 2);
  const events = await listErrorEvents(pool, id);
  assert.equal(events.length, 2);
});

test("a different error makes a second group", async () => {
  const a = makeError("charlie-a");
  const b = makeError("charlie-b", { type: "RangeError" });
  await recordError(pool, a);
  await recordError(pool, b);
  const idA = fingerprint(a);
  const idB = fingerprint(b);
  assert.notEqual(idA, idB);
  const groupA = await getErrorGroup(pool, idA);
  const groupB = await getErrorGroup(pool, idB);
  assert.ok(groupA);
  assert.ok(groupB);
  assert.equal(groupA!.eventCount, 1);
  assert.equal(groupB!.eventCount, 1);
});

test("a resolved group reopens when the error recurs", async () => {
  const err = makeError("delta");
  await recordError(pool, err);
  const id = fingerprint(err);
  await setErrorGroupStatus(pool, id, "resolved");
  let group = await getErrorGroup(pool, id);
  assert.equal(group!.status, "resolved");

  await recordError(pool, err);
  group = await getErrorGroup(pool, id);
  assert.equal(group!.status, "open");
  assert.equal(group!.eventCount, 2);
});

test("the hourly cap stops storing events while event_count keeps rising", async () => {
  const err = makeError("echo");
  const id = fingerprint(err);
  for (let i = 0; i < 105; i++) {
    await recordError(pool, err);
  }
  const group = await getErrorGroup(pool, id);
  assert.equal(group!.eventCount, 105);
  assert.equal(group!.storedCount, 100);

  const { rows } = await pool.query("SELECT count(*)::int AS c FROM ops_error_event WHERE group_id = $1", [id]);
  assert.equal(rows[0].c, 100);
});

test("listErrorGroups filters by status", async () => {
  const err = makeError("foxtrot");
  await recordError(pool, err);
  const id = fingerprint(err);
  await setErrorGroupStatus(pool, id, "ignored");

  const ignored = await listErrorGroups(pool, { status: "ignored" });
  assert.ok(ignored.some((g) => g.id === id));
  const open = await listErrorGroups(pool, { status: "open" });
  assert.ok(!open.some((g) => g.id === id));
});

test("listErrorGroups filters by source", async () => {
  const err = makeError("golf", { source: "browser" });
  await recordError(pool, err);
  const id = fingerprint(err);

  const browserGroups = await listErrorGroups(pool, { source: "browser" });
  assert.ok(browserGroups.some((g) => g.id === id));
  const serverGroups = await listErrorGroups(pool, { source: "server" });
  assert.ok(!serverGroups.some((g) => g.id === id));
});

test("listErrorGroups filters by since", async () => {
  const err = makeError("hotel-since");
  await recordError(pool, err);
  const id = fingerprint(err);

  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);
  const afterFuture = await listErrorGroups(pool, { since: future });
  const afterPast = await listErrorGroups(pool, { since: past });
  assert.ok(!afterFuture.some((g) => g.id === id));
  assert.ok(afterPast.some((g) => g.id === id));
});

test("listErrorGroups filters by userId", async () => {
  const err = makeError("india", { userId: "u-42" });
  await recordError(pool, err);
  const id = fingerprint(err);

  const forUser = await listErrorGroups(pool, { userId: "u-42" });
  assert.ok(forUser.some((g) => g.id === id));
  const forOtherUser = await listErrorGroups(pool, { userId: "u-does-not-exist" });
  assert.ok(!forOtherUser.some((g) => g.id === id));
});

test("listErrorEvents returns newest first", async () => {
  const err = makeError("juliett");
  const id = fingerprint(err);
  await recordError(pool, { ...err, requestId: "r1" });
  await recordError(pool, { ...err, requestId: "r2" });
  await recordError(pool, { ...err, requestId: "r3" });

  const events = await listErrorEvents(pool, id);
  assert.deepEqual(
    events.slice(0, 3).map((e) => e.requestId),
    ["r3", "r2", "r1"],
  );
});

test("pruneErrors deletes events older than N days and keeps the groups", async () => {
  const err = makeError("kilo");
  await recordError(pool, err);
  const id = fingerprint(err);
  await pool.query(`UPDATE ops_error_event SET at = now() - interval '40 days' WHERE group_id = $1`, [id]);

  const deleted = await pruneErrors(pool, 30);
  assert.ok(deleted >= 1);

  const events = await listErrorEvents(pool, id);
  assert.equal(events.length, 0);
  const group = await getErrorGroup(pool, id);
  assert.ok(group, "the group survives pruning");
});

test("context is redacted on the way in and cookies never land in the row", async () => {
  const err = makeError("lima", {
    context: { cookie: "session=abc123", password: "hunter2", userId: "u-1", note: "safe" },
  });
  await recordError(pool, err);
  const id = fingerprint(err);

  const events = await listErrorEvents(pool, id);
  const flat = JSON.stringify(events[0]!.context);
  assert.equal(flat.includes("abc123"), false);
  assert.equal(flat.includes("hunter2"), false);
  assert.equal((events[0]!.context as Record<string, unknown>).userId, "u-1");
  assert.equal((events[0]!.context as Record<string, unknown>).note, "safe");

  // Check the row directly too, in case the mapper hides what the DB actually stored.
  const raw = await pool.query("SELECT context FROM ops_error_event WHERE group_id = $1", [id]);
  const rawFlat = JSON.stringify(raw.rows[0].context);
  assert.equal(rawFlat.includes("abc123"), false);
  assert.equal(rawFlat.includes("hunter2"), false);
});
