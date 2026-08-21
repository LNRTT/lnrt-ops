import { test } from "node:test";
import assert from "node:assert/strict";
import { prismaUserStore } from "./prismaUserStore";

type Call = { method: string; args: unknown };

function fakePrisma(rows: Record<string, unknown>[]) {
  const calls: Call[] = [];
  return {
    calls,
    user: {
      async findMany(args: unknown) { calls.push({ method: "findMany", args }); return rows; },
      async count(args: unknown) { calls.push({ method: "count", args }); return rows.length; },
      async findUnique(args: unknown) { calls.push({ method: "findUnique", args }); return rows[0] ?? null; },
      async create(args: unknown) { calls.push({ method: "create", args }); return rows[0]; },
      async update(args: unknown) { calls.push({ method: "update", args }); return rows[0]; },
      async delete(args: unknown) { calls.push({ method: "delete", args }); return rows[0]; },
    },
  };
}

const ROW = {
  id: "u1", email: "a@b.cz", name: "Anna", role: "ZAMESTNANEC",
  passwordHash: "$2b$10$x", deactivatedAt: null,
};

/** Captures what the adapter handed to hashPassword, so both halves are provable. */
let hashedInput: string | undefined;

function store(prisma: ReturnType<typeof fakePrisma>, extra = {}) {
  return prismaUserStore(prisma, {
    model: "user",
    roles: ["BRIGADNIK", "ZAMESTNANEC", "VEDOUCI", "ADMIN"],
    fields: { disabledAt: "deactivatedAt" },
    // Deliberately does NOT echo the plaintext: one test asserts the plaintext
    // appears nowhere in the recorded calls, which an echoing fake would break.
    hashPassword: async (p) => { hashedInput = p; return "HASHED"; },
    ...extra,
  });
}

test("maps a row onto OpsUser, deriving disabled and hasPassword", async () => {
  const prisma = fakePrisma([ROW]);
  const { users, total } = await store(prisma).list({});
  assert.equal(total, 1);
  assert.deepEqual(users[0], {
    id: "u1", email: "a@b.cz", name: "Anna", role: "ZAMESTNANEC",
    disabled: false, hasPassword: true, lastSignInAt: null,
  });
});

test("reports a user with no password hash as having none", async () => {
  const prisma = fakePrisma([{ ...ROW, passwordHash: null }]);
  const { users } = await store(prisma).list({});
  assert.equal(users[0]!.hasPassword, false);
});

test("reports a user with the disabled column set as disabled", async () => {
  const prisma = fakePrisma([{ ...ROW, deactivatedAt: new Date() }]);
  const { users } = await store(prisma).list({});
  assert.equal(users[0]!.disabled, true);
});

test("hides disabled users unless asked and searches name and email", async () => {
  const prisma = fakePrisma([ROW]);
  await store(prisma).list({ search: "ann" });
  const where = (prisma.calls[0]!.args as { where: Record<string, unknown> }).where;
  assert.deepEqual(where.deactivatedAt, null);
  assert.deepEqual(where.OR, [
    { name: { contains: "ann", mode: "insensitive" } },
    { email: { contains: "ann", mode: "insensitive" } },
  ]);
});

test("includes disabled users when asked", async () => {
  const prisma = fakePrisma([ROW]);
  await store(prisma).list({ includeDisabled: true });
  const where = (prisma.calls[0]!.args as { where: Record<string, unknown> }).where;
  assert.equal("deactivatedAt" in where, false);
});

test("hashes through the supplied function and never writes plaintext", async () => {
  const prisma = fakePrisma([ROW]);
  hashedInput = undefined;
  await store(prisma).setPassword("u1", "plain text here");
  // The plaintext reaches the host's hash function...
  assert.equal(hashedInput, "plain text here");
  // ...and only the returned hash is written.
  const args = prisma.calls[0]!.args as { data: Record<string, unknown> };
  assert.deepEqual(args.data, { passwordHash: "HASHED" });
  // ...and the plaintext appears nowhere in what was sent to the database.
  assert.equal(JSON.stringify(prisma.calls).includes("plain text here"), false);
});

test("disable and restore write the mapped column", async () => {
  const prisma = fakePrisma([ROW]);
  const s = store(prisma);
  await s.setDisabled("u1", true);
  const on = (prisma.calls[0]!.args as { data: Record<string, unknown> }).data;
  assert.ok(on.deactivatedAt instanceof Date);
  await s.setDisabled("u1", false);
  const off = (prisma.calls[1]!.args as { data: Record<string, unknown> }).data;
  assert.equal(off.deactivatedAt, null);
});

test("supports a boolean disabled column without inverting the state", async () => {
  // A host with `active BOOLEAN NOT NULL`, where false means disabled.
  const boolOpts = { fields: { disabledAt: { field: "active", kind: "boolean" as const, disabledWhen: false } } };

  const activeRow = { ...ROW, active: true, deactivatedAt: undefined };
  const s1 = store(fakePrisma([activeRow]), boolOpts);
  assert.equal((await s1.list({})).users[0]!.disabled, false);

  const disabledRow = { ...ROW, active: false, deactivatedAt: undefined };
  const prisma = fakePrisma([disabledRow]);
  const s2 = store(prisma, boolOpts);
  assert.equal((await s2.list({ includeDisabled: true })).users[0]!.disabled, true,
    "false in a boolean column must read as disabled, not as 'no value'");
});

test("filters and writes a boolean disabled column with real booleans, never null", async () => {
  const boolOpts = { fields: { disabledAt: { field: "active", kind: "boolean" as const, disabledWhen: false } } };

  const listing = fakePrisma([{ ...ROW, active: true }]);
  await store(listing, boolOpts).list({});
  const where = (listing.calls[0]!.args as { where: Record<string, unknown> }).where;
  assert.equal(where.active, true, "must select active rows, not `active: null`");

  const writing = fakePrisma([{ ...ROW, active: true }]);
  const s = store(writing, boolOpts);
  await s.setDisabled("u1", true);
  assert.deepEqual((writing.calls[0]!.args as { data: unknown }).data, { active: false });
  await s.setDisabled("u1", false);
  assert.deepEqual((writing.calls[1]!.args as { data: unknown }).data, { active: true });
});

test("rejects a role outside the declared list", async () => {
  await assert.rejects(() => store(fakePrisma([ROW])).setRole("u1", "GOD"), /Unknown role/);
});

test("omits hardDelete unless explicitly enabled", () => {
  assert.equal(store(fakePrisma([ROW])).hardDelete, undefined);
  assert.equal(typeof store(fakePrisma([ROW]), { hardDelete: true }).hardDelete, "function");
});
