import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { defineOps } from "../server/config";
import { listAudit } from "../server/audit";
import { signOpsToken, OPS_COOKIE, OPS_FLASH_COOKIE } from "../server/opsSession";
import { parseCookie } from "../server/cookies";
import type { OpsUser, OpsUserStore } from "../server/users";
import { createHandlers, csrfToken, readFlash } from "./handlers";
import { fingerprint } from "../server/errors/fingerprint";
import {
  getErrorGroup, listErrorEvents, listErrorGroups, recordError, type CapturedError, type ErrorGroupRow,
} from "../server/errors/store";

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

// Same DB, configured with a currentUserId resolver — used to prove that a
// browser-reported error's userId comes from the host's resolver, never from
// the request body, even when a resolver is available to consult.
const ops2Resolver = defineOps({
  db: { connectionString: DB_URL }, users: store,
  currentUserId: () => "resolved-user-1",
});
const { POST: POSTWithUser } = createHandlers(ops2Resolver);

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
  extraHeaders: Record<string, string> = {},
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
      ...extraHeaders,
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

/**
 * Builds a request for POST /ops/api/ingest. Defaults to a matching Origin
 * (`https://app.test`, matching the request URL below) and a minimal valid
 * JSON body, so most tests only need to override what they're exercising.
 * Pass `origin: ""` to omit the header entirely (same-origin-refusal tests).
 */
function ingestRequest(opts: {
  body?: Record<string, unknown>; raw?: string; origin?: string; referer?: string; ip?: string;
  cfConnectingIp?: string; xRealIp?: string;
} = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": opts.ip ?? "203.0.113.150",
  };
  if (opts.cfConnectingIp) headers["cf-connecting-ip"] = opts.cfConnectingIp;
  if (opts.xRealIp) headers["x-real-ip"] = opts.xRealIp;
  const origin = opts.origin === undefined ? "https://app.test" : opts.origin;
  if (origin) headers.origin = origin;
  if (opts.referer) headers.referer = opts.referer;
  const body = opts.raw ?? JSON.stringify(opts.body ?? { type: "Error", message: "default ingest message" });
  return new Request("https://app.test/ops/api/ingest", { method: "POST", headers, body });
}

/**
 * Builds an ingest POST whose body is a `ReadableStream` -- the one shape a
 * plain string body (which fetch/undici always gives an explicit
 * Content-Length for) can never produce. `Request` with a stream body has no
 * Content-Length header at all here, exactly like a real chunked POST with
 * none sent, which is the case the post-read size check used to miss
 * entirely. `totalBytes` worth of `x` is emitted across `chunkBytes`-sized
 * chunks; `onPull` is invoked once per chunk actually pulled out of the
 * stream, so a test can assert the handler stopped reading early.
 */
function streamingIngestRequest(opts: {
  totalBytes: number; chunkBytes: number; onPull: () => void; ip?: string;
}): Request {
  const encoder = new TextEncoder();
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= opts.totalBytes) {
        controller.close();
        return;
      }
      opts.onPull();
      const size = Math.min(opts.chunkBytes, opts.totalBytes - sent);
      controller.enqueue(encoder.encode("x".repeat(size)));
      sent += size;
    },
  });
  return new Request("https://app.test/ops/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test", "x-forwarded-for": opts.ip ?? "203.0.113.170" },
    body: stream,
    // Required by the fetch spec whenever the body is a stream.
    duplex: "half",
  } as RequestInit);
}

