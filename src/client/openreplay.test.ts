import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { browserErrorScript } from "./index";
import { connectOpenReplay, getOpenReplayContext, openReplayPrivacyOptions } from "./openreplay";

const projectUrl = "https://replay.example.test/42";
afterEach(() => { Reflect.deleteProperty(globalThis, "window"); });
test("inactive or missing tracker never attaches a replay", () => {
  assert.deepEqual(getOpenReplayContext(), {});
  Object.assign(globalThis, { window: {} });
  const off = connectOpenReplay({ isActive: () => false, getSessionURL: () => `${projectUrl}/session/123` }, { projectUrl });
  assert.deepEqual(getOpenReplayContext(), {});
  off();
});
test("each error gets its current replay position, and detach preserves a newer connection", () => {
  Object.assign(globalThis, { window: {} });
  let position = 10;
  const tracker = { isActive: () => true, getSessionURL: (opts?: { withCurrentTime?: boolean }) => {
    assert.equal(opts?.withCurrentTime, true);
    return `${projectUrl}/session/123?jumpto=${position}&token=secret`;
  } };
  const detach = connectOpenReplay(tracker, { projectUrl });
  assert.deepEqual(getOpenReplayContext(), { openReplayUrl: `${projectUrl}/session/123?jumpto=10` });
  position = 20;
  assert.deepEqual(getOpenReplayContext(), { openReplayUrl: `${projectUrl}/session/123?jumpto=20` });
  const detachNew = connectOpenReplay(tracker, { projectUrl });
  detach();
  assert.ok(getOpenReplayContext().openReplayUrl);
  detachNew();
  assert.deepEqual(getOpenReplayContext(), {});
});
test("inline reporter attaches the replay and still reports when the tracker throws", () => {
  const listeners: Record<string, (e: unknown) => void> = {};
  const calls: { context: Record<string, unknown> }[] = [];
  const fakeWindow = { location: { href: "https://app.test/" }, addEventListener: (name: string, f: (e: unknown) => void) => { listeners[name] = f; } };
  Object.assign(globalThis, { window: fakeWindow });
  let broken = false;
  connectOpenReplay({ isActive: () => true, getSessionURL: () => {
    if (broken) throw new Error("tracker unavailable");
    return `${projectUrl}/session/123?jumpto=10`;
  } }, { projectUrl });
  vm.runInNewContext(browserErrorScript(), { window: fakeWindow, Error, fetch: (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body)); return Promise.resolve({});
  } });
  listeners.error!({ error: new Error("first") });
  assert.equal(calls[0]?.context.openReplayUrl, `${projectUrl}/session/123?jumpto=10`);
  broken = true;
  listeners.unhandledrejection!({ reason: new Error("second") });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.context.openReplayUrl, undefined);
});
test("privacy defaults mask text and referrers and omit form inputs, network content and console", () => {
  const options = openReplayPrivacyOptions();
  assert.equal(options.privateMode, true);
  assert.equal(options.defaultInputMode, 2);
  assert.equal(options.network.disabled, true);
  assert.equal(options.network.sessionTokenHeader, false);
  assert.equal(options.network.capturePayload, false);
  assert.equal(options.network.ignoreHeaders, true);
  assert.equal(options.network.sanitizer({}), null);
  assert.deepEqual(options.consoleMethods, []);
  assert.equal(options.urls.urlSanitizer("https://app.test/invite/secret?token=hidden#secret"), "https://app.test/[redacted]");
});
