import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import bcrypt from "bcryptjs";
import { defineOps } from "../server/config";
import { signOpsToken, OPS_COOKIE } from "../server/opsSession";
import type { OpsUser, OpsUserStore, OpsUserQuery } from "../server/users";
import { OpsView } from "./OpsView";
import { signFlash } from "./handlers";
import { recordError, getErrorGroup, setErrorGroupStatus, type CapturedError } from "../server/errors/store";
import { fingerprint } from "../server/errors/fingerprint";

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

// Error-group fixtures for the errors views below. `label` feeds both the
// stack frame's filename and the message, so each gets its own fingerprint.
const ERR_SERVER: CapturedError = {
  type: "TypeError", message: "boom in checkout", source: "server",
  stack: "TypeError: boom\n    at checkout (/app/src/checkout.ts:10:5)",
  userId: "u1", release: "1.2.3",
};
const ERR_BROWSER: CapturedError = {
  type: "RangeError", message: "boom in widget", source: "browser",
  stack: "RangeError: boom\n    at widget (/app/src/widget.ts:3:1)",
  userId: "u2", url: "https://app.test/widget?token=SECRETVALUE",
  context: { note: "safe-context-value", password: "hunter2-should-be-redacted" },
};
const ERR_RESOLVED: CapturedError = {
  type: "Error", message: "already fixed thing", source: "server",
  stack: "Error: fixed\n    at old (/app/src/old.ts:1:1)",
  userId: "u3",
};
const ERR_OLD: CapturedError = {
  type: "Error", message: "ancient thing", source: "server",
  stack: "Error: ancient\n    at ancient (/app/src/ancient.ts:1:1)",
};
const SERVER_ID = fingerprint(ERR_SERVER);
const BROWSER_ID = fingerprint(ERR_BROWSER);
const RESOLVED_ID = fingerprint(ERR_RESOLVED);
const OLD_ID = fingerprint(ERR_OLD);

