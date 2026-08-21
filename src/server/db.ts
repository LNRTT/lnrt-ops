import { Pool } from "pg";

const pools = new Map<string, Pool>();

/**
 * One pool per connection string, reused across hot reloads and requests.
 *
 * A pool someone has already ended is treated as absent and replaced. Callers
 * share these by connection string, so without this a single `pool.end()` —
 * an ordinary thing to do in a test teardown — would leave every later caller
 * for the same URL holding a dead pool that throws on every query.
 */
export function getPool(connectionString: string): Pool {
  let pool = pools.get(connectionString);
  if (pool?.ended) pool = undefined;
  if (!pool) {
    pool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
    // A pool-level error (e.g. the database restarting) must never crash the host process.
    pool.on("error", (err) => console.error("[ops] idle client error", err));
    pools.set(connectionString, pool);
  }
  return pool;
}
