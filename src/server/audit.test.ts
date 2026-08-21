import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { migrate } from "./migrate";
import { ALL_MIGRATIONS } from "./migrations/index";
import { writeAudit, listAudit } from "./audit";

const URL = process.env.OPS_TEST_DATABASE_URL!;
let pool: Pool;

before(async () => {
  pool = new Pool({ connectionString: URL });
  await pool.query("DROP TABLE IF EXISTS ops_audit_log; DELETE FROM ops_migration WHERE id = '001-init'");
  await migrate(pool, ALL_MIGRATIONS);
});
after(async () => { await pool.end(); });

test("writes an entry and reads it back newest-first", async () => {
  await writeAudit(pool, { actor: "me@lnrt.cz", action: "user.create", targetType: "user", targetId: "u1", summary: "Created a@b.cz" });
  await writeAudit(pool, { actor: "me@lnrt.cz", action: "user.disable", targetType: "user", targetId: "u1", summary: "Disabled a@b.cz" });
  const rows = await listAudit(pool);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.action, "user.disable");
  assert.equal(rows[1]!.action, "user.create");
  assert.ok(rows[0]!.at instanceof Date);
});

test("filters by target", async () => {
  await writeAudit(pool, { actor: "me@lnrt.cz", action: "gate.login", summary: "Signed in" });
  const rows = await listAudit(pool, { targetId: "u1" });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.targetId === "u1"));
});

test("paginates with beforeId", async () => {
  const first = await listAudit(pool, { limit: 1 });
  const next = await listAudit(pool, { limit: 1, beforeId: first[0]!.id });
  assert.equal(next.length, 1);
  assert.notEqual(next[0]!.id, first[0]!.id);
});

test("a rejected write surfaces to the caller", async () => {
  await assert.rejects(
    () => writeAudit(pool, { actor: "x", action: "y", summary: null as unknown as string }),
    "audit writes are operator-facing and must not be silently swallowed",
  );
});
