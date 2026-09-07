import { openReplayUrl } from "../shared/openreplay";
import { createHmac, timingSafeEqual } from "node:crypto";
import { writeAudit } from "../server/audit";
import type { OpsInstance } from "../server/config";
import { parseCookie, serializeCookie } from "../server/cookies";
import { getErrorGroup, recordError, setErrorGroupStatus, type CapturedError } from "../server/errors/store";
import { isAllowedEmail, verifyCredentials } from "../server/gate";
import { runChecks } from "../server/health/index";
import {
  OPS_COOKIE, OPS_FLASH_COOKIE, OPS_TTL_SECONDS, opsCookieAttrs,
  signOpsToken, verifyOpsToken,
} from "../server/opsSession";
import { makeRateLimiter } from "../server/ratelimit";
import { canHardDelete, resetPassword } from "../server/users";

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
};

const loginLimiter = makeRateLimiter({ limit: 5, windowMs: 15 * 60_000, blockMs: 15 * 60_000 });

// A public, unauthenticated write endpoint -- 20 requests per minute per IP,
// separate state from loginLimiter so a flood of browser error reports can
// never eat into (or be eaten by) the login lockout's own budget.
const ingestLimiter = makeRateLimiter({ limit: 20, windowMs: 60_000, blockMs: 60_000 });

// Backstop for the per-IP limiter above: an attacker who rotates edges (or
// reaches the origin directly, bypassing any proxy that would normally set
// cf-connecting-ip/x-real-ip) can still mint a fresh clientIp() identity per
// request, and 20/minute *per identity* has no ceiling in aggregate. This
// single shared key bounds the whole endpoint regardless of how many
// distinct source addresses are behind the flood.
const INGEST_GLOBAL_LIMIT = 600;
const globalIngestLimiter = makeRateLimiter({ limit: INGEST_GLOBAL_LIMIT, windowMs: 60_000, blockMs: 60_000 });
const GLOBAL_INGEST_KEY = "*";

// Real request bodies from a browser's own error/rejection handlers are a few
// hundred bytes; 16 KB leaves headroom for a large stack or context object
// without letting the endpoint become a place to dump arbitrary data.
const MAX_INGEST_BYTES = 16 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * True only when the request's own `Origin` (or, failing that, `Referer`)
 * names this same host. `/ops/api/ingest` takes no ops session and no CSRF
 * token -- this same-origin check is the only thing standing between it and
 * any page on the internet POSTing arbitrary "error reports" into the store.
 * Neither header present is refused, not allowed: there is nothing to verify
 * same-origin-ness against.
 *
 * What this is NOT: a general-purpose defence. A real browser cannot be made
 * to lie about `Origin`, which is what stops a drive-by cross-site POST from
 * a page a victim happens to have open -- but nothing stops a non-browser
 * client from setting whatever `Origin` it likes; `curl -H 'Origin:
 * https://this-host'` sails straight through. The size cap and rate limits
 * below are what actually bound a client that isn't playing by browser rules.
 */
/**
 * Every host this request could legitimately claim to be. Behind a reverse
 * proxy `req.url` carries the internal address (`localhost:3000`), not the
 * public one, so comparing against it alone rejects every genuine browser
 * report in a proxied deployment. The forwarded headers are what the proxy
 * says the client asked for.
 *
 * Trusting them costs nothing here: a non-browser client can already set
 * `Origin` to anything, so this check only ever bound real browsers.
 */
function acceptableHosts(req: Request): Set<string> {
  const hosts = new Set<string>();
  for (const name of ["x-forwarded-host", "host"]) {
    const value = req.headers.get(name);
    if (value) for (const h of value.split(",")) if (h.trim()) hosts.add(h.trim());
  }
  try {
    hosts.add(new URL(req.url).host);
  } catch {
    // A malformed request URL leaves the forwarded headers to decide.
  }
  return hosts;
}

function isSameOriginIngest(req: Request): boolean {
  const hosts = acceptableHosts(req);
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return hosts.has(new URL(origin).host);
    } catch {
      return false;
    }
  }
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return hosts.has(new URL(referer).host);
    } catch {
      return false;
    }
  }
  return false;
}

// Values reaching the audit table beyond this point are attacker-controlled
// (actor/ip/user-agent on a failed, anonymous login) and the columns are
// unbounded text — cap what we write so a flood cannot also become a way to
// bloat the one record operators trust.
const AUDIT_FIELD_MAX = 200;

function truncate(value: string): string {
  return value.slice(0, AUDIT_FIELD_MAX);
}

