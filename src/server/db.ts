import { Pool } from "pg";

const pools = new Map<string, Pool>();

/** One pool per connection string, reused across hot reloads and requests. */
export function getPool(connectionString: string): Pool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 30_000 });
    // A pool-level error (e.g. the database restarting) must never crash the host process.
    pool.on("error", (err) => console.error("[ops] idle client error", err));
    pools.set(connectionString, pool);
  }
  return pool;
}
