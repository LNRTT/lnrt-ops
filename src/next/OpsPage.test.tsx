import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
// OpsPage returns `<OpsView ... />` unresolved — OpsView is an async Server
// Component, and react-dom/server's classic (synchronous) renderer cannot
// await that. `server.edge`'s stream renderer can, so it is used here instead
// of the plain `renderToStaticMarkup` OpsView.test.tsx uses to render an
// already-awaited element.
import { renderToReadableStream } from "react-dom/server.edge";
import bcrypt from "bcryptjs";
// The real notFound() throws a special, digest-carrying error even outside a
// Next.js request scope (verified by hand: it does not need request-scope
// storage the way headers()/cookies() do), so it is imported for real here
// and handed to the "next/navigation" mock below rather than reimplemented.
import { notFound as realNotFound } from "next/navigation.js";
import { defineOps } from "../server/config";
import { OPS_COOKIE, signOpsToken } from "../server/opsSession";
import type { OpsUser, OpsUserStore } from "../server/users";
import { createTestDatabase } from "../server/testdb";

const DB_URL = await createTestDatabase("opspage");
const SECRET = "a-secret-at-least-32-characters-long!!";
const USERS: OpsUser[] = [
  { id: "u1", email: "anna@b.cz", name: "Anna", role: "WORKER", disabled: false, hasPassword: true },
];
const store: OpsUserStore = {
  roles: ["WORKER"],
  async list() { return { users: USERS, total: USERS.length }; },
  async get(id) { return USERS.find((u) => u.id === id) ?? null; },
  async create() { throw new Error("unused"); },
  async setPassword() {}, async setRole() {}, async setDisabled() {},
};

// next/headers's real `headers()` throws "called outside a request scope"
// unless it runs inside a live Next.js render, which this suite cannot set
// up. It is mocked via node:test's module mocking (this is what the "test"
// script's --experimental-test-module-mocks flag is for) so OpsPage's
// cookie-reading path is exercised without a Next.js runtime. `null` means
// "must not be called" — used to prove the notFound() gate short-circuits
// before any cookie is read.
let cookieHeaderForNextRequest: string | null = null;
mock.module("next/headers", {
  namedExports: {
    headers: async () => {
      if (cookieHeaderForNextRequest === null) {
        throw new Error("next/headers's headers() must not be called before the enabled() gate");
      }
      const value = cookieHeaderForNextRequest;
      return { get: (name: string) => (name === "cookie" ? value : null) };
    },
    // OpsPage must not need this any more (see defect #4 — it re-serialised
    // Next's cookie Map instead of reading the raw header), but a stray call
    // must not silently succeed with an empty jar and mask that regression.
    cookies: async () => {
      throw new Error("next/headers's cookies() must not be called — OpsPage should read the raw header");
    },
  },
});
mock.module("next/navigation", { namedExports: { notFound: realNotFound } });

const { OpsPage } = await import("./OpsPage");

const ops = defineOps({ db: { connectionString: DB_URL }, users: store });

before(async () => {
  process.env.OPS_ADMIN_EMAILS = "me@lnrt.cz";
  process.env.OPS_PASSWORD_HASH = bcrypt.hashSync("x", 10);
  process.env.OPS_SECRET = SECRET;
  await ops.ready();
});
after(async () => { await ops.pool.end(); });

async function renderStream(el: ReactElement): Promise<string> {
  const stream = await renderToReadableStream(el);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

test("calls Next's notFound() when the gate is disabled, without ever reading cookies", async () => {
  cookieHeaderForNextRequest = null; // headers() throws if OpsPage calls it — proves it did not
  const saved = process.env.OPS_ADMIN_EMAILS;
  delete process.env.OPS_ADMIN_EMAILS; // opsEnabled() is now false
  try {
    await assert.rejects(
      () => OpsPage({
        ops, params: Promise.resolve({ path: [] }), searchParams: Promise.resolve({}),
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "notFound() must throw an Error");
        assert.equal((err as { digest?: unknown }).digest, "NEXT_HTTP_ERROR_FALLBACK;404");
        return true;
      },
    );
  } finally {
    process.env.OPS_ADMIN_EMAILS = saved;
  }
});

test("reads the raw cookie header from next/headers and renders the signed-in view", async () => {
  const token = await signOpsToken("me@lnrt.cz", SECRET);
  cookieHeaderForNextRequest = `${OPS_COOKIE}=${token}`;
  const el = await OpsPage({
    ops, params: Promise.resolve({ path: ["users"] }), searchParams: Promise.resolve({}),
  });
  const html = await renderStream(el as ReactElement);
  assert.match(html, /anna@b\.cz/, "should render the signed-in users view, not the login form");
});

test("with no cookie at all, renders the login form rather than throwing", async () => {
  cookieHeaderForNextRequest = "";
  const el = await OpsPage({
    ops, params: Promise.resolve({ path: [] }), searchParams: Promise.resolve({}),
  });
  const html = await renderStream(el as ReactElement);
  assert.match(html, /action="\/ops\/api\/login"/);
});

test("a stale duplicate cookie does not win: first occurrence in the raw header wins", async () => {
  // Mirrors handlers.ts's parseCookie semantics and the real browser behaviour
  // (the more specific Path=/ops cookie is sent first) — see defect #4. Before
  // the fix, OpsPage rebuilt the header from Next's cookie Map, which keeps
  // the *last* entry, so a stale session at Path=/ next to the live one at
  // Path=/ops would make the page disagree with the API about who is signed in.
  const liveToken = await signOpsToken("me@lnrt.cz", SECRET);
  cookieHeaderForNextRequest = `${OPS_COOKIE}=${liveToken}; ${OPS_COOKIE}=not-a-real-token`;
  const el = await OpsPage({
    ops, params: Promise.resolve({ path: ["users"] }), searchParams: Promise.resolve({}),
  });
  const html = await renderStream(el as ReactElement);
  assert.match(html, /anna@b\.cz/, "the first (live) cookie value must win");
});
