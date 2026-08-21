import type { OpsUser, OpsUserPage, OpsUserQuery, OpsUserStore } from "../users";

/**
 * How a host marks an account as disabled. A bare string means the common case:
 * a nullable timestamp that is NULL while the account is active. Hosts that use
 * a boolean column must say so — otherwise the adapter would write NULL into a
 * NOT NULL column and read `false` as "not disabled", inverting the state.
 */
export type DisabledField =
  | string
  | { field: string; kind: "timestamp" }
  | { field: string; kind: "boolean"; /** The column value that means disabled. */ disabledWhen: boolean };

export type PrismaUserStoreOptions = {
  /** Delegate name on the Prisma client, e.g. "user". */
  model: string;
  roles: string[];
  /** Column names, when they differ from the defaults shown here. */
  fields?: {
    email?: string; name?: string; role?: string;
    passwordHash?: string; disabledAt?: DisabledField; lastSignInAt?: string;
  };
  hashPassword(plaintext: string): Promise<string>;
  /** Off by default. Only enable where no domain data references the user row. */
  hardDelete?: boolean;
};

type Delegate = {
  findMany(args: unknown): Promise<Record<string, unknown>[]>;
  count(args: unknown): Promise<number>;
  findUnique(args: unknown): Promise<Record<string, unknown> | null>;
  create(args: unknown): Promise<Record<string, unknown>>;
  update(args: unknown): Promise<Record<string, unknown>>;
  delete(args: unknown): Promise<Record<string, unknown>>;
};

type NormalizedDisabled =
  | { field: string; kind: "timestamp" }
  | { field: string; kind: "boolean"; disabledWhen: boolean };

function normalizeDisabledField(d: DisabledField): NormalizedDisabled {
  return typeof d === "string" ? { field: d, kind: "timestamp" } : d;
}

/** The value to write for a given disabled state. */
function disabledValue(d: NormalizedDisabled, isDisabled: boolean): unknown {
  if (d.kind === "boolean") return isDisabled ? d.disabledWhen : !d.disabledWhen;
  return isDisabled ? new Date() : null;
}

/** The `where` fragment selecting accounts that are NOT disabled. */
function notDisabledWhere(d: NormalizedDisabled): unknown {
  return d.kind === "boolean" ? !d.disabledWhen : null;
}

function isDisabledRow(d: NormalizedDisabled, value: unknown): boolean {
  return d.kind === "boolean" ? value === d.disabledWhen : Boolean(value);
}

export function prismaUserStore(prisma: unknown, opts: PrismaUserStoreOptions): OpsUserStore {
  const delegate = (prisma as Record<string, Delegate>)[opts.model];
  if (!delegate) throw new Error(`Prisma client has no "${opts.model}" delegate.`);

  const disabled = normalizeDisabledField(opts.fields?.disabledAt ?? "disabledAt");

  const f = {
    email: opts.fields?.email ?? "email",
    name: opts.fields?.name ?? "name",
    role: opts.fields?.role ?? "role",
    passwordHash: opts.fields?.passwordHash ?? "passwordHash",
    lastSignInAt: opts.fields?.lastSignInAt,
  };

  function toOpsUser(row: Record<string, unknown>): OpsUser {
    return {
      id: String(row.id),
      email: String(row[f.email] ?? ""),
      name: String(row[f.name] ?? ""),
      role: String(row[f.role] ?? ""),
      disabled: isDisabledRow(disabled, row[disabled.field]),
      hasPassword: Boolean(row[f.passwordHash]),
      lastSignInAt: f.lastSignInAt ? ((row[f.lastSignInAt] as Date | null) ?? null) : null,
    };
  }

  function buildWhere(q: OpsUserQuery): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (!q.includeDisabled) where[disabled.field] = notDisabledWhere(disabled);
    if (q.role) where[f.role] = q.role;
    if (q.search) {
      where.OR = [
        { [f.name]: { contains: q.search, mode: "insensitive" } },
        { [f.email]: { contains: q.search, mode: "insensitive" } },
      ];
    }
    return where;
  }

  function assertRole(role: string): void {
    if (!opts.roles.includes(role)) throw new Error(`Unknown role "${role}".`);
  }

  const store: OpsUserStore = {
    roles: opts.roles,

    async list(q: OpsUserQuery): Promise<OpsUserPage> {
      const where = buildWhere(q);
      const perPage = Math.min(Math.max(q.perPage ?? 50, 1), 200);
      const page = Math.max(q.page ?? 1, 1);
      const [rows, total] = await Promise.all([
        delegate.findMany({ where, orderBy: { [f.name]: "asc" }, skip: (page - 1) * perPage, take: perPage }),
        delegate.count({ where }),
      ]);
      return { users: rows.map(toOpsUser), total };
    },

    async get(id) {
      const row = await delegate.findUnique({ where: { id } });
      return row ? toOpsUser(row) : null;
    },

    async create(input) {
      assertRole(input.role);
      const row = await delegate.create({
        data: { [f.email]: input.email, [f.name]: input.name, [f.role]: input.role },
      });
      return toOpsUser(row);
    },

    async setPassword(id, plaintext) {
      const hash = await opts.hashPassword(plaintext);
      await delegate.update({ where: { id }, data: { [f.passwordHash]: hash } });
    },

    async setRole(id, role) {
      assertRole(role);
      await delegate.update({ where: { id }, data: { [f.role]: role } });
    },

    async setDisabled(id, isDisabled) {
      await delegate.update({
        where: { id }, data: { [disabled.field]: disabledValue(disabled, isDisabled) },
      });
    },
  };

  if (opts.hardDelete) {
    store.hardDelete = async (id: string) => { await delegate.delete({ where: { id } }); };
  }
  return store;
}
