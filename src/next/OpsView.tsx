import type { ReactNode } from "react";
import { listAudit } from "../server/audit";
import type { OpsInstance } from "../server/config";
import { isAllowedEmail } from "../server/gate";
import { runChecks } from "../server/health/index";
import { parseCookie } from "../server/cookies";
import { csrfToken, readFlash } from "./handlers";
import { OPS_COOKIE, OPS_FLASH_COOKIE, verifyOpsToken } from "../server/opsSession";
import { canHardDelete } from "../server/users";
import { getErrorGroup, listErrorEvents, listErrorGroups, pruneErrors } from "../server/errors/store";
import { OPS_STYLES } from "./styles";
import { Audit } from "./views/Audit";
import { ErrorDetail } from "./views/ErrorDetail";
import { Errors } from "./views/Errors";
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

// Opportunistic prune: at most once an hour per `OpsInstance` *in this
// process*, and never awaited by a render -- a slow or failing prune must
// not delay the errors view, let alone break it. Keyed by the `OpsInstance`
// object's own identity (a WeakMap, so nothing leaks) rather than any global
// state, so distinct instances -- including two in the same test file --
// never share a clock.
//
// That per-process scoping means this is not a system-wide "at most once an
// hour" ceiling: each horizontally-scaled replica holds its own WeakMap, so
// several replicas can each independently decide it's their turn and fire a
// prune within the same hour -- the store can see more than one prune in
// that window in aggregate. This is harmless rather than merely tolerated:
// `pruneErrors` only deletes rows already past its cutoff and adjusts
// `stored_count` to match what it actually removed, so a second, overlapping
// prune from another replica finds nothing left to delete for the rows the
// first one already caught and is a no-op, not a double-decrement. What this
// throttle actually guarantees is "this process's own renders won't trigger
// a prune query more than once an hour," not "the table gets pruned at most
// once an hour across the deployment."
const lastPruneAt = new WeakMap<OpsInstance, number>();
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

function maybePruneErrors(ops: OpsInstance): void {
  const now = Date.now();
  if (now - (lastPruneAt.get(ops) ?? 0) < PRUNE_INTERVAL_MS) return;
  // Marked before the write resolves -- a second render arriving while the
  // first prune is still in flight must not queue a second one.
  lastPruneAt.set(ops, now);
  void pruneErrors(ops.pool).catch((err) => {
    console.error("[ops] opportunistic error prune failed", err);
  });
}

function Shell({ csrf, section, children }: { csrf: string; section: string; children: ReactNode }) {
  return (
    <div className="ops-root">
      {/* The API sets X-Robots-Tag, but this page is rendered by the host's
          own route, which never applies those headers — so say it in the
          markup instead. */}
      <meta name="robots" content="noindex, nofollow" />
      <style>{OPS_STYLES}</style>
      <div className="ops-shell">
        <header className="ops-topbar">
          <a className="ops-brand" href="/ops/users">Operations</a>
          <form method="post" action="/ops/api/logout">
            <input type="hidden" name="csrf" value={csrf} />
            <button type="submit">Sign out</button>
          </form>
        </header>
        <nav className="ops-nav" aria-label="Operations">
          <a href="/ops/users" aria-current={section === "users" ? "page" : undefined}>Users</a>
          <a href="/ops/errors" aria-current={section === "errors" ? "page" : undefined}>Errors</a>
          <a href="/ops/audit" aria-current={section === "audit" ? "page" : undefined}>Audit</a>
          <a href="/ops/health" aria-current={section === "health" ? "page" : undefined}>Health</a>
        </nav>
        <main>{children}</main>
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
  const section = ["errors", "audit", "health"].includes(path[0] ?? "") ? path[0]! : "users";

  // Routed before `ops.ready()`: `ready()` runs migrations and rejects when
  // Postgres is unreachable, and the health page is the one view whose entire
  // job is to report exactly that. `runChecks` isolates each check's own
  // failure, and `checkMigrations` reads the ledger itself (no migration run
  // required), so health needs nothing from `ready()`.
  if (path[0] === "health") {
    return <Shell csrf={csrf} section={section}><Health results={await runChecks(ops.checks(), { pool: ops.pool })} /></Shell>;
  }

  try {
    await ops.ready();
  } catch {
    return (
      <Shell csrf={csrf} section={section}>
        <div className="ops-card">
          <p className="ops-error">The operations database is unavailable.</p>
          <p className="ops-note"><a href="/ops/health">Check the health page</a> for details.</p>
        </div>
      </Shell>
    );
  }

  const store = ops.config.users;

  if (path[0] === "audit") {
    return <Shell csrf={csrf} section={section}><Audit rows={await listAudit(ops.pool, { limit: 200 })} /></Shell>;
  }

  if (path[0] === "errors") {
    // Fire-and-forget, at most once an hour -- must never delay this render
    // or take the page down if it fails.
    maybePruneErrors(ops);

    if (path[1]) {
      const group = await getErrorGroup(ops.pool, path[1]);
      if (!group) return <Shell csrf={csrf} section={section}><div className="ops-card">No such error group.</div></Shell>;
      const events = await listErrorEvents(ops.pool, path[1], 50);
      return <Shell csrf={csrf} section={section}><ErrorDetail group={group} events={events} csrf={csrf} replayProjectUrl={ops.config.openReplay?.projectUrl} /></Shell>;
    }

    const unresolved = one(search.unresolved) === "1";
    const since24h = one(search.since) === "24h";
    const sourceParam = one(search.source);
    const source = sourceParam === "server" || sourceParam === "browser" ? sourceParam : "";
    const userId = one(search.user) || undefined;
    const groups = await listErrorGroups(ops.pool, {
      status: unresolved ? "open" : undefined,
      source: source || undefined,
      since: since24h ? new Date(Date.now() - 24 * 60 * 60 * 1000) : undefined,
      userId,
    });
    return (
      <Shell csrf={csrf} section={section}>
        <Errors groups={groups} unresolved={unresolved} since24h={since24h} source={source} userId={userId} />
      </Shell>
    );
  }

  if (path[0] === "users" && path[1]) {
    const user = await store.get(path[1]);
    if (!user) return <Shell csrf={csrf} section={section}><div className="ops-card">No such user.</div></Shell>;

    // Signature-checked, never JSON.parse: an unsigned flash cookie could be
    // planted by a sibling subdomain to show the operator a sign-in link of the
    // attacker's own choosing.
    let reveal: { kind: "password" | "link"; value: string } | undefined;
    const raw = parseCookie(cookieHeader, OPS_FLASH_COOKIE);
    const flash = raw ? readFlash(raw, process.env.OPS_SECRET ?? "") : null;
    if (flash && flash.user === user.id) reveal = { kind: flash.kind, value: flash.value };

    return (
      <Shell csrf={csrf} section={section}>
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
    <Shell csrf={csrf} section={section}>
      <Users users={users} total={total} query={query} roles={store.roles} csrf={csrf}
        includeDisabled={one(search.disabled) === "1"} allowLoginLink={Boolean(ops.config.loginLink)} />
    </Shell>
  );
}
