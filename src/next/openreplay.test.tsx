import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import bcrypt from "bcryptjs";
import { renderToStaticMarkup } from "react-dom/server";
import { browserErrorScript, connectOpenReplay } from "../client";
import { defineOps } from "../server/config";
import type { OpsUserStore } from "../server/users";
import { signOpsToken, OPS_COOKIE } from "../server/opsSession";
import { recordError, listErrorEvents } from "../server/errors/store";
import { fingerprint } from "../server/errors/fingerprint";
import { createTestDatabase } from "../server/testdb";
import { createHandlers } from "./handlers";
import { OpsView } from "./OpsView";

const db = await createTestDatabase("openreplay");
const projectUrl = "https://replay.example.test/42";
const users: OpsUserStore = {
  roles: ["ADMIN"], async list() { return { users: [], total: 0 }; }, async get() { return null; },
  async create() { throw new Error("unused"); }, async setPassword() {}, async setRole() {}, async setDisabled() {},
};
const ops = defineOps({ db: { connectionString: db }, users, openReplay: { projectUrl }, currentUserId: () => "real-user" });
const disabled = defineOps({ db: { connectionString: db }, users });
const savedEnv = { ...process.env };
let cookie: string;
before(async () => {
  process.env.OPS_ADMIN_EMAILS = "operator@example.test";
  process.env.OPS_PASSWORD_HASH = await bcrypt.hash("test-password", 4);
  process.env.OPS_SECRET = "openreplay-test-secret-at-least-32-characters";
  cookie = `${OPS_COOKIE}=${await signOpsToken("operator@example.test", process.env.OPS_SECRET)}`;
  await ops.ready();
});
after(async () => { process.env = savedEnv; Reflect.deleteProperty(globalThis, "window"); await ops.pool.end(); });

async function ingest(body: Record<string, unknown>, instance = ops) {
  const response = await createHandlers(instance).POST(new Request("https://app.test/ops/api/ingest", {
    method: "POST", headers: { origin: "https://app.test", "content-type": "application/json", "x-forwarded-for": "203.0.113.42" },
    body: JSON.stringify(body),
  }));
  assert.equal(response.status, 204);
  const id = fingerprint({ type: "Error", message: String(body.message), stack: body.stack as string | undefined });
  for (let i = 0; i < 100; i++) {
    const events = await listErrorEvents(ops.pool, id);
    if (events.length) return { id, event: events[0]! };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Ingest did not persist the event");
}

test("browser error travels through ingest and storage to an authenticated replay link", async () => {
  let body: Record<string, unknown> | undefined;
  let errorHandler: (event: unknown) => void = () => {};
  const fakeWindow = { location: { href: "https://app.test/work" }, addEventListener: (name: string, handler: (e: unknown) => void) => {
    if (name === "error") errorHandler = handler;
  } };
  Object.assign(globalThis, { window: fakeWindow });
  const disconnect = connectOpenReplay({ isActive: () => true, getSessionURL: () => `${projectUrl}/session/123?jumpto=456&token=secret` }, { projectUrl });
  vm.runInNewContext(browserErrorScript(), { window: fakeWindow, Error, fetch: (_url: string, init: { body: string }) => {
    body = JSON.parse(init.body); return Promise.resolve({});
  } });
  errorHandler({ error: new Error("replay bridge failure") });
  disconnect();
  const { id, event } = await ingest(body!);
  assert.equal(event.userId, "real-user");
  assert.equal(event.context?.openReplayUrl, `${projectUrl}/session/123?jumpto=456`);
  const html = renderToStaticMarkup(await OpsView({ ops, path: ["errors", id], cookieHeader: cookie, search: {} }));
  assert.ok(html.includes(`href="${projectUrl}/session/123?jumpto=456"`));
  assert.match(html, /Přehrát průběh/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.equal(html.includes("token=secret"), false);
  const anonymous = renderToStaticMarkup(await OpsView({ ops, path: ["errors", id], cookieHeader: "", search: {} }));
  assert.equal(anonymous.includes("Přehrát průběh"), false);
});

for (const [name, url, enabled] of [
  ["foreign host", "https://evil.test/42/session/123", true],
  ["foreign project", "https://replay.example.test/43/session/123", true],
  ["disabled integration", `${projectUrl}/session/123`, false],
  ["script injection", "javascript:alert(1)", true],
] as const) test(`ingest discards replay metadata for ${name} while retaining the error`, async () => {
  const instance = enabled ? ops : disabled;
  const { id, event } = await ingest({ type: "Error", message: `bad replay ${name}`, context: { openReplayUrl: url, note: "safe" } }, instance);
  assert.equal(event.context?.openReplayUrl, undefined);
  assert.equal(event.context?.note, "safe");
  const html = renderToStaticMarkup(await OpsView({ ops: instance, path: ["errors", id], cookieHeader: cookie, search: {} }));
  assert.equal(html.includes("Přehrát průběh"), false);
});

test("stored server context strips replay credentials and views recheck project configuration", async () => {
  const error = { type: "Error", message: "server replay reference", source: "server" as const,
    context: { openReplayUrl: `${projectUrl}/session/789?jumpto=12&password=NEVERSTORE`, apiKey: "NEVERSTORE" } };
  await recordError(ops.pool, error);
  const id = fingerprint(error);
  const events = await listErrorEvents(ops.pool, id);
  assert.equal(JSON.stringify(events).includes("NEVERSTORE"), false);
  const otherProject = defineOps({ db: { connectionString: db }, users, openReplay: { projectUrl: "https://replay.example.test/43" } });
  for (const instance of [otherProject, disabled]) {
    const html = renderToStaticMarkup(await OpsView({ ops: instance, path: ["errors", id], cookieHeader: cookie, search: {} }));
    assert.equal(html.includes("Přehrát průběh"), false);
  }
});
