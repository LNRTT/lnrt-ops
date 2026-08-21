import type { CheckResult } from "../../server/health/index";

const TAG: Record<CheckResult["status"], string> = { ok: "good", warn: "warn", fail: "bad" };

export function Health({ results }: { results: CheckResult[] }) {
  return (
    <div className="ops-card">
      <h2>Health</h2>
      <table className="ops-table">
        <thead><tr><th>Check</th><th>Status</th><th>Detail</th><th>Took</th></tr></thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.id}>
              <td>{r.label}</td>
              <td><span className={`ops-tag ${TAG[r.status]}`}>{r.status}</span></td>
              <td>{r.detail ?? "—"}</td>
              <td className="ops-note">{r.durationMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
