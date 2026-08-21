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

function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
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

function respond(status: number, body?: BodyInit | null, extra: Record<string, string> = {}): Response {
  return new Response(body ?? null, { status, headers: { ...SECURITY_HEADERS, ...extra } });
}

function redirect(to: string, extra: Record<string, string> = {}): Response {
  return respond(303, null, { Location: to, ...extra });
}

/** Stores a one-time reveal in a short-lived cookie — never in the redirect URL. */
function flashCookie(
  req: Request, payload: { kind: "password" | "link"; user: string; value: string },
): string {
  return serializeCookie(
    OPS_FLASH_COOKIE, JSON.stringify(payload), opsCookieAttrs(60, { secure: isSecureRequest(req) }),
  );
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
      actor, action, summary, targetType: targetId ? "user" : undefined, targetId,
      ip: clientIp(req), userAgent: req.headers.get("user-agent") ?? undefined,
    });
  }

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
      if (await verifyCredentials(email, password)) {
        loginLimiter.reset(ip);
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
    }

    const s = await session(req);
    if (!s) return respond(401, "Not signed in.");
    await ops.ready();

    const store = ops.config.users;
    const id = body.get("id") ?? "";

    switch (path) {
      case "logout":
        await audit(req, s.email, "gate.logout", "Signed out of /ops");
        return redirect(base, {
          "Set-Cookie": serializeCookie(
            OPS_COOKIE, "", opsCookieAttrs(0, { secure: isSecureRequest(req) }),
          ),
        });

      case "users/create": {
        const email = (body.get("email") ?? "").trim();
        const name = (body.get("name") ?? "").trim();
        const role = body.get("role") ?? "";
        if (!email || !name) return respond(400, "Email and name are required.");
        if (!store.roles.includes(role)) return respond(400, "Unknown role.");
        const user = await store.create({ email, name, role });
        await audit(req, s.email, "user.create", `Created ${email} as ${role}`, user.id);
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
        await audit(req, s.email, "user.password", "Set a new password", id);
        return redirect(`${base}/users/${id}`, {
          "Set-Cookie": flashCookie(req, { kind: "password", user: id, value: plaintext }),
        });
      }

      case "users/role": {
        const role = body.get("role") ?? "";
        if (!store.roles.includes(role)) return respond(400, "Unknown role.");
        await store.setRole(id, role);
        await audit(req, s.email, "user.role", `Changed role to ${role}`, id);
        return redirect(`${base}/users/${id}`);
      }

      case "users/disable": {
        const disabled = body.get("disabled") === "1";
        await store.setDisabled(id, disabled);
        await audit(req, s.email, "user.disable", disabled ? "Disabled the account" : "Restored the account", id);
        return redirect(`${base}/users/${id}`);
      }

      case "users/delete": {
        if (!canHardDelete(store)) return respond(400, "This project does not support hard deletion.");
        const user = await store.get(id);
        if (!user) return respond(404, "No such user.");
        if (body.get("confirm")?.trim().toLowerCase() !== user.email.toLowerCase()) {
          return respond(400, "Type the user's email address to confirm.");
        }
        await store.hardDelete!(id);
        await audit(req, s.email, "user.delete", `Permanently deleted ${user.email}`, id);
        return redirect(`${base}/users`);
      }

      case "users/login-link": {
        if (!ops.config.loginLink) return respond(400, "This project has no login-link support.");
        if (!(await store.get(id))) return respond(404, "No such user.");
        const token = await ops.config.loginLink.mint(id);
        await audit(req, s.email, "user.login-link", "Minted a sign-in link", id);
        return redirect(`${base}/users/${id}`, {
          "Set-Cookie": flashCookie(req, { kind: "link", user: id, value: `${ops.config.loginLink.path}/${token}` }),
        });
      }

      default:
        return respond(404);
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
