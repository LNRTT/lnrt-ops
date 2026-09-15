import type { AuditRow } from "../../server/audit";

export function Audit({ rows }: { rows: AuditRow[] }) {
  return (
    <div className="ops-card">
      <h1>Audit</h1>
      <p className="ops-note">Recent operations, newest first. Times are in UTC.</p>
      {rows.length === 0 && <p className="ops-note">No operations recorded yet.</p>}
      <table className="ops-table ops-mobile-table">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th><th>IP</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td data-label="When (UTC)">{r.at.toISOString().replace("T", " ").slice(0, 19)}</td>
              <td data-label="Who">{r.actor}</td>
              <td data-label="Action">{r.action}</td>
              <td data-label="Detail">{r.summary}</td>
              <td data-label="IP" className="ops-note">{r.ip ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
