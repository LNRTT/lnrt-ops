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
  users: OpsUserStore;
  /** Mints a one-time sign-in token; the link becomes `${path}/${token}`. */
  loginLink?: { mint(userId: string): Promise<string>; path: string };
  /** Environment variable names the health page should require. */
  requiredEnv?: string[];
  /** Extra project-specific checks, appended after the built-ins. */
  health?: Check[];
  /** Reports the host's own pending migration ids, when it can. */
  hostPendingMigrations?: () => Promise<string[]>;
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
  const pool = getPool(config.db.connectionString);
  let readyPromise: Promise<void> | null = null;

  return {
    config,
    pool,
    ready() {
      readyPromise ??= migrate(pool, ALL_MIGRATIONS)
        .then(() => undefined)
        .catch((err) => { readyPromise = null; throw err; });
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
