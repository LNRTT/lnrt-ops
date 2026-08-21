import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import bcrypt from "bcryptjs";
import { defineOps } from "../server/config";
import { signOpsToken, OPS_COOKIE } from "../server/opsSession";
import type { OpsUser, OpsUserStore, OpsUserQuery } from "../server/users";
import { OpsView } from "./OpsView";
import { signFlash } from "./handlers";

import { createTestDatabase } from "../server/testdb";

const DB_URL = await createTestDatabase("opsview");
const SECRET = "a-secret-at-least-32-characters-long!!";
const USERS: OpsUser[] = [
  { id: "u1", email: "anna@b.cz", name: "Anna", role: "WORKER", disabled: false, hasPassword: true },
  { id: "u2", email: "bob@b.cz", name: "Bob", role: "ADMIN", disabled: true, hasPassword: false },
];
let lastListQuery: OpsUserQuery | undefined;
const store: OpsUserStore = {
  roles: ["WORKER", "ADMIN"],
  async list(q) { lastListQuery = q; return { users: USERS, total: USERS.length }; },
  async get(id) { return USERS.find((u) => u.id === id) ?? null; },
  async create() { throw new Error("unused"); },
  async setPassword() {}, async setRole() {}, async setDisabled() {},
};
const ops = defineOps({ db: { connectionString: DB_URL }, users: store });

// A second adapter that *does* support hardDelete and login links, so the
// branches gated on those capabilities (absent from `store` above, on
// purpose — see "this adapter has no hardDelete" below) get exercised too.
const storeWithExtras: OpsUserStore = { ...store, async hardDelete() {} };
const opsWithExtras = defineOps({
  db: { connectionString: DB_URL },
  users: storeWithExtras,
  loginLink: { mint: async (id: string) => `token-for-${id}`, path: "/invite" },
});

// OpsView takes the cookie header as a plain string, so no Next.js runtime is needed here.
async function render(path: string[], cookie?: string, search: Record<string, string> = {}) {
  const el = await OpsView({ ops, path, search, cookieHeader: cookie ?? "" });
  return renderToStaticMarkup(el);
}

async function renderWith(
  instance: typeof ops, path: string[], cookie?: string, search: Record<string, string> = {},
) {
  const el = await OpsView({ ops: instance, path, search, cookieHeader: cookie ?? "" });
  return renderToStaticMarkup(el);
}

// A connection nothing listens on, so pg fails fast (ECONNREFUSED) rather than
// hanging until a connect timeout — these tests need to prove the health page
// renders promptly when Postgres is down, not eventually.
const BROKEN_DB_URL = "postgres://baduser:badpass@127.0.0.1:1/doesnotexist";
const brokenOps = defineOps({ db: { connectionString: BROKEN_DB_URL }, users: store });

let authCookie: string;
before(async () => {
  process.env.OPS_ADMIN_EMAILS = "me@lnrt.cz";
  process.env.OPS_PASSWORD_HASH = bcrypt.hashSync("x", 10);
  process.env.OPS_SECRET = SECRET;
  await ops.ready();
  await opsWithExtras.ready();
  authCookie = `${OPS_COOKIE}=${await signOpsToken("me@lnrt.cz", SECRET)}`;
});
after(async () => {
  await ops.pool.end();
  await brokenOps.pool.end();
});

test("shows the login form when there is no session", async () => {
  const html = await render([]);
  assert.match(html, /action="\/ops\/api\/login"/);
  assert.match(html, /type="password"/);
  assert.equal(html.includes("anna@b.cz"), false, "no user data before signing in");
});

test("lists users once signed in, marking disabled and password-less accounts", async () => {
  const html = await render(["users"], authCookie);
  assert.match(html, /anna@b\.cz/);
  assert.match(html, /bob@b\.cz/);
  assert.match(html, /Disabled/);
  assert.match(html, /No password/);
});

test("the user detail page offers the actions the adapter supports", async () => {
  const html = await render(["users", "u1"], authCookie);
  assert.match(html, /action="\/ops\/api\/users\/password"/);
  assert.match(html, /action="\/ops\/api\/users\/role"/);
  assert.match(html, /action="\/ops\/api\/users\/disable"/);
  assert.equal(html.includes('action="/ops/api/users/delete"'), false,
    "this adapter has no hardDelete, so the delete form must not render");
});

test("the delete form renders when the adapter supports hardDelete, with confirmation and CSRF", async () => {
  const html = await renderWith(opsWithExtras, ["users", "u1"], authCookie);
  assert.match(html, /action="\/ops\/api\/users\/delete"/);
  const form = html.slice(html.indexOf('action="/ops/api/users/delete"'));
  const body = form.slice(0, form.indexOf("</form>"));
  assert.match(body, /name="confirm"/, "the delete form must ask for the email confirmation");
  assert.match(body, /name="csrf"/, "the delete form must carry the CSRF token like every other mutation");
});

test("the sign-in link form renders when the instance configures loginLink", async () => {
  const html = await renderWith(opsWithExtras, ["users", "u1"], authCookie);
  assert.match(html, /action="\/ops\/api\/users\/login-link"/);
});

test("the create-user form picks a role from a select, not a free-text field", async () => {
  // users/create rejects any role not in store.roles with a bare-text 400 that
  // replaces the whole page and loses what was typed. UserDetail already uses
  // a <select> for the same choice; the create form must match, not invite a
  // typo a user can actually make.
  const html = await render(["users"], authCookie);
  const createForm = html.slice(
    html.indexOf('action="/ops/api/users/create"'), html.indexOf("</form>", html.indexOf('action="/ops/api/users/create"')),
  );
  assert.match(createForm, /<select name="role"/);
  assert.match(createForm, /<option[^>]*>WORKER<\/option>/);
  assert.match(createForm, /<option[^>]*>ADMIN<\/option>/);
  assert.equal(/name="role"[^>]*type="text"|<input name="role"/.test(createForm), false,
    "the role field must not be a free-text input");
});

