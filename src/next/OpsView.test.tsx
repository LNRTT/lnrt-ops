import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import bcrypt from "bcryptjs";
import { defineOps } from "../server/config";
import { signOpsToken, OPS_COOKIE } from "../server/opsSession";
import type { OpsUser, OpsUserStore } from "../server/users";
import { OpsView } from "./OpsView";

import { createTestDatabase } from "../server/testdb";

const DB_URL = await createTestDatabase("opsview");
const SECRET = "a-secret-at-least-32-characters-long!!";
const USERS: OpsUser[] = [
  { id: "u1", email: "anna@b.cz", name: "Anna", role: "WORKER", disabled: false, hasPassword: true },
  { id: "u2", email: "bob@b.cz", name: "Bob", role: "ADMIN", disabled: true, hasPassword: false },
];
const store: OpsUserStore = {
  roles: ["WORKER", "ADMIN"],
  async list() { return { users: USERS, total: USERS.length }; },
  async get(id) { return USERS.find((u) => u.id === id) ?? null; },
  async create() { throw new Error("unused"); },
  async setPassword() {}, async setRole() {}, async setDisabled() {},
};
const ops = defineOps({ db: { connectionString: DB_URL }, users: store });

// OpsView takes the cookie header as a plain string, so no Next.js runtime is needed here.
async function render(path: string[], cookie?: string, search: Record<string, string> = {}) {
  const el = await OpsView({ ops, path, search, cookieHeader: cookie ?? "" });
  return renderToStaticMarkup(el);
}

let authCookie: string;
before(async () => {
  process.env.OPS_ADMIN_EMAILS = "me@lnrt.cz";
  process.env.OPS_PASSWORD_HASH = bcrypt.hashSync("x", 10);
  process.env.OPS_SECRET = SECRET;
  await ops.ready();
  authCookie = `${OPS_COOKIE}=${await signOpsToken("me@lnrt.cz", SECRET)}`;
});
after(async () => { await ops.pool.end(); });

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

test("renders the audit and health views", async () => {
  assert.match(await render(["audit"], authCookie), /Audit/);
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

test("carries its own stylesheet so it does not depend on host CSS", async () => {
  const html = await render(["users"], authCookie);
  assert.match(html, /<style>/);
});

test("an unknown path renders the users view rather than crashing", async () => {
  const html = await render(["nonsense"], authCookie);
  assert.match(html, /anna@b\.cz/);
});
