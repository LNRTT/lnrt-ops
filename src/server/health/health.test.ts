import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { runChecks, type Check } from "./index";
import { checkDb, checkEnv, checkBuild, checkMigrations } from "./checks";

import { createTestDatabase } from "../testdb";

let pool: Pool;
before(async () => { pool = new Pool({ connectionString: await createTestDatabase("health") }); });
after(async () => { await pool.end(); });

test("runs every check and times each one", async () => {
  const checks: Check[] = [
    { id: "a", label: "A", run: async () => ({ status: "ok" }) },
    { id: "b", label: "B", run: async () => ({ status: "warn", detail: "slow" }) },
  ];
  const results = await runChecks(checks, { pool });
  assert.deepEqual(results.map((r) => [r.id, r.status]), [["a", "ok"], ["b", "warn"]]);
  assert.ok(results.every((r) => typeof r.durationMs === "number"));
  assert.equal(results[1]!.detail, "slow");
});

test("a throwing check fails on its own without taking the others down", async () => {
  const checks: Check[] = [
    { id: "boom", label: "Boom", run: async () => { throw new Error("nope"); } },
    { id: "fine", label: "Fine", run: async () => ({ status: "ok" }) },
  ];
  const results = await runChecks(checks, { pool });
  assert.equal(results[0]!.status, "fail");
  assert.match(results[0]!.detail!, /nope/);
  assert.equal(results[1]!.status, "ok");
});

test("a hanging check fails on timeout without blocking the others", async () => {
  const checks: Check[] = [
    { id: "hang", label: "Hang", run: () => new Promise(() => {}) },
    { id: "fine", label: "Fine", run: async () => ({ status: "ok" }) },
  ];
  const results = await runChecks(checks, { pool }, 50);
  assert.equal(results[0]!.status, "fail");
  assert.match(results[0]!.detail!, /timed out/i);
  assert.equal(results[1]!.status, "ok", "a hanging check must not take its neighbours with it");
});

test("the database check reports ok with a latency detail", async () => {
  const [r] = await runChecks([checkDb()], { pool });
  assert.equal(r!.status, "ok");
  assert.match(r!.detail!, /\d+ ?ms/);
});

test("the database check actually queries the database", async () => {
  // Without this, an implementation that fabricated "ok, 1 ms" without ever
  // touching the pool would pass the assertion above.
  const asked: string[] = [];
  const spy = {
    query: async (sql: string) => { asked.push(sql); return { rows: [{ "?column?": 1 }] }; },
  } as unknown as Pool;
  const [r] = await runChecks([checkDb()], { pool: spy });
  assert.equal(r!.status, "ok");
  assert.deepEqual(asked, ["SELECT 1"]);
});

test("the database check fails when the database is unreachable", async () => {
  const dead = new Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none", max: 1 });
  try {
    const [r] = await runChecks([checkDb()], { pool: dead });
    assert.equal(r!.status, "fail");
  } finally {
    await dead.end().catch(() => {});
  }
});

test("the env check names missing variables and never reveals values", async () => {
  process.env.OPS_HEALTH_PROBE = "super-secret-value";
  const [r] = await runChecks([checkEnv(["OPS_HEALTH_PROBE", "OPS_DEFINITELY_MISSING"])], { pool });
  assert.equal(r!.status, "fail");
  assert.match(r!.detail!, /OPS_DEFINITELY_MISSING/);
  assert.equal(r!.detail!.includes("super-secret-value"), false);
  delete process.env.OPS_HEALTH_PROBE;
});

test("the env check passes when everything is present", async () => {
  process.env.OPS_HEALTH_PROBE = "x";
  const [r] = await runChecks([checkEnv(["OPS_HEALTH_PROBE"])], { pool });
  assert.equal(r!.status, "ok");
  delete process.env.OPS_HEALTH_PROBE;
});

test("the build check reports the release and node version", async () => {
  process.env.OPS_RELEASE = "abc1234";
  const [r] = await runChecks([checkBuild()], { pool });
  assert.equal(r!.status, "ok");
  assert.match(r!.detail!, /abc1234/);
  assert.match(r!.detail!, /v\d+\./);
  delete process.env.OPS_RELEASE;
});

test("the migration check fails when the host reports pending migrations", async () => {
  const [r] = await runChecks([checkMigrations(async () => ["20260101_add_thing"])], { pool });
  assert.equal(r!.status, "fail");
  assert.match(r!.detail!, /20260101_add_thing/);
});
