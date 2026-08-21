import { createHmac, timingSafeEqual } from "node:crypto";
import { writeAudit } from "../server/audit";
import type { OpsInstance } from "../server/config";
import { parseCookie, serializeCookie } from "../server/cookies";
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

// Values reaching the audit table beyond this point are attacker-controlled
// (actor/ip/user-agent on a failed, anonymous login) and the columns are
// unbounded text — cap what we write so a flood cannot also become a way to
// bloat the one record operators trust.
const AUDIT_FIELD_MAX = 200;

function truncate(value: string): string {
  return value.slice(0, AUDIT_FIELD_MAX);
}

function clientIp(req: Request): string {
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  // The last hop is the one our own proxy appended; earlier entries are
  // client-supplied and forgeable, so keying the limiter (or the audit log)
  // on them lets an attacker mint a fresh identity per request.
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

  async function audit(req: Request, actor: string, action: string, summary: string, targetId?: string) {
    await writeAudit(ops.pool, {
      actor: truncate(actor), action, summary,
      targetType: targetId ? "user" : undefined, targetId,
      ip: truncate(clientIp(req)),
      userAgent: req.headers.get("user-agent") ? truncate(req.headers.get("user-agent")!) : undefined,
    });
  }

  /** Audits an action that has already taken effect — a failure here must not read as "nothing happened". */
  async function auditApplied(
    req: Request, actor: string, action: string, summary: string,
    targetId: string | undefined, extraHeaders: Record<string, string | string[]> = {},
  ): Promise<void> {
    try {
      await audit(req, actor, action, summary, targetId);
    } catch {
      throw new AppliedButNotRecorded(extraHeaders);
    }
  }

  // Every authenticated route. CSRF is verified for all of them and an unlisted
  // path is rejected before the switch, so a route added to the switch but not
  // to this set fails loudly with a 404 instead of quietly skipping the check.
  const AUTHENTICATED_PATHS = new Set([
    "logout", "users/create", "users/password", "users/role",
    "users/disable", "users/delete", "users/login-link",
  ]);

  async function POST(req: Request): Promise<Response> {
    if (!ops.enabled()) return respond(404);
    const path = subpath(req);
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
