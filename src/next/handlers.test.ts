import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { defineOps } from "../server/config";
import { listAudit } from "../server/audit";
import { signOpsToken, OPS_COOKIE, OPS_FLASH_COOKIE } from "../server/opsSession";
import { parseCookie } from "../server/cookies";
import type { OpsUser, OpsUserStore } from "../server/users";
import { createHandlers, csrfToken, readFlash } from "./handlers";

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

// Same store, but with no loginLink configured — used for the "no login-link
// support" 400 cases.
const opsNoLink = defineOps({ db: { connectionString: DB_URL }, users: store });
const { POST: POSTNoLink } = createHandlers(opsNoLink);

// Same DB, a store that implements hardDelete — used for the delete happy path.
let deletableRows: OpsUser[];
const deletableStore: OpsUserStore = {
  roles: ["WORKER", "ADMIN"],
  async list() { return { users: deletableRows, total: deletableRows.length }; },
  async get(id) { return deletableRows.find((u) => u.id === id) ?? null; },
  async create(input) {
    const u = { id: "u2", ...input, disabled: false, hasPassword: false };
    deletableRows.push(u); return u;
  },
  async setPassword(id) { const u = deletableRows.find((r) => r.id === id)!; u.hasPassword = true; },
  async setRole(id, role) { deletableRows.find((r) => r.id === id)!.role = role; },
  async setDisabled(id, d) { deletableRows.find((r) => r.id === id)!.disabled = d; },
  async hardDelete(id) { deletableRows = deletableRows.filter((r) => r.id !== id); },
};
const opsDeletable = defineOps({
  db: { connectionString: DB_URL }, users: deletableStore,
  loginLink: { mint: async () => "TOKEN123", path: "/invite" },
});
const { POST: POSTDeletable } = createHandlers(opsDeletable);

// A second, independent database used only to simulate an audit-write
// failure (by dropping ops_audit_log out from under it) without disturbing
// every other test in this file.
const DB_URL2 = await createTestDatabase("handlers_auditfail");
let rows2: OpsUser[];
const store2: OpsUserStore = {
  roles: ["WORKER", "ADMIN"],
  async list() { return { users: rows2, total: rows2.length }; },
  async get(id) { return rows2.find((u) => u.id === id) ?? null; },
  async create(input) {
    const u = { id: "u2", ...input, disabled: false, hasPassword: false };
    rows2.push(u); return u;
  },
  async setPassword(id) { const u = rows2.find((r) => r.id === id)!; u.hasPassword = true; },
  async setRole(id, role) { rows2.find((r) => r.id === id)!.role = role; },
  async setDisabled(id, d) { rows2.find((r) => r.id === id)!.disabled = d; },
};
const ops2 = defineOps({ db: { connectionString: DB_URL2 }, users: store2 });
const { POST: POST2 } = createHandlers(ops2);

