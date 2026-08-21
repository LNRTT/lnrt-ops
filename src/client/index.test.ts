import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { browserErrorScript } from "./index";

/**
 * browserErrorScript() returns raw JS text meant to be inlined into an HTML
 * page, not a module -- so it's exercised here by actually running it in a
 * sandboxed context with fake `window`/`fetch`/`navigator` globals, the same
 * way a real page would provide them, rather than just pattern-matching the
 * source text.
 */
function run(): {
  listeners: Record<string, (event: unknown) => void>;
  calls: { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }[];
} {
  const listeners: Record<string, (event: unknown) => void> = {};
  const calls: { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];

  const fakeWindow = {
    location: { href: "https://app.test/some/page" },
    addEventListener(type: string, handler: (event: unknown) => void) {
      listeners[type] = handler;
    },
  };
  function fakeFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) {
    calls.push({ url, init });
    return Promise.resolve({ ok: true });
  }

  const context = vm.createContext({
    window: fakeWindow,
    navigator: { userAgent: "test-agent/1.0" },
    fetch: fakeFetch,
    Error, String, Object, JSON, console,
  });
  vm.runInContext(browserErrorScript(), context, { filename: "browser-error-script.js" });

  return { listeners, calls };
}

test("returns a non-empty string that targets the ingest endpoint", () => {
  const script = browserErrorScript();
  assert.equal(typeof script, "string");
  assert.ok(script.length > 0);
  assert.match(script, /\/ops\/api\/ingest/);
});

test("registers both a window error listener and an unhandledrejection listener", () => {
  const { listeners } = run();
  assert.equal(typeof listeners.error, "function");
  assert.equal(typeof listeners.unhandledrejection, "function");
});

test("a window error event posts the error's shape to /ops/api/ingest", () => {
  const { listeners, calls } = run();
  listeners.error!({
    error: new Error("boom in the browser"),
    message: "boom in the browser",
    filename: "app.js",
    lineno: 12,
    colno: 3,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/ops/api/ingest");
  assert.equal(calls[0]!.init.method, "POST");
  const body = JSON.parse(calls[0]!.init.body!) as Record<string, unknown>;
  assert.equal(body.type, "Error");
  assert.equal(body.message, "boom in the browser");
  assert.equal(body.url, "https://app.test/some/page");
  assert.equal(body.userAgent, "test-agent/1.0");
  assert.ok(typeof body.stack === "string" && body.stack.length > 0);
});

test("an unhandled promise rejection posts too, tagged as its own type", () => {
  const { listeners, calls } = run();
  listeners.unhandledrejection!({ reason: new Error("rejected in the browser") });
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]!.init.body!) as Record<string, unknown>;
  assert.equal(body.message, "rejected in the browser");
});

test("a rejection with a non-Error reason still reports something usable", () => {
  const { listeners, calls } = run();
  listeners.unhandledrejection!({ reason: "just a string rejection" });
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]!.init.body!) as Record<string, unknown>;
  assert.match(String(body.message), /just a string rejection/);
});

test("a malformed event object never throws out of the handler", () => {
  const { listeners } = run();
  assert.doesNotThrow(() => listeners.error!({}));
  assert.doesNotThrow(() => listeners.unhandledrejection!({}));
  assert.doesNotThrow(() => listeners.error!(undefined));
});

test("the body never includes a userId field -- the endpoint must not trust one from here", () => {
  const { listeners, calls } = run();
  listeners.error!({ error: new Error("no userId here") });
  const body = JSON.parse(calls[0]!.init.body!) as Record<string, unknown>;
  assert.equal("userId" in body, false);
});
