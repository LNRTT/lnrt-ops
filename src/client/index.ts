/**
 * `@lnrt/ops/client` — the one thing a host inlines into its pages to report
 * browser errors, and nothing else. Intentionally self-contained (no imports
 * from the rest of the package, or from anywhere): `browserErrorScript()`
 * returns raw JS *text* that a host embeds in a `<script>` tag (e.g.
 * `dangerouslySetInnerHTML`), so this file's own dependency graph must never
 * leak into that text. A shared import here (pulling in `pg` via the server
 * tree, for instance) would either bloat or break whatever actually runs
 * that inlined script in the browser -- mirroring why a host's own
 * `instrumentation-client.ts` keeps itself dependency-free.
 */

/**
 * Returns the JS source of a small, dependency-free script that reports
 * uncaught browser errors and unhandled promise rejections to
 * `POST /ops/api/ingest`. Never throws, never blocks the page: every send is
 * best-effort (`keepalive: true`, failures swallowed).
 *
 * The endpoint ignores any `userId`/`source` the script might send -- those
 * are always attacker-controllable from a POST body, so the endpoint sets
 * `source` itself and resolves `userId` (if at all) from the host's own
 * session. This script does not attempt to send either.
 */
export function browserErrorScript(): string {
  return `(function () {
  if (typeof window === "undefined" || typeof fetch === "undefined") return;

  // A component that throws on every render (or a tight retry loop hitting a
  // broken endpoint) can otherwise fire this thousands of times a minute --
  // and a 429 from the server doesn't slow it down, since nothing here reads
  // the response. Two independent guards, reset only on a fresh page load:
  //  - MAX_REPORTS bounds the total this page will ever send.
  //  - "seen" drops a repeat of the exact same message+stack outright, before
  //    it can even count against that budget -- the common case (one broken
  //    component throwing over and over) should cost the endpoint one write,
  //    not ten identical ones.
  var MAX_REPORTS = 10;
  var sentCount = 0;
  // Object.create(null) -- a plain {} would let a message/stack that happens
  // to read "constructor" or "__proto__" match an inherited Object.prototype
  // property instead of an actual prior report, causing a false-positive
  // suppression before anything was ever really sent.
  var seen = Object.create(null);

  function post(type, message, stack, extra) {
    try {
      var key = String(message) + "\\u0000" + String(stack || "");
      if (seen[key]) return;
      seen[key] = true;
      if (sentCount >= MAX_REPORTS) return;
      sentCount++;

      var payload = JSON.stringify({
        type: type,
        message: message,
        stack: stack,
        url: window.location ? window.location.href : undefined,
        userAgent: (typeof navigator !== "undefined" && navigator.userAgent) || undefined,
        context: extra
      });
      fetch("/ops/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true
      }).catch(function () {});
    } catch (e) {
      // Reporting must never throw out of a global error handler.
    }
  }

  window.addEventListener("error", function (event) {
    var err = event && event.error;
    var hasErr = err && typeof err === "object";
    post(
      hasErr && err.name ? err.name : "Error",
      hasErr && err.message ? err.message : String((event && event.message) || "Unknown error"),
      hasErr && err.stack ? err.stack : undefined,
      { filename: event && event.filename, lineno: event && event.lineno, colno: event && event.colno }
    );
  });

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    var isErr = reason instanceof Error;
    post(
      isErr && reason.name ? reason.name : "UnhandledRejection",
      isErr && reason.message ? reason.message : String(reason),
      isErr && reason.stack ? reason.stack : undefined,
      {}
    );
  });
})();`;
}
