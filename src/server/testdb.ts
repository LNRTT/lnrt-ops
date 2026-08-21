import { Pool } from "pg";

/**
 * Creates a dedicated, empty database for one test file and returns its
 * connection string. node:test runs test files in parallel processes, so a
 * shared database makes them race on DDL.
 *
 * Test-only: nothing in the shipped bundle imports this module.
 *
 * Precondition: one test runner at a time per OPS_TEST_DATABASE_URL. The database
 * name is derived from `name` alone, so two concurrent `npm test` runs against the
 * same server (e.g. two sessions sharing this container) will have one run's
 * DROP DATABASE ... WITH (FORCE) terminate the other's live connections. Failures
 * are loud rather than silent, but they are not the code's fault.
 */
export async function createTestDatabase(name: string): Promise<string> {
  const base = process.env.OPS_TEST_DATABASE_URL;
  if (!base) throw new Error("OPS_TEST_DATABASE_URL is not set — see the plan's Global Constraints");
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Invalid test database name: ${name}`);

  const dbName = `ops_test_${name}`;
  const admin = new Pool({ connectionString: base, max: 1 });
  try {
    // FORCE terminates leftover connections from a previous aborted run (PG 13+).
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}
