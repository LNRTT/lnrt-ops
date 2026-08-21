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
        await client.query("ROLLBACK");
        throw err;
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/** Ids present in `migrations` but not yet in the ledger. Read-only. */
export async function pendingMigrations(pool: Pool, migrations: Migration[]): Promise<string[]> {
  await ensureLedger(pool);
  const done = await appliedIds(pool);
  return migrations.filter((m) => !done.has(m.id)).map((m) => m.id);
}
