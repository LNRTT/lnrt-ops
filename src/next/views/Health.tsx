import type { CheckResult } from "../../server/health/index";

const TAG: Record<CheckResult["status"], string> = { ok: "good", warn: "warn", fail: "bad" };

export function Health({ results }: { results: CheckResult[] }) {
  return (
    <div className="ops-card">
      <h1>Health</h1>
      <table className="ops-table ops-mobile-table">
        <thead><tr><th>Check</th><th>Status</th><th>Detail</th><th>Took</th></tr></thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.id}>
              <td data-label="Check">{r.label}</td>
              <td data-label="Status"><span className={`ops-tag ${TAG[r.status]}`}>{r.status}</span></td>
              <td data-label="Detail">{r.detail ?? "—"}</td>
              <td data-label="Took" className="ops-note">{r.durationMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
