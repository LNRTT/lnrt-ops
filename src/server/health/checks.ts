import { pendingMigrations } from "../migrate";
import { ALL_MIGRATIONS } from "../migrations/index";
import type { Check } from "./index";

const SLOW_DB_MS = 250;

export function checkDb(): Check {
  return {
    id: "db", label: "Database",
    async run({ pool }) {
      const started = Date.now();
      await pool.query("SELECT 1");
      const ms = Date.now() - started;
      return ms > SLOW_DB_MS
        ? { status: "warn", detail: `Reachable, but slow: ${ms} ms` }
        : { status: "ok", detail: `${ms} ms` };
    },
  };
}

/** Reports only which names are absent. Values are never read or displayed. */
export function checkEnv(names: string[]): Check {
  return {
    id: "env", label: "Environment",
    async run() {
      const missing = names.filter((n) => !process.env[n]?.trim());
      return missing.length
        ? { status: "fail", detail: `Missing: ${missing.join(", ")}` }
        : { status: "ok", detail: `${names.length} required variables present` };
    },
  };
}

export function checkBuild(): Check {
  return {
    id: "build", label: "Build",
    async run() {
      const release =
        process.env.OPS_RELEASE ?? process.env.GIT_SHA ?? process.env.SOURCE_COMMIT ?? "unknown";
      const uptimeMin = Math.floor(process.uptime() / 60);
      return { status: "ok", detail: `release ${release}, node ${process.version}, up ${uptimeMin} min` };
    },
  };
}

/**
 * Checks the package's own migrations, plus the host's when it supplies a
 * reporter. Pending host migrations are a failure, not a warning: it is the
 * single most common cause of a broken production deploy in these projects.
 */
export function checkMigrations(hostPending?: () => Promise<string[]>): Check {
  return {
    id: "migrations", label: "Migrations",
    async run({ pool }) {
      const ops = await pendingMigrations(pool, ALL_MIGRATIONS);
      const host = hostPending ? await hostPending() : [];
      const parts: string[] = [];
      if (ops.length) parts.push(`ops: ${ops.join(", ")}`);
      if (host.length) parts.push(`app: ${host.join(", ")}`);
      return parts.length
        ? { status: "fail", detail: `Pending — ${parts.join("; ")}` }
        : { status: "ok", detail: "Up to date" };
    },
  };
}
