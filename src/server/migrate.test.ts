import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { migrate, pendingMigrations, type Migration } from "./migrate.ts";

const URL = process.env.OPS_TEST_DATABASE_URL;
if (!URL) throw new Error("OPS_TEST_DATABASE_URL is not set — see the plan's Global Constraints");

let pool: Pool;
const FIXTURES: Migration[] = [
  { id: "t001", sql: "CREATE TABLE ops_probe (id int PRIMARY KEY)" },
  { id: "t002", sql: "ALTER TABLE ops_probe ADD COLUMN label text" },
];

before(async () => {
  pool = new Pool({ connectionString: URL });
  await pool.query("DROP TABLE IF EXISTS ops_probe; DROP TABLE IF EXISTS ops_migration");
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
