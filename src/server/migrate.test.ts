import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { migrate, pendingMigrations, type Migration } from "./migrate";
import { createTestDatabase } from "./testdb";

let pool: Pool;
const FIXTURES: Migration[] = [
  { id: "t001", sql: "CREATE TABLE ops_probe (id int PRIMARY KEY)" },
  { id: "t002", sql: "ALTER TABLE ops_probe ADD COLUMN label text" },
];

before(async () => {
  // Own database, created empty — no cleanup preamble needed.
  pool = new Pool({ connectionString: await createTestDatabase("migrate") });
});
after(async () => { await pool.end(); });

test("applies every migration once and reports which ran", async () => {
  const applied = await migrate(pool, FIXTURES);
  assert.deepEqual(applied, ["t001", "t002"]);
  const { rows } = await pool.query("SELECT label FROM ops_probe");
  assert.equal(rows.length, 0);
});

test("is idempotent on a second run", async () => {
  const applied = await migrate(pool, FIXTURES);
  assert.deepEqual(applied, []);
});

test("reports pending ids without applying them", async () => {
  const withNew = [...FIXTURES, { id: "t003", sql: "SELECT 1" }];
  assert.deepEqual(await pendingMigrations(pool, withNew), ["t003"]);
  assert.deepEqual(await pendingMigrations(pool, FIXTURES), []);
});

test("concurrent runs do not double-apply", async () => {
  await pool.query("DROP TABLE IF EXISTS ops_probe; DELETE FROM ops_migration");
  const results = await Promise.all([migrate(pool, FIXTURES), migrate(pool, FIXTURES)]);
  const total = results.flat().length;
  assert.equal(total, 2, "each migration must be applied exactly once across both callers");
});

test("a failing migration rolls back and leaves it pending", async () => {
  const bad: Migration[] = [{ id: "t900", sql: "CREATE TABLE ops_bad (id int); SELECT nonexistent_fn()" }];
  await assert.rejects(() => migrate(pool, bad));
  assert.deepEqual(await pendingMigrations(pool, bad), ["t900"]);
  const { rows } = await pool.query(
    "SELECT to_regclass('ops_bad') AS t");
  assert.equal(rows[0].t, null, "the partial DDL must have been rolled back");
});

test("advisory lock is released after a failing migration, so a later run can still proceed", async () => {
  await pool.query("DROP TABLE IF EXISTS ops_probe; DELETE FROM ops_migration");
  const bad: Migration[] = [{ id: "t901", sql: "SELECT nonexistent_fn()" }];
  await assert.rejects(() => migrate(pool, bad));

  // pg_advisory_lock is session-reentrant: the *same* connection could re-acquire
  // its own lock even if we never released it, so this only proves anything because
  // the pool may hand the next call a different connection. It's a regression guard
  // for the release path, not a proof the lock itself is gone.
  const applied = await migrate(pool, FIXTURES);
  assert.deepEqual(applied, ["t001", "t002"]);
});