let authCookie: string;
before(async () => {
  process.env.OPS_ADMIN_EMAILS = "me@lnrt.cz";
  process.env.OPS_PASSWORD_HASH = bcrypt.hashSync("x", 10);
  process.env.OPS_SECRET = SECRET;
  await ops.ready();
  await opsWithExtras.ready();
  authCookie = `${OPS_COOKIE}=${await signOpsToken("me@lnrt.cz", SECRET)}`;

  await recordError(ops.pool, ERR_SERVER);
  await recordError(ops.pool, ERR_BROWSER);
  await recordError(ops.pool, ERR_RESOLVED);
  await setErrorGroupStatus(ops.pool, RESOLVED_ID, "resolved");
  await recordError(ops.pool, ERR_OLD);
  // Pushed outside the 24h window so the "last 24 hours" filter has
  // something real to exclude.
  await ops.pool.query(`UPDATE ops_error_group SET last_seen = now() - interval '2 days' WHERE id = $1`, [OLD_ID]);
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

test("the login form can reveal the password", async () => {
  // A password manager filling the wrong entry is indistinguishable from a
  // broken gate unless the operator can see the field.
  const html = await render([]);
  assert.match(html, /id="ops-pw"/);
  assert.match(html, /id="ops-pw-show"/);
  assert.match(html, /Show password/);
  assert.match(html, /field\.type = box\.checked/, "the toggle must actually be wired up");
  // A password manager must not offer the host app's credential here.
  assert.equal(/autocomplete="current-password"/i.test(html), false);
  assert.equal((html.match(/autocomplete="off"/gi) ?? []).length, 2, "both fields opt out");
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

// --- Errors view ----------------------------------------------------------

test("the nav gains an Errors link", async () => {
  assert.match(await render(["users"], authCookie), /<a href="\/ops\/errors">Errors<\/a>/);
});

test("the errors list renders groups newest first, with type, message, culprit, count, users, seen dates and release", async () => {
  const html = await render(["errors"], authCookie);
  assert.match(html, /TypeError/);
  assert.match(html, /boom in checkout/);
  assert.match(html, /checkout\.ts/, "the culprit should be shown");
  assert.match(html, /1\.2\.3/, "the last release should be shown");
  // Both the true occurrence count and what was actually kept are shown --
  // for these fixtures they are equal (1 each), so at minimum the count itself renders.
  assert.match(html, />1<\/td>/, "an event/affected-user count should render");
  // ERR_BROWSER was recorded after ERR_SERVER (see the fixtures' `before` block), so its
  // last_seen is later -- "newest first" means it must appear earlier in the markup.
  const checkoutIdx = html.indexOf("boom in checkout");
  const widgetIdx = html.indexOf("boom in widget");
  assert.ok(checkoutIdx !== -1 && widgetIdx !== -1);
  assert.ok(widgetIdx < checkoutIdx, "the more-recently-seen group should render first");
});

test("the errors list honours the unresolved-only filter", async () => {
  const html = await render(["errors"], authCookie, { unresolved: "1" });
  assert.match(html, /boom in checkout/);
  assert.equal(html.includes("already fixed thing"), false, "a resolved group must not show under 'unresolved only'");
});

test("the errors list honours the source filter", async () => {
  const server = await render(["errors"], authCookie, { source: "server" });
  assert.match(server, /boom in checkout/);
  assert.equal(server.includes("boom in widget"), false, "server filter must exclude the browser-sourced group");

  const browser = await render(["errors"], authCookie, { source: "browser" });
  assert.match(browser, /boom in widget/);
  assert.equal(browser.includes("boom in checkout"), false, "browser filter must exclude the server-sourced group");
});

test("the errors list honours the last-24-hours filter", async () => {
  const html = await render(["errors"], authCookie, { since: "24h" });
  assert.match(html, /boom in checkout/);
  assert.equal(html.includes("ancient thing"), false, "a group not seen in the last 24h must be excluded");
});

test("the errors list honours the user filter", async () => {
  const html = await render(["errors"], authCookie, { user: "u1" });
  assert.match(html, /boom in checkout/);
  assert.equal(html.includes("boom in widget"), false, "filtering by u1 must exclude a group only u2 hit");
});

test("the errors list shows no groups when Postgres is unreachable, degrading like every other view", async () => {
  const el = await OpsView({ ops: brokenOps, path: ["errors"], search: {}, cookieHeader: authCookie });
  const html = renderToStaticMarkup(el);
  assert.match(html, /operations database is unavailable/i);
});

test("an unauthenticated request to the errors list or detail renders none of the error data", async () => {
  for (const path of [["errors"], ["errors", SERVER_ID]]) {
    const html = await render(path, undefined);
    assert.match(html, /action="\/ops\/api\/login"/);
    assert.equal(html.includes("boom in checkout"), false);
    assert.equal(html.includes("boom in widget"), false);
  }
});

test("the error detail view renders the stack, url, method, release, and redacted context", async () => {
  const html = await render(["errors", BROWSER_ID], authCookie);
  assert.match(html, /RangeError/);
  assert.match(html, /boom in widget/);
  assert.match(html, /widget\.ts/, "the stack must render");
  assert.match(html, /\/widget/, "the stored URL (query stripped) must render");
  assert.equal(html.includes("SECRETVALUE"), false, "the URL's query string must not render");
  assert.match(html, /safe-context-value/, "a non-sensitive context field must render");
  assert.equal(html.includes("hunter2-should-be-redacted"), false,
    "a credential-shaped context field must have been redacted before it ever reached this view");
});

test("shows 'No such error group.' for an id the store does not have", async () => {
  const html = await render(["errors", "does-not-exist"], authCookie);
  assert.match(html, /No such error group\./);
});

test("the status form on the detail page carries the CSRF token and posts to the errors/status route", async () => {
  const html = await render(["errors", SERVER_ID], authCookie);
  assert.match(html, /action="\/ops\/api\/errors\/status"/);
  const form = html.slice(html.indexOf('action="/ops/api/errors/status"'));
  const body = form.slice(0, form.indexOf("</form>"));
  assert.match(body, /name="csrf"/);
  assert.match(body, new RegExp(`name="id" value="${SERVER_ID}"`));
});

test("a resolved group's detail page offers to ignore it but not to resolve it again", async () => {
  const html = await render(["errors", RESOLVED_ID], authCookie);
  assert.equal(/value="resolved"/.test(html), false, "already resolved -- no redundant resolve action");
  assert.match(html, /value="ignored"/);
});

test("the user detail page links to that user's errors", async () => {
  const html = await render(["users", "u1"], authCookie);
  assert.match(html, /href="\/ops\/errors\?user=u1"/);
});

test("the opportunistic prune runs on the first errors-view render, then is throttled for an hour", async () => {
  const pruneDbUrl = await createTestDatabase("opsview_prune");
  const pruneOps = defineOps({ db: { connectionString: pruneDbUrl }, users: store });
  await pruneOps.ready();

  const staleA: CapturedError = {
    type: "Error", message: "stale a", source: "server",
    stack: "Error: x\n    at a (/app/src/a.ts:1:1)",
  };
  const idA = fingerprint(staleA);
  await recordError(pruneOps.pool, staleA);
  await pruneOps.pool.query(`UPDATE ops_error_event SET at = now() - interval '40 days' WHERE group_id = $1`, [idA]);
  await pruneOps.pool.query(`UPDATE ops_error_group SET last_seen = now() - interval '40 days' WHERE id = $1`, [idA]);

  await renderWith(pruneOps, ["errors"], authCookie);

  const start = Date.now();
  let goneA = false;
  while (Date.now() - start < 3000) {
    if (!(await getErrorGroup(pruneOps.pool, idA))) { goneA = true; break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(goneA, "the first errors-view render should trigger an opportunistic prune");

  const staleB: CapturedError = {
    type: "Error", message: "stale b", source: "server",
    stack: "Error: x\n    at b (/app/src/b.ts:1:1)",
  };
  const idB = fingerprint(staleB);
  await recordError(pruneOps.pool, staleB);
  await pruneOps.pool.query(`UPDATE ops_error_event SET at = now() - interval '40 days' WHERE group_id = $1`, [idB]);
  await pruneOps.pool.query(`UPDATE ops_error_group SET last_seen = now() - interval '40 days' WHERE id = $1`, [idB]);

  await renderWith(pruneOps, ["errors"], authCookie);
  await new Promise((r) => setTimeout(r, 200));
  const stillThere = await getErrorGroup(pruneOps.pool, idB);
  assert.ok(stillThere, "a second render within the same hour must not run the prune again");

  await pruneOps.pool.end();
});

test("every posting form carries a CSRF token, and no GET form does", async () => {
  // A GET form serialises its fields into the query string, so a token there
  // would land in browser history, access logs and the Referer header. It is a
  // stable HMAC, so leaking it once weakens every mutation until OPS_SECRET is
  // rotated.
  for (const path of [["users"], ["users", "u1"], ["errors"], ["errors", SERVER_ID]]) {
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
