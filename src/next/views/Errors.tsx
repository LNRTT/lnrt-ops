import type { ErrorGroupRow } from "../../server/errors/store";

const STATUS_TAG: Record<ErrorGroupRow["status"], string> = { open: "warn", resolved: "good", ignored: "neutral" };

function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** Builds the filter query string, minus `user` -- used to let the "clear" link drop only that filter. */
function filtersHref(unresolved: boolean, since24h: boolean, source: string): string {
  const params = new URLSearchParams();
  if (unresolved) params.set("unresolved", "1");
  if (since24h) params.set("since", "24h");
  if (source) params.set("source", source);
  const qs = params.toString();
  return `/ops/errors${qs ? `?${qs}` : ""}`;
}

export function Errors({
  groups, unresolved, since24h, source, userId,
}: {
  groups: ErrorGroupRow[];
  unresolved: boolean;
  since24h: boolean;
  /** "" | "server" | "browser" */
  source: string;
  userId?: string;
}) {
  return (
    <div className="ops-card">
      <h2>Errors</h2>
      <form className="ops-row" method="get" action="/ops/errors">
        <label><input type="checkbox" name="unresolved" value="1" defaultChecked={unresolved} /> Unresolved only</label>
        <label><input type="checkbox" name="since" value="24h" defaultChecked={since24h} /> Last 24 hours</label>
        <select name="source" defaultValue={source}>
          <option value="">All sources</option>
          <option value="server">Server</option>
          <option value="browser">Browser</option>
        </select>
        {userId && <input type="hidden" name="user" value={userId} />}
        <button type="submit">Filter</button>
      </form>
      {userId && (
        <p className="ops-note">
          Filtered to user {userId} · <a href={filtersHref(unresolved, since24h, source)}>Clear</a>
        </p>
      )}
      {groups.length === 0 ? (
        <p className="ops-note">No errors match these filters.</p>
      ) : (
        <table className="ops-table">
          <thead>
            <tr>
              <th>Type</th><th>Message</th><th>Culprit</th><th>Count</th><th>Users</th>
              <th>First seen</th><th>Last seen</th><th>Release</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <td><a href={`/ops/errors/${g.id}`}>{g.type}</a></td>
                <td>{g.message}</td>
                <td className="ops-note">{g.culprit || "—"}</td>
                {/* eventCount is every occurrence; storedCount is what the hourly cap actually kept
                    -- past 100/hour only the count itself moves, so both numbers matter here. */}
                <td>{g.eventCount === g.storedCount ? g.eventCount : `${g.eventCount} (${g.storedCount} stored)`}</td>
                <td>{g.affectedUsers}</td>
                <td className="ops-note">{fmt(g.firstSeen)}</td>
                <td className="ops-note">{fmt(g.lastSeen)}</td>
                <td>{g.lastRelease ?? "—"}</td>
                <td><span className={`ops-tag ${STATUS_TAG[g.status]}`}>{g.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
