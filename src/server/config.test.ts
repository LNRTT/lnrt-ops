import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
// Aliased: the module-level `URL` constant below (a connection string) shadows
// the global URL constructor for the rest of this file.
import { URL as NodeURL } from "node:url";
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

test("login links accept a relative route and an optional public origin", () => {
  for (const origin of [undefined, "https://dochazka.lnrt.cz", "https://dochazka-preview.lnrtdev.cz/", "http://localhost:3055"]) {
    assert.doesNotThrow(() => defineOps({
      db: { connectionString: URL }, users,
      loginLink: { path: "/invite/", origin, mint: async () => "unused" },
    }));
  }
});

test("login-link configuration rejects non-application paths and unsafe origins before any mutation", () => {
  for (const path of ["invite", "https://other.example/invite", "//other.example/invite", "/\\other.example", "/invite?x=1", "/invite#fragment", "/in vite"]) {
    assert.throws(() => defineOps({
      db: { connectionString: URL }, users,
      loginLink: { path, mint: async () => "unused" },
    }), /loginLink.path/);
  }
  for (const origin of ["", "javascript:alert(1)", "https://user:password@example.com", "https://example.com/path", "https://example.com?query=1", "https://example.com#fragment", "https:///example.com", " https://example.com", "https://example.com\\path"]) {
    assert.throws(() => defineOps({
      db: { connectionString: URL }, users,
      loginLink: { path: "/invite", origin, mint: async () => "unused" },
    }), /loginLink.origin/);
  }
});

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

test("a failed ready() is retried rather than cached", async () => {
  // Point at a database that does not exist yet, then create it between the two
  // calls. A cached rejection would fail the second call too, so this
  // distinguishes a real retry from a poisoned promise — which asserting
  // "rejects twice" against a permanently dead address cannot do.
  const base = new NodeURL(process.env.OPS_TEST_DATABASE_URL!);
  const dbName = "ops_test_config_retry";
  const admin = new Pool({ connectionString: base.toString(), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);

    base.pathname = `/${dbName}`;
    const late = defineOps({ db: { connectionString: base.toString() }, users });

    try {
      await assert.rejects(() => late.ready(), "the database does not exist yet");

      await admin.query(`CREATE DATABASE ${dbName}`);

      await late.ready();
      const { rows } = await late.pool.query("SELECT to_regclass('ops_audit_log') AS t");
      assert.notEqual(rows[0].t, null, "the retry must have actually run the migrations");
    } finally {
      await late.pool.end();
    }
  } finally {
    // Drop the database we created so a rerun (or another test file) never
    // collides with it, and so it doesn't linger in the test cluster.
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
});