// The login limiter is module-level state shared by every test in this file, so each
// test that exercises it must use its own client IP or it inherits the neighbours' failures.
function form(
  path: string, fields: Record<string, string>, cookie?: string, ip = "203.0.113.7",
): Request {
  // Requests carrying the authenticated cookie are, by construction, requests
  // that need a valid CSRF token — auto-inject it so every existing test does
  // not have to know about CSRF. Tests that specifically exercise CSRF build
  // their own Request instead of going through this helper.
  const fields2 = cookie === authCookie ? { csrf: AUTH_CSRF, ...fields } : fields;
  return new Request(`https://app.test/ops/api/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
      "x-forwarded-for": ip,
    },
    body: new URLSearchParams(fields2).toString(),
  });
}

function rawForm(path: string, fields: Record<string, string>, cookie?: string, ip = "203.0.113.7"): Request {
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

/** Pulls the signed flash cookie out of a response and decodes it. */
function extractFlash(res: Response, secret = SECRET): { kind: string; user: string; value: string } | null {
  const cookies = res.headers.getSetCookie();
  const header = cookies.find((c) => c.startsWith(`${OPS_FLASH_COOKIE}=`));
  if (!header) return null;
  const raw = parseCookie(header, OPS_FLASH_COOKIE);
  if (!raw) return null;
  return readFlash(raw, secret) as { kind: string; user: string; value: string } | null;
}

let authCookie: string;
let AUTH_CSRF: string;

before(async () => {
  process.env.OPS_ADMIN_EMAILS = "me@lnrt.cz";
  process.env.OPS_PASSWORD_HASH = bcrypt.hashSync("correct horse battery", 10);
  process.env.OPS_SECRET = SECRET;
  await ops.ready();
  await ops2.ready();
  authCookie = `${OPS_COOKIE}=${await signOpsToken("me@lnrt.cz", SECRET)}`;
  AUTH_CSRF = csrfToken("me@lnrt.cz", SECRET);
});
after(async () => {
  await ops.pool.end();
  await ops2.pool.end();
});
beforeEach(() => {
  rows = [{ id: "u1", email: "a@b.cz", name: "Anna", role: "WORKER", disabled: false, hasPassword: true }];
  deletableRows = [{ id: "u1", email: "a@b.cz", name: "Anna", role: "WORKER", disabled: false, hasPassword: true }];
  rows2 = [{ id: "u1", email: "a@b.cz", name: "Anna", role: "WORKER", disabled: false, hasPassword: true }];
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

test("users/create 400s when email or name is missing, with no write", async () => {
  const res = await POST(form("users/create", { email: "", name: "X", role: "WORKER" }, authCookie));
  assert.equal(res.status, 400);
  assert.equal(rows.length, 1);
});

test("users/create with no login-link configured sets no flash cookie", async () => {
  const res = await POSTNoLink(form("users/create", { email: "z@z.cz", name: "Z", role: "WORKER" }, authCookie));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("resetting a password reveals it once and never in the redirect URL", async () => {
  const res = await POST(form("users/password", { id: "u1" }, authCookie));
  assert.equal(res.status, 303);
  const flash = extractFlash(res);
  assert.ok(flash, "a correctly signed flash cookie must be set");
  assert.equal(flash!.kind, "password");
  assert.equal(flash!.user, "u1");
  assert.match(flash!.value, /^[A-Za-z0-9]{12,}$/);
  const audit = await listAudit(ops.pool, { limit: 1 });
  assert.equal(audit[0]!.action, "user.password");
  assert.equal(/[A-Za-z0-9]{20}/.test(res.headers.get("location")!), false);
});

test("users/password 404s for an unknown id, with no write", async () => {
  const res = await POST(form("users/password", { id: "ghost" }, authCookie));
  assert.equal(res.status, 404);
});

test("users/password 400s for a too-short explicit password, with no write", async () => {
  const res = await POST(form("users/password", { id: "u1", password: "short" }, authCookie));
  assert.equal(res.status, 400);
  assert.equal(rows[0]!.hasPassword, true);
});

test("an unknown role is rejected", async () => {
  const res = await POST(form("users/role", { id: "u1", role: "GOD" }, authCookie));
  assert.equal(res.status, 400);
  assert.equal(rows[0]!.role, "WORKER");
});

test("users/role 404s for an unknown id, with no write", async () => {
  const res = await POST(form("users/role", { id: "ghost", role: "ADMIN" }, authCookie));
  assert.equal(res.status, 404);
});

test("users/disable toggles in both directions", async () => {
  let res = await POST(form("users/disable", { id: "u1", disabled: "1" }, authCookie));
  assert.equal(res.status, 303);
  assert.equal(rows[0]!.disabled, true);
  res = await POST(form("users/disable", { id: "u1", disabled: "0" }, authCookie));
  assert.equal(res.status, 303);
  assert.equal(rows[0]!.disabled, false);
});

test("users/disable rejects a malformed value with no write", async () => {
  const res = await POST(form("users/disable", { id: "u1", disabled: "true" }, authCookie));
  assert.equal(res.status, 400);
  assert.equal(rows[0]!.disabled, false);
});

test("users/disable 404s for an unknown id, with no write", async () => {
  const res = await POST(form("users/disable", { id: "ghost", disabled: "1" }, authCookie));
  assert.equal(res.status, 404);
});

test("logout clears both the session and flash cookie", async () => {
  const res = await POST(form("logout", {}, authCookie));
  assert.equal(res.status, 303);
  const cookies = res.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith(`${OPS_COOKIE}=`));
  const flash = cookies.find((c) => c.startsWith(`${OPS_FLASH_COOKIE}=`));
  assert.ok(session, "session cookie must be cleared");
  assert.match(session!, /Max-Age=0/);
  assert.ok(flash, "flash cookie must be cleared");
  assert.match(flash!, /Max-Age=0/);
});

test("users/login-link happy path reveals the minted link in the flash cookie", async () => {
  const res = await POST(form("users/login-link", { id: "u1" }, authCookie));
  assert.equal(res.status, 303);
  const flash = extractFlash(res);
  assert.ok(flash, "a correctly signed flash cookie must be set");
  assert.equal(flash!.kind, "link");
  assert.equal(flash!.user, "u1");
  assert.equal(flash!.value, "/invite/TOKEN123");
});

test("users/login-link 400s when the host has no login-link support", async () => {
  const res = await POSTNoLink(form("users/login-link", { id: "u1" }, authCookie));
  assert.equal(res.status, 400);
});

test("delete is refused when the adapter cannot hard delete", async () => {
  const res = await POST(form("users/delete", { id: "u1" }, authCookie));
  assert.equal(res.status, 400);
  assert.equal(rows.length, 1);
});

test("users/delete happy path removes the user and audits both intent and completion", async () => {
  const res = await POSTDeletable(form("users/delete", { id: "u1", confirm: "a@b.cz" }, authCookie));
  assert.equal(res.status, 303);
  assert.equal(deletableRows.length, 0);
  const audits = await listAudit(ops.pool, { limit: 5 });
  assert.ok(audits.some((a) => a.action === "user.delete" && a.targetId === "u1"),
    "the completion must be audited");
  assert.ok(audits.some((a) => a.action.startsWith("user.delete") && a.action !== "user.delete" && a.targetId === "u1"),
    "the intent must be audited before the irreversible call");
});

test("a wrong confirmation email refuses the delete, leaves the user present, and is audited", async () => {
  const res = await POSTDeletable(form("users/delete", { id: "u1", confirm: "wrong@x.cz" }, authCookie));
  assert.equal(res.status, 400);
  assert.equal(deletableRows.length, 1);
  const audits = await listAudit(ops.pool, { limit: 1 });
  assert.match(audits[0]!.action, /delete.*refus|refus.*delete/i);
  assert.equal(audits[0]!.targetId, "u1");
});

test("the health endpoint needs a session and returns JSON", async () => {
  const anon = await GET(new Request("https://app.test/ops/api/health"));
  assert.equal(anon.status, 401);
  const res = await GET(new Request("https://app.test/ops/api/health", { headers: { cookie: authCookie } }));
  assert.equal(res.status, 200);
  const body = await res.json() as { checks: { id: string }[] };
  assert.ok(body.checks.some((c) => c.id === "db"));
});

test("an unknown POST path 404s", async () => {
  const res = await POST(form("users/nope", { id: "u1" }, authCookie));
  assert.equal(res.status, 404);
});

test("a non-health GET path 404s", async () => {
  const res = await GET(new Request("https://app.test/ops/api/other", { headers: { cookie: authCookie } }));
  assert.equal(res.status, 404);
});

test("a missing CSRF token is refused with 403 and no write", async () => {
  const res = await POST(rawForm("users/role", { id: "u1", role: "ADMIN" }, authCookie));
  assert.equal(res.status, 403);
  assert.equal(rows[0]!.role, "WORKER");
});

test("a wrong CSRF token is refused with 403 and no write", async () => {
  const res = await POST(rawForm("users/role", { id: "u1", role: "ADMIN", csrf: "not-the-right-token" }, authCookie));
  assert.equal(res.status, 403);
  assert.equal(rows[0]!.role, "WORKER");
});

test("an audit failure after a successful password reset still returns the flash cookie", async () => {
  await ops2.pool.query("DROP TABLE ops_audit_log");
  const res = await POST2(form("users/password", { id: "u1" }, authCookie));
  assert.equal(res.status, 500);
  const flash = extractFlash(res);
  assert.ok(flash, "the operator must still receive the new password even though the audit write failed");
  assert.equal(flash!.kind, "password");
  assert.equal(flash!.user, "u1");
  assert.match(flash!.value, /^[A-Za-z0-9]{12,}$/);
});
