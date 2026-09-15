# @lnrt/ops

A reusable operator portal that LNRT Next.js projects mount at `/ops`: a login-gated
admin surface for user administration, an audit log, and health checks, backed by a
self-applying Postgres schema.

## Status

v0.3.0. This package ships three entry points:

- `@lnrt/ops/server` — `defineOps()`, the Postgres pool/migrator, the access gate,
  the audit log, health checks, and the `OpsUserStore` contract plus its Prisma
  adapter (`prismaUserStore`).
- `@lnrt/ops/next` — `OpsPage` (the catch-all page component), `OpsView` (the pure,
  Next.js-free renderer it delegates to), and `createHandlers()` (the `/ops/api/*`
  route handlers for `GET`/`POST`).
- `@lnrt/ops/client` — the inline browser-error reporter and optional OpenReplay
  bridge, error context helper and privacy starting options.

Together they cover: sign-in gated by an allowlist of emails and a single bcrypt
password, a user list and detail view (password reset, role change, disable/restore,
optional hard delete, optional one-time sign-in links), an audit log, and a health
page (database reachability, required environment variables, build info, pending
migrations, plus any project-specific checks). All mutations are plain
`<form method="post">` posts. The Errors view groups server/browser exceptions
and can link individual occurrences to their OpenReplay recordings.

Deferred to a later version, deliberately: impersonation, session listing/revocation,
an activity feed and runtime settings.

## Optional OpenReplay integration

Configure one OpenReplay project per host application to show **Přehrát průběh**
on recorded error occurrences. The integration is off by default and uses the
existing error context without a schema migration. OpenReplay itself remains a
separate service; hosts opt into its SDK and recording lifecycle.

See [the setup, privacy defaults and rollout guide](docs/openreplay.md).

## Integration

Mounting `/ops` in a host Next.js app takes three files.

**1. Configure the instance** (`src/lib/ops.ts`):

```ts
import "server-only";
import { defineOps, prismaUserStore } from "@lnrt/ops/server";
import bcrypt from "bcryptjs";
import { mintInvite } from "@/lib/invites"; // your own one-time-token minter
import { prisma } from "@/lib/prisma";

export const ops = defineOps({
  db: { connectionString: process.env.DATABASE_URL! },
  users: prismaUserStore(prisma, {
    model: "user",
    roles: ["WORKER", "ADMIN"],
    hashPassword: (plaintext) => bcrypt.hash(plaintext, 10),
    // Omit hardDelete (the adapter option, or implement your own OpsUserStore
    // without the method) to hide the delete button — see "The OpsUserStore
    // contract" below.
  }),
  // Optional: mint a one-time sign-in link instead of (or alongside) a password.
  loginLink: { mint: mintInvite, path: "/invite" },
  // Optional: env vars the health page should confirm are present.
  requiredEnv: ["DATABASE_URL", "SESSION_SECRET"],
  // Optional: extra checks appended to the built-in ones.
  health: [],
});
```

Sign-in links include the current application's origin and can be copied from
the user detail page. Behind a reverse proxy, ensure it overwrites
`X-Forwarded-Host` and `X-Forwarded-Proto`, or set `loginLink.origin` explicitly
(for example `https://app.example.com`). Use the preview origin in preview.
Password resets confirm success on the detail page; an empty password field
generates a password, while a supplied value is preserved exactly.

**2. The page** (`src/app/ops/[[...path]]/page.tsx`):

```tsx
import { OpsPage } from "@lnrt/ops/next";
import { ops } from "@/lib/ops";

export const dynamic = "force-dynamic";

export default function Page(props: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <OpsPage ops={ops} {...props} />;
}
```

**3. The API routes** (`src/app/ops/api/[[...path]]/route.ts`):

