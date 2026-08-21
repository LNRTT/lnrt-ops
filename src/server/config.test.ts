import { test, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { defineOps } from "./config";
import type { OpsUserStore } from "./users";

import { createTestDatabase } from "./testdb";

const URL = await createTestDatabase("config");
const users: OpsUserStore = {
  roles: ["ADMIN"],
  async list() { return { users: [], total: 0 }; },
  async get() { return null; },
  async create() { throw new Error("unused"); },
  async setPassword() {}, async setRole() {}, async setDisabled() {},
};

const ops = defineOps({ db: { connectionString: URL }, users });
after(async () => { await ops.pool.end(); });

test("ready() migrates and is safe to call repeatedly", async () => {
  await ops.ready();
  await ops.ready();
  const { rows } = await ops.pool.query("SELECT to_regclass('ops_audit_log') AS t");
  assert.notEqual(rows[0].t, null);
});

test("enabled() follows the gate configuration", () => {
  const saved = { ...process.env };
  delete process.env.OPS_PASSWORD_HASH;
  assert.equal(ops.enabled(), false);
  // The gate validates shape, not just presence: a real bcrypt hash and a
  // secret of at least 32 characters are required.
  process.env.OPS_PASSWORD_HASH = bcrypt.hashSync("x", 10);
  process.env.OPS_ADMIN_EMAILS = "me@lnrt.cz";
  process.env.OPS_SECRET = "a-secret-at-least-32-characters-long!!";
  assert.equal(ops.enabled(), true);
  process.env = saved;
});

test("checks() always includes the built-ins and appends custom ones", () => {
  const custom = { id: "storage", label: "Storage", run: async () => ({ status: "ok" as const }) };
  const withCustom = defineOps({ db: { connectionString: URL }, users, health: [custom] });
  const ids = withCustom.checks().map((c) => c.id);
  assert.deepEqual(ids.slice(0, 4), ["db", "env", "build", "migrations"]);
  assert.ok(ids.includes("storage"));
});

test("a failed migration is remembered so ready() surfaces it every time", async () => {
  const broken = defineOps({ db: { connectionString: "postgres://nobody@127.0.0.1:1/none" }, users });
  await assert.rejects(() => broken.ready());
  await assert.rejects(() => broken.ready(), "must not cache a rejected promise as success");
  await broken.pool.end().catch(() => {});
});
