import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { defineOps } from "../server/config";
import { listAudit } from "../server/audit";
import { signOpsToken, OPS_COOKIE } from "../server/opsSession";
import type { OpsUser, OpsUserStore } from "../server/users";
import { createHandlers } from "./handlers";

import { createTestDatabase } from "../server/testdb";

const DB_URL = await createTestDatabase("handlers");
const SECRET = "a-secret-at-least-32-characters-long!!";

let rows: OpsUser[];
const store: OpsUserStore = {
  roles: ["WORKER", "ADMIN"],
  async list() { return { users: rows, total: rows.length }; },
  async get(id) { return rows.find((u) => u.id === id) ?? null; },
  async create(input) {
    const u = { id: "u2", ...input, disabled: false, hasPassword: false };
    rows.push(u); return u;
  },
  async setPassword(id) { const u = rows.find((r) => r.id === id)!; u.hasPassword = true; },
  async setRole(id, role) { rows.find((r) => r.id === id)!.role = role; },
  async setDisabled(id, d) { rows.find((r) => r.id === id)!.disabled = d; },
};

const ops = defineOps({
  db: { connectionString: DB_URL }, users: store,
  loginLink: { mint: async () => "TOKEN123", path: "/invite" },
});
const { GET, POST } = createHandlers(ops);

// The login limiter is module-level state shared by every test in this file, so each
// test that exercises it must use its own client IP or it inherits the neighbours' failures.
function form(
  path: string, fields: Record<string, string>, cookie?: string, ip = "203.0.113.7",
): Request {
  return new Request(`https://app.test/ops/api/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
      "x-forwarded-for": ip,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

let authCookie: string;

before(async () => {
  process.env.OPS_ADMIN_EMAILS = "me@lnrt.cz";
  process.env.OPS_PASSWORD_HASH = bcrypt.hashSync("correct horse battery", 10);
  process.env.OPS_SECRET = SECRET;
  await ops.ready();
  authCookie = `${OPS_COOKIE}=${await signOpsToken("me@lnrt.cz", SECRET)}`;
});
after(async () => { await ops.pool.end(); });
beforeEach(() => {
  rows = [{ id: "u1", email: "a@b.cz", name: "Anna", role: "WORKER", disabled: false, hasPassword: true }];
});

test("every response carries noindex and no-store", async () => {
  const res = await POST(form("login", { email: "me@lnrt.cz", password: "wrong" }));
  assert.match(res.headers.get("x-robots-tag")!, /noindex/);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("returns 404 for everything when the gate is unconfigured", async () => {
  const saved = process.env.OPS_PASSWORD_HASH;
  delete process.env.OPS_PASSWORD_HASH;
  assert.equal((await POST(form("login", { email: "me@lnrt.cz", password: "correct horse battery" }))).status, 404);
  assert.equal((await POST(form("users/create", { email: "x@y.cz", name: "X", role: "WORKER" }, authCookie))).status, 404);
  process.env.OPS_PASSWORD_HASH = saved;
});

test("a correct login sets the ops cookie and redirects", async () => {
  const res = await POST(form("login", { email: "me@lnrt.cz", password: "correct horse battery" }));
  assert.equal(res.status, 303);
  assert.match(res.headers.get("set-cookie")!, new RegExp(`^${OPS_COOKIE}=`));
  assert.match(res.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(res.headers.get("set-cookie")!, /SameSite=Strict/i);
  assert.match(res.headers.get("set-cookie")!, /Path=\/ops/i);
  assert.match(res.headers.get("set-cookie")!, /Secure/i,
    "an https request must get a Secure cookie regardless of NODE_ENV");
});

test("drops Secure only for plain http on a loopback host", async () => {
  const local = new Request("http://localhost:3000/ops/api/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.55" },
    body: new URLSearchParams({ email: "me@lnrt.cz", password: "correct horse battery" }).toString(),
  });
  const res = await POST(local);
  assert.equal(res.status, 303);
  assert.equal(/Secure/i.test(res.headers.get("set-cookie")!), false);
});

test("a wrong password is audited and does not set a cookie", async () => {
  const res = await POST(form("login", { email: "me@lnrt.cz", password: "nope" }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("set-cookie"), null);
  const audit = await listAudit(ops.pool, { limit: 1 });
  assert.equal(audit[0]!.action, "gate.login.failed");
  assert.equal(audit[0]!.summary.includes("nope"), false, "the attempted password must never be recorded");
});

test("the sixth failed login in a window is refused outright", async () => {
  const ip = "203.0.113.99";
  for (let i = 0; i < 5; i++) {
    await POST(form("login", { email: "me@lnrt.cz", password: "nope" }, undefined, ip));
  }
  const res = await POST(form("login", { email: "me@lnrt.cz", password: "correct horse battery" }, undefined, ip));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("mutations without a session are refused", async () => {
  const res = await POST(form("users/create", { email: "x@y.cz", name: "X", role: "WORKER" }));
  assert.equal(res.status, 401);
  assert.equal(rows.length, 1);
});

test("creating a user records an audit entry and returns a login link", async () => {
  const res = await POST(form("users/create", { email: "x@y.cz", name: "X", role: "WORKER" }, authCookie));
  assert.equal(res.status, 303);
  assert.equal(rows.length, 2);
  const audit = await listAudit(ops.pool, { limit: 1 });
  assert.equal(audit[0]!.action, "user.create");
  assert.equal(audit[0]!.actor, "me@lnrt.cz");
  const flash = res.headers.get("set-cookie")!;
  assert.match(flash, /lnrt_ops_flash=/);
  assert.equal(res.headers.get("location")!.includes("TOKEN123"), false,
    "a one-time secret must never travel in the URL");
});

test("resetting a password reveals it once and never in the redirect URL", async () => {
  const res = await POST(form("users/password", { id: "u1" }, authCookie));
  assert.equal(res.status, 303);
  assert.match(res.headers.get("set-cookie")!, /lnrt_ops_flash=/);
  const audit = await listAudit(ops.pool, { limit: 1 });
  assert.equal(audit[0]!.action, "user.password");
  assert.equal(/[A-Za-z0-9]{20}/.test(res.headers.get("location")!), false);
});

test("an unknown role is rejected", async () => {
  const res = await POST(form("users/role", { id: "u1", role: "GOD" }, authCookie));
  assert.equal(res.status, 400);
  assert.equal(rows[0]!.role, "WORKER");
});

test("delete is refused when the adapter cannot hard delete", async () => {
  const res = await POST(form("users/delete", { id: "u1" }, authCookie));
  assert.equal(res.status, 400);
  assert.equal(rows.length, 1);
});

test("the health endpoint needs a session and returns JSON", async () => {
  const anon = await GET(new Request("https://app.test/ops/api/health"));
  assert.equal(anon.status, 401);
  const res = await GET(new Request("https://app.test/ops/api/health", { headers: { cookie: authCookie } }));
  assert.equal(res.status, 200);
  const body = await res.json() as { checks: { id: string }[] };
  assert.ok(body.checks.some((c) => c.id === "db"));
});