/** The ingest write is fire-and-forget; poll instead of assuming a fixed delay. */
async function waitForGroup(id: string, timeoutMs = 3000): Promise<ErrorGroupRow> {
  const start = Date.now();
  for (;;) {
    const group = await getErrorGroup(ops.pool, id);
    if (group) return group;
    if (Date.now() - start > timeoutMs) throw new Error(`group ${id} never appeared within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
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

// --- POST /ops/api/errors/status ------------------------------------------

const ERR_FOR_STATUS: CapturedError = {
  type: "TypeError", message: "status route boom", source: "server",
  stack: "TypeError: boom\n    at statusRoute (/app/src/statusRoute.ts:1:1)",
};
const STATUS_GROUP_ID = fingerprint(ERR_FOR_STATUS);

test("errors/status marks a group resolved and audits it", async () => {
  await recordError(ops.pool, ERR_FOR_STATUS);
  const res = await POST(form("errors/status", { id: STATUS_GROUP_ID, status: "resolved" }, authCookie));
  assert.equal(res.status, 303);
  const group = await getErrorGroup(ops.pool, STATUS_GROUP_ID);
  assert.equal(group!.status, "resolved");
  const audits = await listAudit(ops.pool, { limit: 5 });
  assert.ok(audits.some((a) => a.action === "error.status" && a.targetId === STATUS_GROUP_ID),
    "marking a group resolved must be audited");
});

test("errors/status marks a group ignored", async () => {
  const res = await POST(form("errors/status", { id: STATUS_GROUP_ID, status: "ignored" }, authCookie));
  assert.equal(res.status, 303);
  const group = await getErrorGroup(ops.pool, STATUS_GROUP_ID);
  assert.equal(group!.status, "ignored");
});

test("errors/status rejects an unknown status value, with no write", async () => {
  const before = (await getErrorGroup(ops.pool, STATUS_GROUP_ID))!.status;
  const res = await POST(form("errors/status", { id: STATUS_GROUP_ID, status: "deleted" }, authCookie));
  assert.equal(res.status, 400);
  const after = (await getErrorGroup(ops.pool, STATUS_GROUP_ID))!.status;
  assert.equal(after, before);
});

test("errors/status 404s for an unknown group id, with no write", async () => {
  const res = await POST(form("errors/status", { id: "does-not-exist", status: "resolved" }, authCookie));
  assert.equal(res.status, 404);
});

test("errors/status requires a session", async () => {
  const res = await POST(form("errors/status", { id: STATUS_GROUP_ID, status: "resolved" }));
  assert.equal(res.status, 401);
});

test("errors/status is refused without a valid CSRF token, with no write", async () => {
  const before = (await getErrorGroup(ops.pool, STATUS_GROUP_ID))!.status;
  const res = await POST(rawForm("errors/status", { id: STATUS_GROUP_ID, status: "resolved" }, authCookie));
  assert.equal(res.status, 403);
  const after = (await getErrorGroup(ops.pool, STATUS_GROUP_ID))!.status;
  assert.equal(after, before);
});

// --- POST /ops/api/ingest -----------------------------------------------

test("ingest works without any ops session cookie", async () => {
  const res = await POST(ingestRequest({
    ip: "203.0.113.150",
    body: { type: "Error", message: "no session needed case" },
  }));
  assert.equal(res.status, 204);
  const id = fingerprint({ type: "Error", message: "no session needed case" });
  const group = await waitForGroup(id);
  assert.equal(group.source, "browser");
});

test("ingest refuses a request whose Origin does not match this host", async () => {
  const res = await POST(ingestRequest({ origin: "https://evil.test", ip: "203.0.113.151" }));
  assert.equal(res.status, 403);
});

test("ingest refuses a request with neither Origin nor Referer", async () => {
  const res = await POST(ingestRequest({ origin: "", ip: "203.0.113.152" }));
  assert.equal(res.status, 403);
});

test("ingest accepts a same-origin request identified only by Referer", async () => {
  const res = await POST(ingestRequest({
    origin: "", referer: "https://app.test/dashboard", ip: "203.0.113.153",
    body: { type: "Error", message: "referer-only boom" },
  }));
  assert.equal(res.status, 204);
  const id = fingerprint({ type: "Error", message: "referer-only boom" });
  await waitForGroup(id);
});

test("ingest refuses a body over 16KB with 413 and stores nothing", async () => {
  const big = "x".repeat(20 * 1024);
  const res = await POST(ingestRequest({
    ip: "203.0.113.154",
    body: { type: "Error", message: "oversized ingest case", context: { big } },
  }));
  assert.equal(res.status, 413);
  const groups = await listErrorGroups(ops.pool, { source: "browser" });
  assert.equal(groups.some((g) => g.message === "oversized ingest case"), false);
});

test("ingest answers 204 even for malformed JSON, and stores nothing", async () => {
  const before = await listErrorGroups(ops.pool, { source: "browser" });
  const res = await POST(ingestRequest({ ip: "203.0.113.155", raw: "{not valid json" }));
  assert.equal(res.status, 204);
  const after = await listErrorGroups(ops.pool, { source: "browser" });
  assert.equal(after.length, before.length);
});

test("ingest answers 204 even when the body has no usable message, and stores nothing", async () => {
  const before = await listErrorGroups(ops.pool, { source: "browser" });
  const res = await POST(ingestRequest({ ip: "203.0.113.156", body: { type: "Error" } }));
  assert.equal(res.status, 204);
  const after = await listErrorGroups(ops.pool, { source: "browser" });
  assert.equal(after.length, before.length);
});

test("a body-supplied source is always overridden to \"browser\"", async () => {
  const res = await POST(ingestRequest({
    ip: "203.0.113.157",
    body: { type: "Error", message: "source override case", source: "server" },
  }));
  assert.equal(res.status, 204);
  const id = fingerprint({ type: "Error", message: "source override case" });
  const group = await waitForGroup(id);
  assert.equal(group.source, "browser");
});

test("a body-supplied userId is ignored when no resolver is configured", async () => {
  const res = await POST(ingestRequest({
    ip: "203.0.113.158",
    body: { type: "Error", message: "userid ignored case", userId: "attacker-supplied" },
  }));
  assert.equal(res.status, 204);
  const id = fingerprint({ type: "Error", message: "userid ignored case" });
  const group = await waitForGroup(id);
  const events = await listErrorEvents(ops.pool, group.id, 1);
  assert.equal(events[0]!.userId, undefined);
});

test("a body-supplied userId is ignored even when the host supplies a resolver -- the resolver wins", async () => {
  const res = await POSTWithUser(ingestRequest({
    ip: "203.0.113.159",
    body: { type: "Error", message: "resolver wins case", userId: "attacker-supplied" },
  }));
  assert.equal(res.status, 204);
  const id = fingerprint({ type: "Error", message: "resolver wins case" });
  const group = await waitForGroup(id);
  const events = await listErrorEvents(ops.pool, group.id, 1);
  assert.equal(events[0]!.userId, "resolved-user-1");
});

test("ingest stores the rest of a well-formed body's fields", async () => {
  const res = await POST(ingestRequest({
    ip: "203.0.113.160",
    body: {
      type: "TypeError",
      message: "full-shape ingest case",
      stack: "TypeError: x\n    at f (/app/src/x.ts:1:1)",
      url: "https://app.test/some/page?token=secret",
      release: "abc123",
      userRole: "WORKER",
      requestId: "req-1",
      context: { note: "fine", password: "hunter2" },
    },
  }));
  assert.equal(res.status, 204);
  const id = fingerprint({
    type: "TypeError", message: "full-shape ingest case",
    stack: "TypeError: x\n    at f (/app/src/x.ts:1:1)",
  });
  const group = await waitForGroup(id);
  assert.equal(group.source, "browser");
  const events = await listErrorEvents(ops.pool, group.id, 1);
  assert.equal(events[0]!.release, "abc123");
  assert.equal(events[0]!.userRole, "WORKER");
  assert.equal(events[0]!.requestId, "req-1");
  assert.equal(events[0]!.url, "https://app.test/some/page");
  const ctx = events[0]!.context as Record<string, unknown>;
  assert.equal(ctx.note, "fine");
  assert.equal(ctx.password, "<redacted>");
});

test("every ingest response still carries noindex and no-store", async () => {
  const res = await POST(ingestRequest({
    ip: "203.0.113.162",
    body: { type: "Error", message: "security headers ingest case" },
  }));
  assert.match(res.headers.get("x-robots-tag")!, /noindex/);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

// --- security review fix pass --------------------------------------------
//
// The two streaming-body tests below run BEFORE "ingest rate limits..." on
// purpose: that test fires 20+ requests back to back, and since the write
// is now backgrounded (fix 4) rather than awaited inline, its background
// captures can still be draining through the small in-flight cap for a
// little while after the test itself returns. A single-request test placed
// right after it can genuinely get its own capture dropped by that same
// cap -- correct behaviour under flood, but a false failure for an
// unrelated single-request assertion. Order, not a larger cap, is the fix.

test("ingest reads the body as a stream and aborts as soon as the cap is passed, with no Content-Length at all", async () => {
  let pulls = 0;
  const req = streamingIngestRequest({
    totalBytes: 100 * 1024, // 100 KB, well over the 16 KB cap
    chunkBytes: 1024, // 100 chunks
    onPull: () => { pulls++; },
    ip: "203.0.113.171",
  });
  assert.equal(req.headers.get("content-length"), null, "a stream body must carry no Content-Length here");

  const res = await POST(req);
  assert.equal(res.status, 413);
  // The cap (16 KB) is crossed partway through chunk 17 of 100 -- the
  // handler must abort there, not after pulling the whole 100 KB body.
  assert.ok(pulls < 100, `expected the handler to stop early; it pulled all ${pulls} chunks`);
  assert.ok(pulls <= 20, `expected the handler to stop close to the cap, it pulled ${pulls} chunks`);
});

test("a chunked body under the cap is still accepted and stored, even with no Content-Length", async () => {
  const message = "chunked-under-cap-case";
  const payload = JSON.stringify({ type: "Error", message });
  const encoder = new TextEncoder();
  const bytes = encoder.encode(payload);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Split into two chunks so it genuinely streams rather than arriving whole.
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
  const req = new Request("https://app.test/ops/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test", "x-forwarded-for": "203.0.113.172" },
    body: stream,
    duplex: "half",
  } as RequestInit);

  const res = await POST(req);
  assert.equal(res.status, 204);
  const id = fingerprint({ type: "Error", message });
  await waitForGroup(id);
});

test("ingest rate limits at 20 requests per minute per IP -- the 20th is admitted, the 21st is not", async () => {
  // A bare "the 21st is refused" assertion would pass just as well with the
  // limit set to 5 -- assert the 20th succeeds too, so this actually pins
  // the limit at 20 rather than merely "some number at or below 21".
  //
  // Each message ends in a distinct *letter*, not a digit -- normalizeMessage
  // collapses digits to a placeholder, so 21 digit-suffixed messages would
  // all fingerprint identically and serialise on one group row's lock. Since
  // the write is now backgrounded (fix 4), that serialisation can easily
  // outlast this test itself and bleed into whatever runs next.
  const ip = "203.0.113.161";
  const responses: Response[] = [];
  for (let i = 0; i < 21; i++) {
    const letter = String.fromCharCode(97 + i);
    responses.push(await POST(ingestRequest({ ip, body: { type: "Error", message: `rate limit ingest case ${letter}` } })));
  }
  assert.equal(responses[19]!.status, 204, "the 20th request must still be admitted");
  assert.equal(responses[20]!.status, 429, "the 21st request must be refused");
  assert.ok(Number(responses[20]!.headers.get("retry-after")) > 0);
});

test("clientIp prefers cf-connecting-ip, so two real users behind one shared Cloudflare edge get independent ingest rate-limit buckets", async () => {
  const sharedEdge = "198.51.100.1";
  const userA = "203.0.113.201";
  const userB = "203.0.113.202";

  let last: Response | undefined;
  for (let i = 0; i < 21; i++) {
    last = await POST(ingestRequest({
      ip: sharedEdge, cfConnectingIp: userA,
      body: { type: "Error", message: `shared-edge-user-a-${i}` },
    }));
  }
  assert.equal(last!.status, 429, "user A's own budget must be exhaustible");

  // User B, identified by a different cf-connecting-ip behind the SAME
  // x-forwarded-for edge address, must not inherit user A's exhausted budget
  // -- that's exactly the collision the old last-XFF-hop logic caused.
  const stillOk = await POST(ingestRequest({
    ip: sharedEdge, cfConnectingIp: userB,
    body: { type: "Error", message: "shared-edge-user-b-unaffected" },
  }));
  assert.equal(stillOk.status, 204);
});

test("clientIp falls back to x-real-ip when cf-connecting-ip is absent", async () => {
  const sharedEdge = "198.51.100.2";
  const userA = "203.0.113.203";
  const userB = "203.0.113.204";

  let last: Response | undefined;
  for (let i = 0; i < 21; i++) {
    last = await POST(ingestRequest({
      ip: sharedEdge, xRealIp: userA,
      body: { type: "Error", message: `x-real-ip-user-a-${i}` },
    }));
  }
  assert.equal(last!.status, 429);

  const stillOk = await POST(ingestRequest({
    ip: sharedEdge, xRealIp: userB,
    body: { type: "Error", message: "x-real-ip-user-b-unaffected" },
  }));
  assert.equal(stillOk.status, 204);
});

test("the login limiter uses the same cf-connecting-ip-aware IP resolution as ingest, so a shared edge no longer pools every visitor into one lockout bucket", async () => {
  const sharedEdge = "198.51.100.3";
  const attacker = "203.0.113.205";
  const genuineUser = "203.0.113.206";

  for (let i = 0; i < 5; i++) {
    const res = await POST(form(
      "login", { email: "me@lnrt.cz", password: "nope" }, undefined, sharedEdge,
      { "cf-connecting-ip": attacker },
    ));
    assert.equal(res.status, 303);
  }
  const blocked = await POST(form(
    "login", { email: "me@lnrt.cz", password: "correct horse battery" }, undefined, sharedEdge,
    { "cf-connecting-ip": attacker },
  ));
  assert.equal(blocked.status, 429, "the attacker's own five failures must lock them out");

  // A different real visitor behind the same edge, identified by their own
  // cf-connecting-ip, must not inherit that lockout.
  const unaffected = await POST(form(
    "login", { email: "me@lnrt.cz", password: "correct horse battery" }, undefined, sharedEdge,
    { "cf-connecting-ip": genuineUser },
  ));
  assert.equal(unaffected.status, 303, "an unrelated visitor behind the same edge must still be able to sign in");
});

test("a throwing currentUserId resolver is logged once and does not stop the event from being stored unattributed", async () => {
  let calls = 0;
  const throwingOps = defineOps({
    db: { connectionString: DB_URL }, users: store,
    currentUserId: () => { calls++; throw new Error("resolver blew up"); },
  });
  const { POST: POSTThrowing } = createHandlers(throwingOps);

  const originalError = console.error;
  let loggedCount = 0;
  console.error = (...args: unknown[]) => {
    if (String(args[0] ?? "").includes("currentUserId")) loggedCount++;
  };
  try {
    const res1 = await POSTThrowing(ingestRequest({
      ip: "203.0.113.180", body: { type: "Error", message: "throwing resolver case one" },
    }));
    const res2 = await POSTThrowing(ingestRequest({
      ip: "203.0.113.181", body: { type: "Error", message: "throwing resolver case two" },
    }));
    assert.equal(res1.status, 204);
    assert.equal(res2.status, 204);

    const id1 = fingerprint({ type: "Error", message: "throwing resolver case one" });
    const group1 = await waitForGroup(id1);
    const events1 = await listErrorEvents(ops.pool, group1.id, 1);
    assert.equal(events1[0]!.userId, undefined, "attribution must be dropped, not fabricated, when the resolver throws");

    const id2 = fingerprint({ type: "Error", message: "throwing resolver case two" });
    await waitForGroup(id2);
  } finally {
    console.error = originalError;
  }
  assert.equal(calls, 2, "the resolver must have actually been called (and thrown) both times");
  assert.equal(loggedCount, 1, "a throwing resolver must be logged once, not on every call and not silently");
});

test("POST /ops/api/ingest 404s like every other route when the gate is unconfigured", async () => {
  const saved = process.env.OPS_PASSWORD_HASH;
  delete process.env.OPS_PASSWORD_HASH;
  try {
    const res = await POST(ingestRequest({
      ip: "203.0.113.182", body: { type: "Error", message: "ingest while disabled case" },
    }));
    assert.equal(res.status, 404);
  } finally {
    process.env.OPS_PASSWORD_HASH = saved;
  }
});

test("a forged but matching Origin header from a plain non-browser client (curl) still passes the same-origin check -- it is not a CSRF defence", async () => {
  // Documents the limit called out in the same-origin comment: unlike a real
  // browser, curl can set any Origin it likes. This proves the check only
  // ever stops a drive-by cross-site *browser* POST, nothing else.
  const res = await POST(ingestRequest({
    ip: "203.0.113.183",
    origin: "https://app.test", // no browser involved in building this request at all
    body: { type: "Error", message: "curl with a forged matching origin" },
  }));
  assert.equal(res.status, 204);
  const id = fingerprint({ type: "Error", message: "curl with a forged matching origin" });
  await waitForGroup(id);
});

// This test must run LAST in the file: it deliberately exhausts the
// process-wide ingest ceiling, which then stays blocked (blockMs) for far
// longer than the rest of this suite takes to run -- any ingest test placed
// after it would see spurious 429s that have nothing to do with what it's
// actually testing.
test("a process-wide ingest ceiling refuses further requests once ~600/minute is reached, even across many distinct client IPs", async () => {
  // Each request uses its own IP so the per-IP 20/min limiter never fires --
  // only the global ceiling can be responsible for a 429 here. Because the
  // ceiling's state is shared with every earlier ingest test in this file
  // (all within the same minute by wall-clock construction), this test does
  // not assume its own request count lines up exactly with the threshold --
  // only that comfortably more requests than the ceiling allows eventually
  // produces a 429, and that not every request in the run was refused.
  const responses: Response[] = [];
  for (let i = 0; i < 650; i++) {
    responses.push(await POST(ingestRequest({
      ip: `unique-client-${i}`, // a distinct rate-limit key per request; clientIp never validates IP shape
      body: { type: "Error", message: `global-ceiling-case-${i}` },
    })));
  }
  assert.ok(responses.some((r) => r.status === 204), "at least some requests must have been admitted");
  assert.equal(responses.at(-1)!.status, 429, "well past 600 requests, the global ceiling must have engaged");
});
