import type { AuditRow } from "../../server/audit";

export function Audit({ rows }: { rows: AuditRow[] }) {
  return (
    <div className="ops-card">
      <h2>Audit</h2>
      <table className="ops-table">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th><th>IP</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.at.toISOString().replace("T", " ").slice(0, 19)}</td>
              <td>{r.actor}</td>
              <td>{r.action}</td>
              <td>{r.summary}</td>
              <td className="ops-note">{r.ip ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
