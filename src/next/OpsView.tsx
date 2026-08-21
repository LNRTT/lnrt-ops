import type { ReactNode } from "react";
import { listAudit } from "../server/audit";
import type { OpsInstance } from "../server/config";
import { isAllowedEmail } from "../server/gate";
import { runChecks } from "../server/health/index";
import { parseCookie } from "../server/cookies";
import { csrfToken, readFlash } from "./handlers";
import { OPS_COOKIE, OPS_FLASH_COOKIE, verifyOpsToken } from "../server/opsSession";
import { canHardDelete } from "../server/users";
import { OPS_STYLES } from "./styles";
import { Audit } from "./views/Audit";
import { Health } from "./views/Health";
import { Login } from "./views/Login";
import { UserDetail } from "./views/UserDetail";
import { Users } from "./views/Users";

type SearchParams = Record<string, string | string[] | undefined>;

export type OpsViewProps = {
  ops: OpsInstance;
  path: string[];
  search: SearchParams;
  /** Raw `Cookie:` header. The caller decides how to obtain it. */
  cookieHeader: string;
};

function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function Shell({ csrf, children }: { csrf: string; children: ReactNode }) {
  return (
    <div className="ops-root">
      {/* The API sets X-Robots-Tag, but this page is rendered by the host's
          own route, which never applies those headers — so say it in the
          markup instead. */}
      <meta name="robots" content="noindex, nofollow" />
      <style>{OPS_STYLES}</style>
      <div className="ops-shell">
        <nav className="ops-nav">
          <a href="/ops/users">Users</a>
          <a href="/ops/audit">Audit</a>
          <a href="/ops/health">Health</a>
          <span className="ops-spacer" />
          <form method="post" action="/ops/api/logout">
            <input type="hidden" name="csrf" value={csrf} />
            <button type="submit">Sign out</button>
          </form>
        </nav>
        {children}
      </div>
    </div>
  );
}

export async function OpsView({ ops, path, search, cookieHeader }: OpsViewProps) {
  if (!ops.enabled()) {
    // Should be unreachable: the host route is expected to 404 first. Belt and braces.
    return <div className="ops-root">Not found.</div>;
  }

  const token = parseCookie(cookieHeader, OPS_COOKIE);
  const s = await verifyOpsToken(token, process.env.OPS_SECRET ?? "");
  if (!s || !isAllowedEmail(s.email)) {
    return (
      <div className="ops-root">
        <meta name="robots" content="noindex, nofollow" />
        <style>{OPS_STYLES}</style>
        <Login error={one(search.error) || undefined} />
      </div>
    );
  }

  const csrf = csrfToken(s.email, process.env.OPS_SECRET ?? "");

  // Routed before `ops.ready()`: `ready()` runs migrations and rejects when
  // Postgres is unreachable, and the health page is the one view whose entire
  // job is to report exactly that. `runChecks` isolates each check's own
  // failure, and `checkMigrations` reads the ledger itself (no migration run
  // required), so health needs nothing from `ready()`.
  if (path[0] === "health") {
    return <Shell csrf={csrf}><Health results={await runChecks(ops.checks(), { pool: ops.pool })} /></Shell>;
  }

  try {
    await ops.ready();
  } catch {
    return (
      <Shell csrf={csrf}>
        <div className="ops-card">
          <p className="ops-error">The operations database is unavailable.</p>
          <p className="ops-note"><a href="/ops/health">Check the health page</a> for details.</p>
        </div>
      </Shell>
    );
  }

  const store = ops.config.users;

  if (path[0] === "audit") {
    return <Shell csrf={csrf}><Audit rows={await listAudit(ops.pool, { limit: 200 })} /></Shell>;
  }

  if (path[0] === "users" && path[1]) {
    const user = await store.get(path[1]);
    if (!user) return <Shell csrf={csrf}><div className="ops-card">No such user.</div></Shell>;

    // Signature-checked, never JSON.parse: an unsigned flash cookie could be
    // planted by a sibling subdomain to show the operator a sign-in link of the
    // attacker's own choosing.
    let reveal: { kind: "password" | "link"; value: string } | undefined;
    const raw = parseCookie(cookieHeader, OPS_FLASH_COOKIE);
    const flash = raw ? readFlash(raw, process.env.OPS_SECRET ?? "") : null;
    if (flash && flash.user === user.id) reveal = { kind: flash.kind, value: flash.value };

    return (
      <Shell csrf={csrf}>
        <UserDetail
          user={user}
          roles={store.roles}
          allowDelete={canHardDelete(store)}
          allowLoginLink={Boolean(ops.config.loginLink)}
          reveal={reveal}
          csrf={csrf}
        />
      </Shell>
    );
  }

  const query = one(search.q);
  const { users, total } = await store.list({
    search: query || undefined,
    includeDisabled: one(search.disabled) === "1",
  });
  return (
    <Shell csrf={csrf}>
      <Users users={users} total={total} query={query} roles={store.roles} csrf={csrf} />
    </Shell>
  );
}
