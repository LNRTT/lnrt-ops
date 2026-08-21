import type { Pool } from "pg";
import { fingerprint } from "./fingerprint";
import { redactContext } from "./redact";

export type ErrorSource = "server" | "browser";
export type ErrorGroupStatus = "open" | "resolved" | "ignored";

export type CapturedError = {
  type: string;
  message: string;
  stack?: string;
  source: ErrorSource;
  url?: string;
  method?: string;
  userId?: string;
  userRole?: string;
  requestId?: string;
  release?: string;
  userAgent?: string;
  context?: Record<string, unknown>;
};

export type ErrorGroupRow = {
  id: string;
  type: string;
  message: string;
  culprit: string;
  source: ErrorSource;
  status: ErrorGroupStatus;
  firstSeen: Date;
  lastSeen: Date;
  eventCount: number;
  storedCount: number;
  lastRelease?: string;
};

export type ErrorEventRow = {
  id: string;
  groupId: string;
  at: Date;
  source: ErrorSource;
  message: string;
  stack?: string;
  url?: string;
  method?: string;
  userId?: string;
  userRole?: string;
  requestId?: string;
  release?: string;
  userAgent?: string;
  context?: Record<string, unknown>;
};

export type ErrorGroupQuery = {
  status?: ErrorGroupStatus;
  source?: ErrorSource;
  since?: Date;
  userId?: string;
  limit?: number;
};

// A component that throws during render can fire thousands of times a
// minute. Past this many *stored* events per group per hour, only the
// counters move — the group still shows the true scale without the table
// growing without bound.
const HOURLY_STORE_CAP = 100;

// A line that looks like a stack frame (has a `file:line[:col]` location) and
// is not inside a dependency or the runtime. This is a display string for
// operators, independent of the grouping fingerprint in ./fingerprint.
function extractCulprit(stack: string | undefined): string {
  if (!stack) return "";
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!/:\d+(?::\d+)?\)?$/.test(line)) continue;
    if (line.includes("node_modules") || line.includes("node:internal")) continue;
    return line.replace(/^at\s+/, "");
  }
  return "";
}

function mapGroupRow(r: {
  id: string;
  type: string;
  message: string;
  culprit: string;
  source: string;
  status: string;
  first_seen: Date;
  last_seen: Date;
  event_count: string | number;
  stored_count: string | number;
  last_release: string | null;
}): ErrorGroupRow {
  return {
    id: r.id,
    type: r.type,
    message: r.message,
    culprit: r.culprit,
    source: r.source as ErrorSource,
    status: r.status as ErrorGroupStatus,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    eventCount: Number(r.event_count),
    storedCount: Number(r.stored_count),
    lastRelease: r.last_release ?? undefined,
  };
}

function mapEventRow(r: {
  id: string | number;
  group_id: string;
  at: Date;
  source: string;
  message: string;
  stack: string | null;
  url: string | null;
  method: string | null;
  user_id: string | null;
  user_role: string | null;
  request_id: string | null;
  release: string | null;
  user_agent: string | null;
  context: Record<string, unknown> | null;
}): ErrorEventRow {
  return {
    id: String(r.id),
    groupId: r.group_id,
    at: r.at,
    source: r.source as ErrorSource,
    message: r.message,
    stack: r.stack ?? undefined,
    url: r.url ?? undefined,
    method: r.method ?? undefined,
    userId: r.user_id ?? undefined,
    userRole: r.user_role ?? undefined,
    requestId: r.request_id ?? undefined,
    release: r.release ?? undefined,
    userAgent: r.user_agent ?? undefined,
    context: r.context ?? undefined,
  };
}

/**
 * Records one occurrence of an error, in one transaction:
 *  1. Upsert the group — bump `event_count` and `last_seen`, remember the
 *     latest `last_release`, and reopen it if it had been marked resolved.
 *  2. Insert the event only if fewer than `HOURLY_STORE_CAP` events have been
 *     stored for this group in the last hour, bumping `stored_count` when it
 *     does. `event_count` always rises, so the group keeps showing the true
 *     scale of a flood even while storage of it is capped.
 *
 * Context is redacted here, on the way in, so a credential is never written
 * down in the first place.
 */