/**
 * Reads a request body as a stream, aborting the instant the accumulated
 * byte count passes `maxBytes` -- unlike `await req.text()`, which buffers
 * the entire body before anything can measure it. A chunked POST with no
 * `Content-Length` (or one that simply lies about it) has no other limit at
 * all in an App Router route handler; a handful of concurrent multi-hundred-
 * megabyte bodies is enough to OOM-kill the whole container. `req.body`
 * missing (no body at all) is treated as an empty body, not an error.
 *
 * Returns `{ ok: false }` the moment the cap is passed -- the stream is
 * cancelled immediately rather than drained, so the rest of an oversized
 * body is never read off the wire by this process at all. A genuine
 * mid-stream read error (a dropped connection, not a cap trip) resolves to
 * an empty body rather than rejecting, matching the old `req.text()` catch
 * this replaces: a failing ingest must never surface as an error.
 */
async function readCappedBody(req: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!req.body) return { ok: true, text: "" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: true, text: "" };
  }
  return { ok: true, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8") };
}

/**
 * Shared by both rate limiters (`loginLimiter` and `ingestLimiter`) and by
 * the audit log -- one helper, every call site, so a fix here does not need
 * a second copy applied somewhere else.
 *
 * Prefers `cf-connecting-ip`, then `x-real-ip`, then the last `x-forwarded-
 * for` hop, in that order. The old last-XFF-hop-only behaviour was wrong in
 * both directions behind Cloudflare: it is Cloudflare's own edge address,
 * not the visitor's, so (a) every real visitor sharing one edge collapsed
 * into a single bucket -- during a genuine incident, the 21st distinct
 * report in a minute from *different* people got dropped -- and (b) an
 * attacker could still rotate edges, or reach the origin directly and set
 * whatever `x-forwarded-for` they liked, for a fresh identity every time.
 * `cf-connecting-ip`/`x-real-ip` are set by the edge/proxy itself rather
 * than copied client-by-client along a hop chain, so they resist (b) the
 * same way the old code intended the last XFF hop to.
 *
 * This does not, by itself, stop an attacker who reaches the origin
 * directly (bypassing Cloudflare, so neither header is set) from forging
 * `x-forwarded-for` -- that is what the process-wide ingest ceiling
 * (`globalIngestLimiter`) exists to bound.
 *
 * No forwarding header at all collapses onto the single string "unknown" --
 * acceptable (this only happens direct-to-origin in practice, and even then
 * the global ceiling still applies), but worth noting: every such caller
 * then shares one limiter bucket and one audit-log identity.
 */
function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops.at(-1) || "unknown";
}

/**
 * Whether to set `Secure` on the ops cookie. Defaults to true and only drops it
 * for plain HTTP to a loopback host — i.e. local development. Behind a TLS
 * terminator the scheme arrives in x-forwarded-proto, so a proxied HTTPS
 * request keeps the flag.
 */
function isSecureRequest(req: Request): boolean {
  const forwarded = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim();
  const url = new URL(req.url);
  const scheme = forwarded || url.protocol.replace(":", "");
  if (scheme === "https") return true;
  return !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
}

function respond(
  status: number, body?: BodyInit | null, extra: Record<string, string | string[]> = {},
): Response {
  const headers = new Headers(SECURITY_HEADERS);
  for (const [k, v] of Object.entries(extra)) {
    for (const item of Array.isArray(v) ? v : [v]) headers.append(k, item);
  }
  return new Response(body ?? null, { status, headers });
}

function redirect(to: string, extra: Record<string, string | string[]> = {}): Response {
  return respond(303, null, { Location: to, ...extra });
}

// --- CSRF -------------------------------------------------------------
//
// SameSite=Strict blocks cross-*site* POSTs, but "same site" is registrable-
// domain scoped: a sibling subdomain of the host app (a docs host, a
// user-content host — anything this package cannot know about) can still
// auto-submit a form and have the strict cookie sent along. The token below
// is stateless — an HMAC of the signed-in operator's email under OPS_SECRET —
// so nothing needs to be stored; the same value can be recomputed server-side
// to check what a form posts back.

