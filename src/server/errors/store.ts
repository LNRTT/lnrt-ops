import type { Pool } from "pg";
import { fingerprint, firstAppFrame } from "./fingerprint";
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

// Stored-text caps. None of `message`, `stack` or `context` is bounded by the
// fingerprint (which truncates its own normalised copy independently) — a
// single unusually large capture must not be able to write megabytes into a
// row, a hundred times an hour.
const MAX_MESSAGE = 2000;
const MAX_STACK = 20_000;
const MAX_CONTEXT_BYTES = 16 * 1024;

/** Postgres rejects a NUL byte in `text`/`jsonb` outright; strip it before it ever reaches a query. */
const NUL = String.fromCharCode(0);

function stripNul(s: string): string {
  return s.includes(NUL) ? s.split(NUL).join("") : s;
}

// `JSON.stringify` never emits a raw NUL byte for a NUL character in a string
// -- it escapes it as the six-character sequence backslash + "u0000", which
// Postgres's jsonb input rejects just as hard as a raw NUL would be
// rejected in `text`. Built from character codes so the source never has to
// spell out the escape sequence itself.
const ESCAPED_NUL_IN_JSON = String.fromCharCode(92) + "u0000";

function stripEscapedNul(json: string): string {
  return json.includes(ESCAPED_NUL_IN_JSON) ? json.split(ESCAPED_NUL_IN_JSON).join("") : json;
}

function sanitizeText(s: string, maxLen: number): string {
  const clean = stripNul(s);
  return clean.length > maxLen ? clean.slice(0, maxLen) : clean;
}

/** Removes the query string and fragment from a URL, keeping the path — see fix 4. */
function stripQueryAndFragment(url: string): string {
  const idx = url.search(/[?#]/);
  return idx === -1 ? url : url.slice(0, idx);
}

// A bundled browser stack embeds full URLs (absolute, with scheme) rather
// than bare paths, and those can carry the same query-string secrets as the
// top-level `url` field.
const ABSOLUTE_URL = /https?:\/\/[^\s)'"]+/g;

function stripUrlQueriesInStack(stack: string): string {
  return stack.replace(ABSOLUTE_URL, (m) => stripQueryAndFragment(m));
}

/**
 * Serialises a redacted context defensively: a `bigint` anywhere in the tree
 * makes the built-in `JSON.stringify` throw outright (not just drop the
 * field), and a function/symbol would otherwise vanish silently. Falls back
 * to `null` — never lets a serialisation failure fail the whole capture —
 * and replaces an oversized result rather than truncating it, since a
 * truncated JSON string is not valid JSON.
 */
function serializeContext(context: Record<string, unknown> | null): string | null {
  if (!context) return null;
  let json: string;
  try {
    json = JSON.stringify(context, (_key, value) => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "function" || typeof value === "symbol") return "<unserialisable>";
      return value;
    });
  } catch {
    return null;
  }
  json = stripEscapedNul(json);
  if (Buffer.byteLength(json, "utf8") > MAX_CONTEXT_BYTES) {
    return JSON.stringify({ _dropped: "context too large" });
  }
  return json;
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
 *     `source`, like `message`, is left at its first-seen value: it is not
 *     part of the fingerprint, so an isomorphic component throwing in both
 *     SSR and the browser must not flip a group's `source` on every other
 *     capture.
 *  2. Insert the event only if fewer than `HOURLY_STORE_CAP` events have been
 *     stored for this group in the last hour, bumping `stored_count` when it
 *     does. `event_count` always rises, so the group keeps showing the true
 *     scale of a flood even while storage of it is capped.
 *
 * Context is redacted here, on the way in, so a credential is never written
 * down in the first place.
 *
 * This is a diagnostic write, not the request it is reporting on: unlike
 * `writeAudit` in ./audit.ts, this function never throws. Any failure --
 * a connection the pool cannot hand out, a statement that runs too long
 * against a struggling database, a constraint violation -- is logged once
 * and swallowed, because a capture that took down the request it was
 * documenting would make the error reporter the outage.
 */
export async function recordError(pool: Pool, e: CapturedError): Promise<void> {
  try {
    const id = fingerprint({ type: e.type, message: e.message, stack: e.stack });
    const message = sanitizeText(e.message, MAX_MESSAGE);
    const stack = e.stack !== undefined ? sanitizeText(stripUrlQueriesInStack(e.stack), MAX_STACK) : null;
    const culprit = firstAppFrame(e.stack);
    const url = e.url !== undefined ? stripQueryAndFragment(e.url) : null;
    const context = e.context ? redactContext(e.context) : null;
    const serializedContext = serializeContext(context);

    // A connect() that never resolves is exactly how a slow database turns
    // this into an outage of its own -- getPool() gives every pool a
    // connectionTimeoutMillis so this rejects rather than hanging forever.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // A capture must never be the thing that pins a connection open while
      // the database is struggling -- bound how long any statement in this
      // transaction may run.
      await client.query("SET LOCAL statement_timeout = 5000");

      await client.query(
        `INSERT INTO ops_error_group (id, type, message, culprit, source, event_count, last_release)
         VALUES ($1, $2, $3, $4, $5, 1, $6)
         ON CONFLICT (id) DO UPDATE SET
           last_seen    = now(),
           event_count  = ops_error_group.event_count + 1,
           last_release = COALESCE(EXCLUDED.last_release, ops_error_group.last_release),
           status       = CASE WHEN ops_error_group.status = 'resolved' THEN 'open' ELSE ops_error_group.status END`,
        [id, e.type, message, culprit, e.source, e.release ?? null],
      );

      // Safe from a race only because the upsert above already took the
      // group row's lock: two concurrent captures of the same fingerprint
      // serialise there, so the second one's count here always sees the
      // first one's insert (or its own prior insert) rather than racing it.
      // Reordering these statements, or moving the count into its own
      // transaction, removes that lock and lets the cap overshoot.
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
            message,
            stack,
            url,
            e.method ?? null,
            e.userId ?? null,
            e.userRole ?? null,
            e.requestId ?? null,
            e.release ?? null,
            e.userAgent ?? null,
            serializedContext,
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
  } catch (err) {
    console.error("[ops] failed to record an error", err);
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
 * occurrences age out. Each affected group's `stored_count` is decremented
 * by exactly how many of its events were actually removed (floored at
 * zero), so it keeps matching what `listErrorEvents` can still return
 * instead of staying stuck at its pre-prune value forever.
 *
 * One unbatched DELETE — fine at current volumes, worth batching before
 * this table reaches millions of rows.
 */
export async function pruneErrors(pool: Pool, days = 30): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{ group_id: string }>(
      `DELETE FROM ops_error_event WHERE at < now() - ($1 || ' days')::interval RETURNING group_id`,
      [days],
    );

    if (rows.length > 0) {
      const counts = new Map<string, number>();
      for (const r of rows) {
        counts.set(r.group_id, (counts.get(r.group_id) ?? 0) + 1);
      }
      const groupIds = [...counts.keys()];
      const deltas = groupIds.map((id) => counts.get(id)!);

      await client.query(
        `UPDATE ops_error_group AS g
            SET stored_count = GREATEST(g.stored_count - d.delta, 0)
           FROM unnest($1::text[], $2::int[]) AS d(group_id, delta)
          WHERE g.id = d.group_id`,
        [groupIds, deltas],
      );
    }

    await client.query("COMMIT");
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