```ts
import { createHandlers } from "@lnrt/ops/next";
import { ops } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const { GET, POST } = createHandlers(ops);
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `OPS_ADMIN_EMAILS` | Yes | Comma-separated allowlist of the only emails that can sign in. |
| `OPS_PASSWORD_HASH` | Yes | A bcrypt hash of the single ops password, checked in constant time against every allowed email. |
| `OPS_SECRET` | Yes | >= 32 characters. Signs the session cookie, the CSRF token and the one-time flash cookie. |
| `OPS_RELEASE` | No | Shown on the health page's Build check. Falls back to `GIT_SHA`, then `SOURCE_COMMIT`, then `unknown`. |

Any of `OPS_ADMIN_EMAILS`, `OPS_PASSWORD_HASH` or `OPS_SECRET` missing or malformed
(a non-bcrypt `OPS_PASSWORD_HASH`, a short `OPS_SECRET`) disables the whole module —
`/ops` and `/ops/api/*` both return a plain 404. Closed by default, never a weakened
gate.

Generate `OPS_PASSWORD_HASH` with:

```bash
node -e "console.log(require('bcryptjs').hashSync(process.argv[1],10))" 'your password'
```

## The `OpsUserStore` contract

The one interface a host project must satisfy to plug its own user table into the
portal (`src/server/users.ts`):

```ts
type OpsUserStore = {
  roles: string[];
  list(q: OpsUserQuery): Promise<{ users: OpsUser[]; total: number }>;
  get(id: string): Promise<OpsUser | null>;
  create(input: { email: string; name: string; role: string }): Promise<OpsUser>;
  setPassword(id: string, plaintext: string): Promise<void>;
  setRole(id: string, role: string): Promise<void>;
  setDisabled(id: string, disabled: boolean): Promise<void>;
  hardDelete?(id: string): Promise<void>;
};
```

Six methods are required; `hardDelete` is the seventh and is optional **on purpose**.
Omit it wherever user rows are referenced by domain data (time entries, purchases,
tool holdings, …) that a hard delete would either fail against or silently destroy —
the "Delete permanently" form in the user detail view only renders when
`typeof store.hardDelete === "function"`. `@lnrt/ops/server` ships `prismaUserStore()`,
a ready-made adapter over a Prisma model; implement `OpsUserStore` directly for any
other storage layer.

## Design constraints

- Node >= 22, ESM only. The package ships compiled `dist/` (ESM + `.d.ts`); hosts
  never need `transpilePackages`.
- Postgres only, via `pg`. No ORM inside the package.
- Every table the package owns is prefixed `ops_` and carries no foreign key into a
  host application's own tables.
- The package never stores or logs plaintext passwords, environment variable values,
  cookies, or `Authorization` headers.
- `typescript` is pinned to `^5.9.3` deliberately — do not let `npm update` bump it
  past 6. tsup 8.5.1 bundles `rollup-plugin-dts@6.1.1`, whose peer range is
  `^4.5 || ^5.0`, and TypeScript 7 crashes its declaration build.

## Security notes

- Rotating `OPS_PASSWORD_HASH` does **not** invalidate outstanding session cookies:
  those are signed with `OPS_SECRET`, not derived from the password hash. A leaked
  session cookie survives a password change for up to 8 hours. That lifetime is a
  constant in the package, not an environment variable — rotate `OPS_SECRET` to revoke
  outstanding cookies immediately.
  To revoke sessions immediately, rotate `OPS_SECRET` instead — that invalidates
  every outstanding cookie at once, including your own.

### Hosts that forward request headers to an error tracker must scrub two cookies

`lnrt_ops_flash` carries a one-time reveal — a freshly generated password or a
minted sign-in link — in a signed, short-lived (60 second) cookie. If a request
fails while that cookie is set (a password reset that redirects into a `store.get`
that then throws, for example), a host whose error reporting captures request
headers will ship the whole `Cookie:` header, `lnrt_ops_flash` included, to its
error tracker. The value there is base64url-encoded, which is not encryption and
is trivially decoded — a support engineer skimming an error report could read a
live password straight off it.

If your host forwards request headers to Sentry, Bugsink, or anything similar,
scrub `lnrt_ops_flash` **and** `lnrt_ops` (the session cookie) before those
headers leave the process. The 60-second `Max-Age` on the flash cookie shrinks
the exposure window, but it is not a defence — the package itself never logs
cookies, but it hands the host something that must not be logged either, and
only the host's error-reporting integration is in a position to scrub it.

## Installing in a host project

```bash
npm i github:LNRTT/lnrt-ops#v0.3.0
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