test("shows 'No such user.' for an id the store does not have", async () => {
  const html = await render(["users", "does-not-exist"], authCookie);
  assert.match(html, /No such user\./);
});

test("search.q and disabled=1 reach store.list with the right query", async () => {
  lastListQuery = undefined;
  await render(["users"], authCookie, { q: "anna", disabled: "1" });
  assert.deepEqual(lastListQuery, { search: "anna", includeDisabled: true });
});

test("the reveal copy is truthful about the cookie expiring rather than the value being shown once", async () => {
  // Nothing clears lnrt_ops_flash — only its 60-second Max-Age expires it, so
  // a refresh or a back-navigation within that window re-renders the value.
  // The copy must say that, not claim a "shown once" guarantee the code
  // does not have.
  const value = signFlash({ kind: "password", user: "u1", value: "truthful-copy-check" }, SECRET);
  const html = await render(["users", "u1"], `${authCookie}; lnrt_ops_flash=${encodeURIComponent(value)}`);
  assert.equal(/will not be shown again/i.test(html), false,
    "the copy must not claim the value will not be shown again — a refresh within 60s re-renders it");
  assert.match(html, /minute|60.second/i, "the copy should say the cookie expires within a minute");
});

test("a correctly signed flash cookie for the same user is rendered", async () => {
  const value = signFlash({ kind: "password", user: "u1", value: "correct-horse-battery-staple" }, SECRET);
  const html = await render(["users", "u1"], `${authCookie}; lnrt_ops_flash=${encodeURIComponent(value)}`);
  assert.match(html, /correct-horse-battery-staple/, "a validly-signed flash for this user must render");
});

test("a correctly signed flash cookie for a different user must not render", async () => {
  // u2, not u1 — this is the one branch that keeps the reveal from leaking
  // across a user detail page it was never minted for.
  const value = signFlash({ kind: "password", user: "u2", value: "not-for-this-page" }, SECRET);
  const html = await render(["users", "u1"], `${authCookie}; lnrt_ops_flash=${encodeURIComponent(value)}`);
  assert.equal(html.includes("not-for-this-page"), false,
    "a correctly signed flash for a different user must not render here");
});

test("renders the audit and health views", async () => {
  // The nav renders an "Audit" link on every signed-in page, so matching
  // against /Audit/ alone would pass even if the audit table itself never
  // rendered. Assert a column header from the table instead.
  assert.match(await render(["audit"], authCookie), /<th>Who<\/th>/);
  const health = await render(["health"], authCookie);
  assert.match(health, /Database/);
  assert.match(health, /Migrations/);
});

test("every posting form carries a CSRF token, and no GET form does", async () => {
  // A GET form serialises its fields into the query string, so a token there
  // would land in browser history, access logs and the Referer header. It is a
  // stable HMAC, so leaking it once weakens every mutation until OPS_SECRET is
  // rotated.
  for (const path of [["users"], ["users", "u1"]]) {
    const html = await render(path, authCookie);
    const forms = html.split("<form").slice(1);
    assert.ok(forms.length > 0, `expected forms on /${path.join("/")}`);
    for (const form of forms) {
      const body = form.slice(0, form.indexOf("</form>"));
      if (/method="post"/.test(body)) {
        assert.match(body, /name="csrf"/, `a posting form on /${path.join("/")} has no CSRF token`);
      } else {
        assert.equal(/name="csrf"/.test(body), false,
          `a GET form on /${path.join("/")} must not leak the CSRF token into the query string`);
      }
    }
  }
});

test("ignores a flash cookie that is not correctly signed", async () => {
  const forged = JSON.stringify({ kind: "link", user: "u1", value: "https://evil.example/invite/x" });
  const html = await render(["users", "u1"], `${authCookie}; lnrt_ops_flash=${encodeURIComponent(forged)}`);
  assert.equal(html.includes("evil.example"), false,
    "an unsigned flash cookie must never be rendered");
});

test("tells crawlers not to index it, signed in or not", async () => {
  // The API sends X-Robots-Tag, but this page is rendered by the host's route,
  // which never applies those headers.
  for (const [label, cookie] of [["signed out", undefined], ["signed in", authCookie]] as const) {
    const html = await render(["users"], cookie);
    assert.match(html, /<meta name="robots" content="noindex, nofollow"\/>/, label);
  }
});

test("carries its own stylesheet so it does not depend on host CSS", async () => {
  const html = await render(["users"], authCookie);
  assert.match(html, /<style>/);
});

test("an unknown path renders the users view rather than crashing", async () => {
  const html = await render(["nonsense"], authCookie);
  assert.match(html, /anna@b\.cz/);
});

// Regression: OpsView used to `await ops.ready()` (which runs migrations)
// before routing at all, so the one view whose job is to report a broken
// database was the view a broken database took down. `ready()` is never
// awaited against `brokenOps` here — the point is that health must not need it.

test("the health view renders and reports a failing database when Postgres is unreachable", async () => {
  const el = await OpsView({ ops: brokenOps, path: ["health"], search: {}, cookieHeader: authCookie });
  const html = renderToStaticMarkup(el);
  assert.match(html, /Database/);
  assert.match(html, /ops-tag bad">fail/);
});

test("other views degrade to a styled message instead of throwing when Postgres is unreachable", async () => {
  const el = await OpsView({ ops: brokenOps, path: ["users"], search: {}, cookieHeader: authCookie });
  const html = renderToStaticMarkup(el);
  assert.match(html, /operations database is unavailable/i);
  assert.match(html, /href="\/ops\/health"/);
});
