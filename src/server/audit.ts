import type { Pool } from "pg";

export type AuditInput = {
  actor: string;
  action: string;
  targetType?: string;
  targetId?: string;
  summary: string;
  ip?: string;
  userAgent?: string;
};

export type AuditRow = AuditInput & { id: string; at: Date };

/**
 * Appends one entry. Unlike diagnostic writes elsewhere in the package this one
 * throws on failure: it only ever runs inside an /ops request, and an operator
 * action that was not recorded must not appear to have succeeded.
 */
export async function writeAudit(pool: Pool, input: AuditInput): Promise<void> {
  await pool.query(
    `INSERT INTO ops_audit_log (actor, action, target_type, target_id, summary, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [input.actor, input.action, input.targetType ?? null, input.targetId ?? null,
     input.summary, input.ip ?? null, input.userAgent ?? null],
  );
}

export async function listAudit(
  pool: Pool,
  opts: { limit?: number; beforeId?: string; targetId?: string } = {},
): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.beforeId) { params.push(opts.beforeId); where.push(`id < $${params.length}`); }
  if (opts.targetId) { params.push(opts.targetId); where.push(`target_id = $${params.length}`); }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, at, actor, action, target_type, target_id, summary, ip, user_agent
       FROM ops_audit_log
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY id DESC
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((r) => ({
    id: String(r.id), at: r.at, actor: r.actor, action: r.action,
    targetType: r.target_type ?? undefined, targetId: r.target_id ?? undefined,
    summary: r.summary, ip: r.ip ?? undefined, userAgent: r.user_agent ?? undefined,
  }));
}