/** Stateless CSRF token bound to the signed-in operator. No storage needed. */
export function csrfToken(email: string, secret: string): string {
  return createHmac("sha256", secret).update(`csrf:${email}`).digest("base64url");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// --- Flash cookie -------------------------------------------------------
//
// Carries a one-time reveal (a generated password or a minted login link)
// from a POST to the redirect target, without ever putting the secret in the
// URL. It is signed with OPS_SECRET so a sibling subdomain cannot forge one
// and have the portal render an attacker-chosen link or password to the
// operator.

export type FlashPayload = { kind: "password" | "link"; user: string; value: string };

function signFlashPayload(json: string, secret: string): string {
  return createHmac("sha256", secret).update(json).digest("base64url");
}

/**
 * Signs a flash payload into the raw cookie value `readFlash` expects
 * (`${json}.${sig}`). Exported so tests can construct a validly-signed flash
 * cookie the same way a real request does, without going through a full POST.
 */
export function signFlash(payload: FlashPayload, secret: string): string {
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${json}.${signFlashPayload(json, secret)}`;
}

/** Stores a one-time reveal in a short-lived, signed cookie — never in the redirect URL. */
function flashCookie(req: Request, payload: FlashPayload): string {
  const secret = process.env.OPS_SECRET!;
  return serializeCookie(
    OPS_FLASH_COOKIE, signFlash(payload, secret), opsCookieAttrs(60, { secure: isSecureRequest(req) }),
  );
}

/** Verifies and decodes a flash cookie's raw value. Returns null on a bad or missing signature. */
export function readFlash(raw: string, secret: string): FlashPayload | null {
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return null;
  const json = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!json || !sig) return null;
  if (!timingSafeStringEqual(sig, signFlashPayload(json, secret))) return null;
  try {
    return JSON.parse(Buffer.from(json, "base64url").toString("utf8")) as FlashPayload;
  } catch {
    return null;
  }
}

function clearedFlashCookie(req: Request): string {
  return serializeCookie(OPS_FLASH_COOKIE, "", opsCookieAttrs(0, { secure: isSecureRequest(req) }));
}

// --- Audit-then-fail ordering -------------------------------------------
//
// Every route mutates first and audits second. If the audit write throws
// after a mutation already committed, the operator must not be left with a
// bare, unexplained 500 that also swallows a secret they need (a freshly
// reset password, a minted sign-in link) — they still need that value, and
// they need to know the audit trail is now short one entry.

/** Thrown when the change went through but the audit write did not. */
class AppliedButNotRecorded extends Error {
  constructor(readonly extraHeaders: Record<string, string | string[]> = {}) {
    super(
      "The change was applied, but it could not be written to the audit log. " +
      "Check the audit log before retrying.",
    );
  }
}

export function createHandlers(ops: OpsInstance) {
  const base = "/ops";

  async function session(req: Request): Promise<{ email: string } | null> {
    const secret = process.env.OPS_SECRET;
    if (!secret) return null;
    const s = await verifyOpsToken(parseCookie(req.headers.get("cookie") ?? "", OPS_COOKIE), secret);
    return s && isAllowedEmail(s.email) ? s : null;
  }

  function subpath(req: Request): string {
    return new URL(req.url).pathname.replace(/^\/ops\/api\/?/, "");
  }

  async function audit(
    req: Request, actor: string, action: string, summary: string, targetId?: string, targetType = "user",
  ) {
    await writeAudit(ops.pool, {
      actor: truncate(actor), action, summary,
      targetType: targetId ? targetType : undefined, targetId,
      ip: truncate(clientIp(req)),
      userAgent: req.headers.get("user-agent") ? truncate(req.headers.get("user-agent")!) : undefined,
    });
  }

  /** Audits an action that has already taken effect — a failure here must not read as "nothing happened". */
  async function auditApplied(
    req: Request, actor: string, action: string, summary: string,
    targetId: string | undefined, extraHeaders: Record<string, string | string[]> = {}, targetType = "user",
  ): Promise<void> {
    try {
      await audit(req, actor, action, summary, targetId, targetType);
    } catch {
      throw new AppliedButNotRecorded(extraHeaders);
    }
  }

  // `browserEventFromBody` runs on every well-formed body, for anonymous
  // traffic -- a `currentUserId` that throws must not be allowed to fail
  // silently forever (the previous catch-and-discard around the whole
  // function swallowed it with no log at all). Logged once per handlers
  // instance rather than once per process: two different hosts sharing this
  // module in one test run (or, in principle, one process) each get their
  // own signal that their own resolver is broken.
  let currentUserIdWarned = false;

  // Bounds how many `recordError` writes this handlers instance lets run
  // concurrently in the background (see `handleIngest`). Small on purpose:
  // each one holds a pool connection for a transaction, and the pool itself
  // only has four.
  const MAX_INFLIGHT_CAPTURES = 8;
  let inFlightCaptures = 0;

  /**
   * Parses a browser-reported error out of the request body. Everything is
   * taken from the body except `source` (always forced to `"browser"`) and
   * `userId` (never read from the body -- resolved, if at all, from the
   * host's own session via `ops.config.currentUserId`). Returns `null` for
   * anything not shaped like a usable report; the caller discards silently
   * rather than surfacing that to whatever POSTed it.
   */
  async function browserEventFromBody(raw: string, req: Request): Promise<CapturedError | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isPlainObject(parsed)) return null;

    const message = stringField(parsed.message);
    if (!message) return null;

    let userId: string | undefined;
    if (ops.config.currentUserId) {
      try {
        userId = await ops.config.currentUserId(req);
      } catch (err) {
        // Attribution is best-effort and must not fail the capture -- but a
        // resolver that throws can otherwise die silently and permanently,
        // with no signal it ever happened.
        if (!currentUserIdWarned) {
          currentUserIdWarned = true;
          console.error("[ops] currentUserId resolver threw; browser-reported errors will be unattributed", err);
        }
        userId = undefined;
      }
    }

    const context = isPlainObject(parsed.context) ? { ...parsed.context } : undefined;
    if (context) {
      const url = ops.config.openReplay ? openReplayUrl(context.openReplayUrl, ops.config.openReplay.projectUrl) : undefined;
      delete context.openReplayUrl;
      if (url) context.openReplayUrl = url;
    }
    return {
      type: stringField(parsed.type) ?? "Error",
      message,
      stack: stringField(parsed.stack),
      source: "browser",
      url: stringField(parsed.url),
      method: stringField(parsed.method),
      userId,
      userRole: stringField(parsed.userRole),
      requestId: stringField(parsed.requestId),
      release: stringField(parsed.release),
      userAgent: stringField(parsed.userAgent) ?? req.headers.get("user-agent") ?? undefined,
      context,
    };
  }

  /**
   * POST /ops/api/ingest -- takes no ops session (errors happen to ordinary
   * and signed-out users, who never have one) and no CSRF token (there is no
   * session to bind one to). Its defences are: same-origin, a size cap, a
   * per-IP rate limit, and a process-wide rate ceiling. Past those gates
   * this always answers 204, even when it silently discards a malformed or
   * unstorable report -- a failing ingest must never surface as an error of
   * its own to a user who is already looking at a broken page.
   *
   * The write itself happens in the background, after this responds: each
   * capture takes a pool connection for a transaction, and awaiting that
   * inline would let a modest flood pin all four connections in the pool,
   * stalling `/ops` health and the error views themselves -- the diagnostic
   * tool dying under the exact attack it exists to reveal. In-flight
   * background writes are bounded by `MAX_INFLIGHT_CAPTURES`; past that, a
   * capture is dropped outright rather than queued, which is the same
   * "discard rather than let it become the outage" choice as everything
   * else this handler does under load.
   */
  async function handleIngest(req: Request): Promise<Response> {
    if (!isSameOriginIngest(req)) return respond(403);

    const ip = clientIp(req);
    const gate = ingestLimiter.check(ip);
    if (!gate.ok) {
      return respond(429, null, { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) });
    }
    const globalGate = globalIngestLimiter.check(GLOBAL_INGEST_KEY);
    if (!globalGate.ok) {
      return respond(429, null, { "Retry-After": String(Math.ceil(globalGate.retryAfterMs / 1000)) });
    }
    // Every accepted-so-far request counts against both budgets, not just failures.
    ingestLimiter.fail(ip);
    globalIngestLimiter.fail(GLOBAL_INGEST_KEY);

    // Cheap early rejection when the client is honest about Content-Length --
    // but never relied on alone: a chunked request, or one that lies, skips
    // straight past this and is caught by the streaming read below instead.
    const contentLength = req.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_INGEST_BYTES) {
      return respond(413);
    }

    const body = await readCappedBody(req, MAX_INGEST_BYTES);
    if (!body.ok) return respond(413);
    const raw = body.text;

    if (inFlightCaptures >= MAX_INFLIGHT_CAPTURES) {
      return respond(204); // Drop under flood -- see the docstring above.
    }
    inFlightCaptures++;
    void (async () => {
      try {
        await ops.ready();
        const event = await browserEventFromBody(raw, req);
        if (event) await recordError(ops.pool, event);
      } catch {
        // Malformed payload, a resolver that threw (already logged once,
        // above), or a storage failure -- discard silently. recordError
        // itself never throws either way; this guards ops.ready() and the
        // parse above it.
      } finally {
        inFlightCaptures--;
      }
    })();

    return respond(204);
  }

  // Every authenticated route. CSRF is verified for all of them and an unlisted
  // path is rejected before the switch, so a route added to the switch but not
  // to this set fails loudly with a 404 instead of quietly skipping the check.
  const AUTHENTICATED_PATHS = new Set([
    "logout", "users/create", "users/password", "users/role",
    "users/disable", "users/delete", "users/login-link", "errors/status",
  ]);

  async function POST(req: Request): Promise<Response> {
    if (!ops.enabled()) return respond(404);
    const path = subpath(req);

    // Reachable without an ops session, alongside login below -- unlike every
    // other route it never reaches AUTHENTICATED_PATHS or the CSRF check, and
    // it parses its own (JSON, not form-urlencoded) body, so it must branch
    // before the shared `body` parse just below.
    if (path === "ingest") return handleIngest(req);

    const body = new URLSearchParams(await req.text());

    if (path === "login") {
      await ops.ready();
      const ip = clientIp(req);
      const gate = loginLimiter.check(ip);
      if (!gate.ok) {
        return respond(429, "Too many attempts.", { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) });
      }
      const email = (body.get("email") ?? "").trim();
      const password = body.get("password") ?? "";
      try {
        if (await verifyCredentials(email, password)) {
          loginLimiter.reset(ip);
          // If this write fails, no cookie has been set yet below, so
          // nothing has actually changed from the client's perspective —
          // a plain audit() (caught by the generic branch) is correct here.
          await audit(req, email, "gate.login", "Signed in to /ops");
          const token = await signOpsToken(email, process.env.OPS_SECRET!);
          return redirect(`${base}/users`, {
            "Set-Cookie": serializeCookie(
              OPS_COOKIE, token, opsCookieAttrs(OPS_TTL_SECONDS, { secure: isSecureRequest(req) }),
            ),
          });
        }
        loginLimiter.fail(ip);
        // The attempted password is deliberately absent from the record.
        await audit(req, email || "unknown", "gate.login.failed", "Rejected sign-in attempt");
        return redirect(`${base}?error=invalid`);
      } catch (err) {
        if (err instanceof AppliedButNotRecorded) return respond(500, err.message, err.extraHeaders);
        return respond(500, "The action failed. Nothing was changed.");
      }
    }

    const s = await session(req);
    if (!s) return respond(401, "Not signed in.");

    if (!AUTHENTICATED_PATHS.has(path)) return respond(404);

    const supplied = body.get("csrf") ?? "";
    const expected = csrfToken(s.email, process.env.OPS_SECRET!);
    if (!timingSafeStringEqual(supplied, expected)) {
      return respond(403, "Invalid or missing CSRF token.");
    }

    await ops.ready();

    const store = ops.config.users;
    const id = body.get("id") ?? "";

    try {
      switch (path) {
        case "logout": {
          // No persistent mutation happens here — only the response we are
          // about to build clears the cookies. If the audit write throws,
          // that response never gets sent, so "nothing changed" is literally
          // true: a plain audit() is correct.
          await audit(req, s.email, "gate.logout", "Signed out of /ops");
          return redirect(base, {
            "Set-Cookie": [
              serializeCookie(OPS_COOKIE, "", opsCookieAttrs(0, { secure: isSecureRequest(req) })),
              clearedFlashCookie(req),
            ],
          });
        }

        case "users/create": {
          const email = (body.get("email") ?? "").trim();
          const name = (body.get("name") ?? "").trim();
          const role = body.get("role") ?? "";
          if (!email || !name) return respond(400, "Email and name are required.");
          if (!store.roles.includes(role)) return respond(400, "Unknown role.");
          const user = await store.create({ email, name, role });
          // Unlike the password/login-link reveals below, a lost audit write
          // here is recoverable without extraHeaders: the user row exists,
          // an operator can find it and mint a fresh login link at any time.
          await auditApplied(req, s.email, "user.create", `Created ${email} as ${role}`, user.id);
          if (ops.config.loginLink) {
            const token = await ops.config.loginLink.mint(user.id);
            return redirect(`${base}/users/${user.id}`, {
              "Set-Cookie": flashCookie(req, { kind: "link", user: user.id, value: `${ops.config.loginLink.path}/${token}` }),
            });
          }
          return redirect(`${base}/users/${user.id}`);
        }

        case "users/password": {
          if (!(await store.get(id))) return respond(404, "No such user.");
          const explicit = body.get("password")?.trim() || undefined;
          let plaintext: string;
          try {
            plaintext = await resetPassword(store, id, explicit);
          } catch (err) {
            return respond(400, err instanceof Error ? err.message : "Invalid password.");
          }
          const flash = flashCookie(req, { kind: "password", user: id, value: plaintext });
          // The whole point: if the audit write fails, the operator must
          // still get the new password back — it cannot be recovered later.
          await auditApplied(req, s.email, "user.password", "Set a new password", id, { "Set-Cookie": flash });
          return redirect(`${base}/users/${id}`, { "Set-Cookie": flash });
        }

        case "users/role": {
          const role = body.get("role") ?? "";
          if (!store.roles.includes(role)) return respond(400, "Unknown role.");
          if (!(await store.get(id))) return respond(404, "No such user.");
          await store.setRole(id, role);
          await auditApplied(req, s.email, "user.role", `Changed role to ${role}`, id);
          return redirect(`${base}/users/${id}`);
        }

        case "users/disable": {
          const raw = body.get("disabled");
          if (raw !== "1" && raw !== "0") {
            return respond(400, 'The "disabled" field must be exactly "1" or "0".');
          }
          const disabled = raw === "1";
          if (!(await store.get(id))) return respond(404, "No such user.");
          await store.setDisabled(id, disabled);
          await auditApplied(
            req, s.email, "user.disable", disabled ? "Disabled the account" : "Restored the account", id,
          );
          return redirect(`${base}/users/${id}`);
        }

        case "users/delete": {
          if (!canHardDelete(store)) return respond(400, "This project does not support hard deletion.");
          const user = await store.get(id);
          if (!user) return respond(404, "No such user.");
          if (body.get("confirm")?.trim().toLowerCase() !== user.email.toLowerCase()) {
            // A refused delete on the most destructive route still leaves a trace.
            await audit(req, s.email, "user.delete.refused", `Refused to delete ${user.email}: confirmation mismatch`, id);
            return respond(400, "Type the user's email address to confirm.");
          }
          // Irreversible: audit the intent before the call, so a failure in
          // hardDelete (or in the completion audit below) still leaves a
          // truthful trace that the deletion was attempted.
          await audit(req, s.email, "user.delete.attempt", `Attempting to permanently delete ${user.email}`, id);
          await store.hardDelete!(id);
          await auditApplied(req, s.email, "user.delete", `Permanently deleted ${user.email}`, id);
          return redirect(`${base}/users`);
        }

        case "users/login-link": {
          if (!ops.config.loginLink) return respond(400, "This project has no login-link support.");
          if (!(await store.get(id))) return respond(404, "No such user.");
          const token = await ops.config.loginLink.mint(id);
          const flash = flashCookie(req, { kind: "link", user: id, value: `${ops.config.loginLink.path}/${token}` });
          await auditApplied(req, s.email, "user.login-link", "Minted a sign-in link", id, { "Set-Cookie": flash });
          return redirect(`${base}/users/${id}`, { "Set-Cookie": flash });
        }

        case "errors/status": {
          const raw = body.get("status");
          if (raw !== "resolved" && raw !== "ignored") {
            return respond(400, 'The "status" field must be exactly "resolved" or "ignored".');
          }
          if (!(await getErrorGroup(ops.pool, id))) return respond(404, "No such error group.");
          await setErrorGroupStatus(ops.pool, id, raw);
          // The group id is a fingerprint hash, not attacker-supplied text --
          // unlike its type/message/stack, it is safe to write straight into
          // the audit summary; an operator can look the id up on the errors
          // page for the full, redacted detail.
          await auditApplied(req, s.email, "error.status", `Marked error group ${id} as ${raw}`, id, {}, "error");
          return redirect(`${base}/errors/${id}`);
        }

        default:
          return respond(404);
      }
    } catch (err) {
      if (err instanceof AppliedButNotRecorded) return respond(500, err.message, err.extraHeaders);
      return respond(500, "The action failed. Nothing was changed.");
    }
  }

  async function GET(req: Request): Promise<Response> {
    if (!ops.enabled()) return respond(404);
    if (subpath(req) !== "health") return respond(404);
    if (!(await session(req))) return respond(401, "Not signed in.");
    await ops.ready();
    const checks = await runChecks(ops.checks(), { pool: ops.pool });
    return respond(200, JSON.stringify({ checks }), { "Content-Type": "application/json" });
  }

  return { GET, POST };
}
