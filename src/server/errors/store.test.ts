import { test, before, after, beforeEach } from "node:test";
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
  SUPPRESSED_GROUP_ID,
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
// The new-group budget in recordError() counts every group in the store
// with a recent first_seen, globally -- not scoped to one test. Without a
// clean slate, an earlier test's groups (all "within the last hour" by
// wall-clock construction) eat into a later test's budget and silently
// reroute its fingerprint into the synthetic suppression group instead of
// giving it its own, which then makes an unrelated assertion pass or fail
// for the wrong reason.
beforeEach(async () => {
  await pool.query("TRUNCATE ops_error_event, ops_error_group");
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

test("pruneErrors deletes only the old event, keeps the recent one, and decrements stored_count to match", async () => {
  const err = makeError("kilo");
  await recordError(pool, { ...err, requestId: "old" });
  await recordError(pool, { ...err, requestId: "recent" });
  const id = fingerprint(err);
  await pool.query(
    `UPDATE ops_error_event SET at = now() - interval '40 days' WHERE group_id = $1 AND request_id = $2`,
    [id, "old"],
  );

  const deleted = await pruneErrors(pool, 30);
  assert.equal(deleted, 1);

  const events = await listErrorEvents(pool, id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.requestId, "recent");

  const group = await getErrorGroup(pool, id);
  assert.ok(group, "the group survives pruning");
  assert.equal(group!.storedCount, 1, "stored_count reflects what actually remains");
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

// --- fix-pass-1 additions -------------------------------------------------

test("two concurrent captures of the same new fingerprint produce one group with event_count 2", async () => {
  const err = makeError("mike-concurrent");
  await Promise.all([recordError(pool, err), recordError(pool, err)]);
  const id = fingerprint(err);
  const group = await getErrorGroup(pool, id);
  assert.ok(group);
  assert.equal(group!.eventCount, 2);
  assert.equal(group!.storedCount, 2);
  const events = await listErrorEvents(pool, id);
  assert.equal(events.length, 2);
});

test("a burst of concurrent captures past the cap stores exactly 100 and counts them all", async () => {
  const err = makeError("november-burst");
  const BURST = 150;
  await Promise.all(Array.from({ length: BURST }, () => recordError(pool, err)));
  const id = fingerprint(err);
  const group = await getErrorGroup(pool, id);
  assert.ok(group);
  assert.equal(group!.eventCount, BURST);
  assert.equal(group!.storedCount, 100);

  const { rows } = await pool.query("SELECT count(*)::int AS c FROM ops_error_event WHERE group_id = $1", [id]);
  assert.equal(rows[0].c, 100);
});

test("a context with a bigint and a NUL byte is still recorded, with the event stored", async () => {
  const err = makeError("oscar", {
    context: { rows: 42n, note: "hello" + String.fromCharCode(0) + "world" },
  });
  await assert.doesNotReject(() => recordError(pool, err));
  const id = fingerprint(err);
  const group = await getErrorGroup(pool, id);
  assert.ok(group);
  assert.equal(group!.eventCount, 1);
  assert.equal(group!.storedCount, 1);

  const events = await listErrorEvents(pool, id);
  assert.equal(events.length, 1);
  const ctx = events[0]!.context as Record<string, unknown>;
  assert.equal(ctx.rows, "42");
  assert.equal((ctx.note as string).includes(String.fromCharCode(0)), false);
});

test("an oversized context is replaced rather than dropping the capture", async () => {
  const context: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) context[`field${i}`] = "y".repeat(2000);
  const err = makeError("papa", { context });
  await recordError(pool, err);
  const id = fingerprint(err);

  const events = await listErrorEvents(pool, id);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.context, { _dropped: "context too large" });
});

test("a URL with a query string is stored without it", async () => {
  const err = makeError("quebec", { url: "/reset?token=SECRET&x=1#frag" });
  await recordError(pool, err);
  const id = fingerprint(err);
  const events = await listErrorEvents(pool, id);
  assert.equal(events[0]!.url, "/reset");
  assert.equal(events[0]!.url!.includes("SECRET"), false);
});

test("recordError against an unreachable pool resolves rather than throwing", async () => {
  const badPool = new Pool({
    connectionString: "postgres://user:pass@127.0.0.1:1/nope",
    max: 1,
    connectionTimeoutMillis: 300,
  });
  try {
    await assert.doesNotReject(() => recordError(badPool, makeError("romeo")));
  } finally {
    await badPool.end();
  }
});

test("listErrorGroups filters combine to an intersection", async () => {
  const matchAll = makeError("sierra-match", { source: "browser", userId: "u-99" });
  const wrongSource = makeError("sierra-wrong-source", { source: "server", userId: "u-99" });
  const wrongUser = makeError("sierra-wrong-user", { source: "browser", userId: "u-100" });
  await recordError(pool, matchAll);
  await recordError(pool, wrongSource);
  await recordError(pool, wrongUser);
  const matchId = fingerprint(matchAll);
  const wrongSourceId = fingerprint(wrongSource);
  const wrongUserId = fingerprint(wrongUser);

  const results = await listErrorGroups(pool, {
    status: "open",
    source: "browser",
    since: new Date(Date.now() - 60_000),
    userId: "u-99",
  });
  assert.ok(results.some((g) => g.id === matchId));
  assert.ok(!results.some((g) => g.id === wrongSourceId));
  assert.ok(!results.some((g) => g.id === wrongUserId));
});

test("a header line ending in :N:N is not mistaken for a stack frame", async () => {
  const err = makeError("tango", {
    stack: "Error: failed to parse config.yaml:12:3\n    at parseConfig (/app/src/lib/configLoader.ts:9:5)",
  });
  await recordError(pool, err);
  const id = fingerprint(err);
  const group = await getErrorGroup(pool, id);
  assert.ok(group);
  assert.equal(group!.culprit.includes("config.yaml"), false);
  assert.ok(group!.culprit.includes("configLoader.ts"), `got culprit: ${group!.culprit}`);
});

test("source stays at its first-seen value even when a later capture reports a different source", async () => {
  const err = makeError("uniform", { source: "server" });
  await recordError(pool, err);
  await recordError(pool, { ...err, source: "browser" });
  const id = fingerprint(err);
  const group = await getErrorGroup(pool, id);
  assert.equal(group!.source, "server");
});

// --- security review fix pass -------------------------------------------

test("an oversized type is stored truncated, with the NUL stripped", async () => {
  const err = makeError("victor", {
    type: "T".repeat(500) + String.fromCharCode(0) + "extra",
  });
  await recordError(pool, err);
  const id = fingerprint(err);
  const group = await getErrorGroup(pool, id);
  assert.ok(group);
  assert.equal(group!.type.length, 200);
  assert.equal(group!.type.includes(String.fromCharCode(0)), false);
});

test("an oversized culprit (from a very long stack frame path) is stored truncated", async () => {
  const longPath = "a".repeat(1000);
  const err = makeError("whiskey", {
    stack: `TypeError: boom\n    at save (/app/src/lib/${longPath}.ts:44:9)`,
  });
  await recordError(pool, err);
  const id = fingerprint(err);
  const group = await getErrorGroup(pool, id);
  assert.ok(group);
  assert.ok(group!.culprit.length <= 500, `expected culprit <= 500 chars, got ${group!.culprit.length}`);
});

test("a javascript: URL is rejected and stored as absent, not written into the row", async () => {
  const err = makeError("xray", { url: "javascript:alert(document.cookie)" });
  await recordError(pool, err);
  const id = fingerprint(err);
  const events = await listErrorEvents(pool, id);
  assert.equal(events[0]!.url, undefined);
});

test("an http(s) URL is still stored normally", async () => {
  const err = makeError("yankee", { url: "https://app.test/some/page?x=1" });
  await recordError(pool, err);
  const id = fingerprint(err);
  const events = await listErrorEvents(pool, id);
  assert.equal(events[0]!.url, "https://app.test/some/page");
});

test("a relative URL with no scheme is still stored, just with its query stripped", async () => {
  const err = makeError("zulu", { url: "/dashboard?secret=1" });
  await recordError(pool, err);
  const id = fingerprint(err);
  const events = await listErrorEvents(pool, id);
  assert.equal(events[0]!.url, "/dashboard");
});

test("context.filename keeps its query string stripped, same as the top-level url", async () => {
  const err = makeError("alpha-two", { context: { filename: "https://app.test/app.js?v=abc123#frag" } });
  await recordError(pool, err);
  const id = fingerprint(err);
  const events = await listErrorEvents(pool, id);
  const ctx = events[0]!.context as Record<string, unknown>;
  assert.equal(ctx.filename, "https://app.test/app.js");
});

test("60 distinct new fingerprints in one hour produce 50 real groups plus one synthetic suppression group", async () => {
  const groupIds: string[] = [];
  for (let i = 0; i < 60; i++) {
    const err = makeError(`bravo-two-budget-${i}`);
    await recordError(pool, err);
    groupIds.push(fingerprint(err));
  }

  let realGroups = 0;
  for (const id of groupIds) {
    const group = await getErrorGroup(pool, id);
    if (group) realGroups++;
  }
  assert.equal(realGroups, 50, "only the first 50 previously-unseen fingerprints should get their own group");

  const suppressed = await getErrorGroup(pool, SUPPRESSED_GROUP_ID);
  assert.ok(suppressed, "the remaining 10 fingerprints must be recorded against the synthetic suppression group");
  assert.equal(suppressed!.eventCount, 10);
  assert.match(suppressed!.message, /suppress/i);
});

test("once an existing group is over budget, a repeat of the SAME fingerprint still updates its own group, not the synthetic one", async () => {
  // Burn the whole new-group budget on fresh fingerprints first.
  let last: CapturedError | undefined;
  for (let i = 0; i < 50; i++) {
    const err = makeError(`charlie-two-budget-${i}`);
    await recordError(pool, err);
    last = err;
  }
  // A brand new 51st fingerprint should be suppressed...
  const newErr = makeError("charlie-two-budget-new");
  await recordError(pool, newErr);
  const newId = fingerprint(newErr);
  assert.equal(await getErrorGroup(pool, newId), null);

  // ...but repeating one of the 50 already-admitted fingerprints must still
  // land on its own existing group, not get swept into the synthetic one.
  await recordError(pool, last!);
  const lastId = fingerprint(last!);
  const group = await getErrorGroup(pool, lastId);
  assert.ok(group);
  assert.equal(group!.eventCount, 2);
});

test("pruneErrors removes a group that has no remaining events and has not been seen within the window", async () => {
  const err = makeError("delta-two-stale");
  await recordError(pool, err);
  const id = fingerprint(err);

  // Age both the event (so the event-prune deletes it) and the group's own
  // last_seen (so it counts as stale, not merely empty).
  await pool.query(`UPDATE ops_error_event SET at = now() - interval '40 days' WHERE group_id = $1`, [id]);
  await pool.query(`UPDATE ops_error_group SET last_seen = now() - interval '40 days' WHERE id = $1`, [id]);

  await pruneErrors(pool, 30);

  assert.equal(await getErrorGroup(pool, id), null, "a stale, now-empty group must be removed");
});

test("pruneErrors keeps a group with no remaining events if it was seen recently", async () => {
  const err = makeError("echo-two-fresh-empty");
  await recordError(pool, err);
  const id = fingerprint(err);

  // Age only the event, not the group's last_seen.
  await pool.query(`UPDATE ops_error_event SET at = now() - interval '40 days' WHERE group_id = $1`, [id]);

  await pruneErrors(pool, 30);

  const group = await getErrorGroup(pool, id);
  assert.ok(group, "a group seen recently must survive even once its events have all aged out");
});
