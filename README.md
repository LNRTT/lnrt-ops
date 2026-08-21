# @lnrt/ops

A reusable operator portal that LNRT Next.js projects mount at `/ops`: a login-gated
admin surface for user administration, an audit log, and health checks, backed by a
self-applying Postgres schema.

## Status

Early scaffold. This package currently ships:

- `getPool(connectionString)` — one pooled `pg.Pool` per connection string, reused
  across hot reloads and requests.
- `migrate(pool, migrations)` / `pendingMigrations(pool, migrations)` — an
  advisory-locked SQL migrator. Migrations are plain TypeScript modules that export
  SQL strings (never files read from disk at runtime, since the package ships
  bundled), applied in order, each in its own transaction.
- `ALL_MIGRATIONS` — the package's own schema history, starting with `ops_audit_log`.

The gate, user administration, audit log, health checks and UI land in later tasks.

## Design constraints

- Node >= 22, ESM only. The package ships compiled `dist/` (ESM + `.d.ts`); hosts
  never need `transpilePackages`.
- Postgres only, via `pg`. No ORM inside the package.
- Every table the package owns is prefixed `ops_` and carries no foreign key into a
  host application's own tables.
- The package never stores or logs plaintext passwords, environment variable values,
  cookies, or `Authorization` headers.

## Security notes

- Rotating `OPS_PASSWORD_HASH` does **not** invalidate outstanding session cookies:
  those are signed with `OPS_SECRET`, not derived from the password hash. A leaked
  session cookie survives a password change for up to 8 hours (`OPS_TTL_SECONDS`).
  To revoke sessions immediately, rotate `OPS_SECRET` instead — that invalidates
  every outstanding cookie at once, including your own.

## Installing in a host project

```bash
npm i github:LNRTT/lnrt-ops#v0.1.0
```

npm runs the package's `prepare` script (`npm run build`) right after cloning the
tag, so `dist/` never has to be committed to this repo.

## Development

```bash
npm i
export OPS_TEST_DATABASE_URL=postgres://user:pass@host:5432/ops_test
npm test         # node:test against a real Postgres database
npm run typecheck
npm run build
```

The test suite talks to a real Postgres database — set `OPS_TEST_DATABASE_URL` to a
disposable database before running `npm test`; the tests create and drop `ops_*`
tables freely.
