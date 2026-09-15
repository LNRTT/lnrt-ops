import type { Pool } from "pg";
import { getPool } from "./db";
import { migrate } from "./migrate";
import { ALL_MIGRATIONS } from "./migrations/index";
import { opsEnabled } from "./gate";
import { checkBuild, checkDb, checkEnv, checkMigrations } from "./health/checks";
import type { Check } from "./health/index";
import type { OpsUserStore } from "./users";

export type OpsConfig = {
  db: { connectionString: string };
  /** Optional dashboard project URL, e.g. https://replay.example.com/42. */
  openReplay?: { projectUrl: string };
  users: OpsUserStore;
  /** Mints a one-time token, appended as an encoded path segment to an absolute sign-in URL. */
  loginLink?: {
    mint(userId: string): Promise<string>;
    /** Application-relative route, e.g. /invite. */
    path: string;
    /**
     * Optional public HTTP(S) origin, e.g. https://app.example.com. Otherwise
     * the current request's host and protocol are used, including forwarded
     * headers. In that case the reverse proxy must overwrite those headers.
     * Configure this separately in preview and production when pinning it.
     */
    origin?: string;
  };
  /** Environment variable names the health page should require. */
  requiredEnv?: string[];
  /** Extra project-specific checks, appended after the built-ins. */
  health?: Check[];
  /** Reports the host's own pending migration ids, when it can. */
  hostPendingMigrations?: () => Promise<string[]>;
  /**
   * Resolves the current user's id from the host's own session, for a browser-
   * reported error arriving at `/ops/api/ingest` — an endpoint that is reachable
   * without an ops session, so it has no session of its own to read. The endpoint
   * never trusts a body-supplied `userId`; this resolver is the only source it
   * will accept one from. Omit it, or return `undefined`, to leave browser-
   * reported events unattributed.
   *
   * It runs on every well-formed body reaching `/ops/api/ingest` — including
   * anonymous, signed-out traffic — so it **must be cheap** (no slow query;
   * this is not the place for a database round trip on the hot path of an
   * error report) **and must not throw**. If it does throw, the capture still
   * proceeds unattributed rather than being dropped, but the throw is logged
   * once (not on every call) so a broken resolver doesn't fail silently and
   * permanently.
   */
  currentUserId?: (req: Request) => Promise<string | undefined> | string | undefined;
};

export type OpsInstance = {
  config: OpsConfig;
  pool: Pool;
  /** Applies package migrations once per process. Rejections are not cached. */
  ready(): Promise<void>;
  enabled(): boolean;
  checks(): Check[];
};

export function defineOps(config: OpsConfig): OpsInstance {
  if (config.loginLink) {
    const { path, origin } = config.loginLink;
    if (!path.startsWith("/") || path.startsWith("//") || /[\\?#\s\u0000-\u001f\u007f]/.test(path)) {
      throw new Error("loginLink.path must be an application-relative path without a query or fragment.");
    }
    if (origin !== undefined) {
      let url: URL;
      try { url = new URL(origin); } catch {
        throw new Error("loginLink.origin must be a public HTTP(S) origin.");
      }
      if (!/^https?:\/\/[^/\\?#\s]+\/?$/i.test(origin) || !url.hostname || url.username || url.password ||
          url.pathname !== "/" || url.search || url.hash || origin !== origin.trim()) {
        throw new Error("loginLink.origin must be a public HTTP(S) origin.");
      }
    }
  }
  const pool = getPool(config.db.connectionString);
  let readyPromise: Promise<void> | null = null;

  return {
    config,
    pool,
    ready() {
      if (!readyPromise) {
        readyPromise = migrate(pool, ALL_MIGRATIONS)
          .then(() => undefined)
          .catch((err) => {
            // Clear it so the next caller retries. A database that was
            // unreachable once must not poison the instance forever.
            readyPromise = null;
            throw err;
          });
        // Mark the stored promise handled. Callers still receive the rejection
        // through the promise they are returned; this only stops a
        // fire-and-forget `void ops.ready()` from killing the process.
        readyPromise.catch(() => {});
      }
      return readyPromise;
    },
    enabled() { return opsEnabled(); },
    checks() {
      return [
        checkDb(),
        checkEnv(config.requiredEnv ?? []),
        checkBuild(),
        checkMigrations(config.hostPendingMigrations),
        ...(config.health ?? []),
      ];
    },
  };
}