export async function recordError(pool: Pool, e: CapturedError): Promise<void> {
  const id = fingerprint({ type: e.type, message: e.message, stack: e.stack });
  const culprit = extractCulprit(e.stack);
  const context = e.context ? redactContext(e.context) : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO ops_error_group (id, type, message, culprit, source, event_count, last_release)
       VALUES ($1, $2, $3, $4, $5, 1, $6)
       ON CONFLICT (id) DO UPDATE SET
         last_seen    = now(),
         event_count  = ops_error_group.event_count + 1,
         source       = EXCLUDED.source,
         last_release = COALESCE(EXCLUDED.last_release, ops_error_group.last_release),
         status       = CASE WHEN ops_error_group.status = 'resolved' THEN 'open' ELSE ops_error_group.status END`,
      [id, e.type, e.message, culprit, e.source, e.release ?? null],
    );

    const { rows: recentRows } = await client.query(
      `SELECT count(*) AS c FROM ops_error_event WHERE group_id = $1 AND at > now() - interval '1 hour'`,
      [id],
    );
    const recent = Number(recentRows[0]?.c ?? 0);

    if (recent < HOURLY_STORE_CAP) {
      await client.query(
        `INSERT INTO ops_error_event
           (group_id, source, message, stack, url, method, user_id, user_role, request_id, release, user_agent, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          e.source,
          e.message,
          e.stack ?? null,
          e.url ?? null,
          e.method ?? null,
          e.userId ?? null,
          e.userRole ?? null,
          e.requestId ?? null,
          e.release ?? null,
          e.userAgent ?? null,
          context,
        ],
      );
      await client.query(`UPDATE ops_error_group SET stored_count = stored_count + 1 WHERE id = $1`, [id]);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listErrorGroups(pool: Pool, q: ErrorGroupQuery = {}): Promise<ErrorGroupRow[]> {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const where: string[] = [];
  const params: unknown[] = [];

  if (q.status) {
    params.push(q.status);
    where.push(`status = $${params.length}`);
  }
  if (q.source) {
    params.push(q.source);
    where.push(`source = $${params.length}`);
  }
  if (q.since) {
    params.push(q.since);
    where.push(`last_seen >= $${params.length}`);
  }
  if (q.userId) {
    params.push(q.userId);
    where.push(
      `EXISTS (SELECT 1 FROM ops_error_event e WHERE e.group_id = ops_error_group.id AND e.user_id = $${params.length})`,
    );
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, type, message, culprit, source, status, first_seen, last_seen, event_count, stored_count, last_release
       FROM ops_error_group
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY last_seen DESC
      LIMIT $${params.length}`,
    params,
  );

  return rows.map(mapGroupRow);
}

export async function getErrorGroup(pool: Pool, id: string): Promise<ErrorGroupRow | null> {
  const { rows } = await pool.query(
    `SELECT id, type, message, culprit, source, status, first_seen, last_seen, event_count, stored_count, last_release
       FROM ops_error_group
      WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapGroupRow(rows[0]) : null;
}

export async function listErrorEvents(pool: Pool, groupId: string, limit = 50): Promise<ErrorEventRow[]> {
  const cappedLimit = Math.min(Math.max(limit, 1), 500);
  const { rows } = await pool.query(
    `SELECT id, group_id, at, source, message, stack, url, method, user_id, user_role, request_id, release, user_agent, context
       FROM ops_error_event
      WHERE group_id = $1
      ORDER BY at DESC, id DESC
      LIMIT $2`,
    [groupId, cappedLimit],
  );
  return rows.map(mapEventRow);
}

export async function setErrorGroupStatus(pool: Pool, id: string, status: ErrorGroupStatus): Promise<void> {
  await pool.query(`UPDATE ops_error_group SET status = $2 WHERE id = $1`, [id, status]);
}

/**
 * Deletes events older than `days`, but never the groups they belonged to —
 * a group is the durable record that a bug happened; only its individual
 * occurrences age out.
 */
export async function pruneErrors(pool: Pool, days = 30): Promise<number> {
  const { rowCount } = await pool.query(`DELETE FROM ops_error_event WHERE at < now() - ($1 || ' days')::interval`, [
    days,
  ]);
  return rowCount ?? 0;
}
