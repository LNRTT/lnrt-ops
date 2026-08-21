import type { ErrorEventRow, ErrorGroupRow } from "../../server/errors/store";

const STATUS_TAG: Record<ErrorGroupRow["status"], string> = { open: "warn", resolved: "good", ignored: "neutral" };

function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * One POST target (`/ops/api/errors/status`) handles both actions -- the
 * hidden `status` field is what tells the handler which. Each button is
 * omitted when it would be a no-op against the group's current status, the
 * same way UserDetail only shows a delete form when the adapter supports it.
 */
function StatusForm({ id, status, csrf, label }: { id: string; status: "resolved" | "ignored"; csrf: string; label: string }) {
  return (
    <form className="ops-row" method="post" action="/ops/api/errors/status">
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={status} />
      <button type="submit">{label}</button>
    </form>
  );
}

export function ErrorDetail({
  group, events, csrf,
}: { group: ErrorGroupRow; events: ErrorEventRow[]; csrf: string }) {
  return (
    <>
      <div className="ops-card">
        <h2>{group.type}: {group.message}</h2>
        <p className="ops-note">
          {group.culprit || "—"} · {group.source} ·{" "}
          <span className={`ops-tag ${STATUS_TAG[group.status]}`}>{group.status}</span>
        </p>
        <p className="ops-note">
          {group.eventCount === group.storedCount
            ? `${group.eventCount} occurrence${group.eventCount === 1 ? "" : "s"}`
            : `${group.eventCount} occurrences, ${group.storedCount} stored`}
          {" "}· {group.affectedUsers} affected user{group.affectedUsers === 1 ? "" : "s"}
          {" "}· first seen {fmt(group.firstSeen)} · last seen {fmt(group.lastSeen)}
          {group.lastRelease ? ` · release ${group.lastRelease}` : ""}
        </p>
      </div>

      <div className="ops-card">
        <h2>Actions</h2>
        {group.status !== "resolved" && <StatusForm id={group.id} status="resolved" csrf={csrf} label="Mark resolved" />}
        {group.status !== "ignored" && <StatusForm id={group.id} status="ignored" csrf={csrf} label="Ignore" />}
      </div>

      {events.length === 0 ? (
        <div className="ops-card"><p className="ops-note">No stored events for this group.</p></div>
      ) : (
        events.map((e) => (
          <div className="ops-card" key={e.id}>
            <p className="ops-note">
              {fmt(e.at)} · {e.source}
              {e.method ? ` · ${e.method}` : ""}
              {e.url ? ` · ${e.url}` : ""}
              {e.release ? ` · release ${e.release}` : ""}
            </p>
            {(e.userId || e.userAgent) && (
              <p className="ops-note">
                {e.userId ? `User ${e.userId}${e.userRole ? ` (${e.userRole})` : ""}` : null}
                {e.userId && e.userAgent ? " · " : null}
                {e.userAgent ?? null}
              </p>
            )}
            <p>{e.message}</p>
            {/* message/stack/url/culprit are attacker-controlled -- rendered as plain text
                children only, never as a URL or via dangerouslySetInnerHTML. */}
            {e.stack && <pre className="ops-pre">{e.stack}</pre>}
            {e.context && <pre className="ops-pre">{JSON.stringify(e.context, null, 2)}</pre>}
          </div>
        ))
      )}
    </>
  );
}
