import type { Pool } from "pg";

export type Migration = { id: string; sql: string };

// Arbitrary but fixed application id. Any process migrating ops_* tables takes this lock.
const LOCK_KEY = 4172025001;

async function ensureLedger(client: { query: Pool["query"] }): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ops_migration (
       id text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

async function appliedIds(client: { query: Pool["query"] }): Promise<Set<string>> {
  const { rows } = await client.query<{ id: string }>("SELECT id FROM ops_migration");
  return new Set(rows.map((r) => r.id));
}

/**
 * Applies every not-yet-applied migration, in order, each in its own transaction,
 * serialised across processes by a Postgres advisory lock. Returns the ids applied
 * by *this* call. Throws on the first failing migration, leaving it pending.
 */
export async function migrate(pool: Pool, migrations: Migration[]): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  // Set when the client is left in a state the pool must not reuse — e.g. a
  // ROLLBACK that itself throws (connection dropped mid-error-handling) can leave
  // the client stuck inside an open transaction.
  let poisoned: Error | undefined;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await ensureLedger(client);
    const done = await appliedIds(client);
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO ops_migration (id) VALUES ($1)", [m.id]);
        await client.query("COMMIT");
        applied.push(m.id);
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          poisoned = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
        }
        throw err;
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    if (poisoned) {
      client.release(poisoned);
    } else {
      client.release();
    }
  }
}

/**
 * Ids present in `migrations` but not yet in the ledger.
 *
 * Genuinely read-only: it must never create the ledger, because the health
 * check calls it on every page view and a database role without CREATE rights
 * would then see a permissions error where it expected a migration status.
 * A missing ledger simply means nothing has been applied yet.
 */
export async function pendingMigrations(pool: Pool, migrations: Migration[]): Promise<string[]> {
  const { rows } = await pool.query<{ t: string | null }>(
    "SELECT to_regclass('ops_migration') AS t",
  );
  if (!rows[0]?.t) return migrations.map((m) => m.id);
  const done = await appliedIds(pool);
  return migrations.filter((m) => !done.has(m.id)).map((m) => m.id);
}
