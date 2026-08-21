import type { OpsUser } from "../../server/users";

export function Users({
  users, total, query, csrf,
}: { users: OpsUser[]; total: number; query: string; csrf: string }) {
  return (
    <>
      <div className="ops-card">
        <h2>Add a user</h2>
        <form className="ops-row" method="post" action="/ops/api/users/create">
          <input type="hidden" name="csrf" value={csrf} />
          <input name="email" type="email" placeholder="Email" required />
          <input name="name" placeholder="Name" required />
          <input name="role" placeholder="Role" required list="ops-roles" />
          <button type="submit">Create</button>
        </form>
        <p className="ops-note">No password is set. A one-time sign-in link is produced instead.</p>
      </div>
      <div className="ops-card">
        <h2>Users ({total})</h2>
        <form className="ops-row" method="get" action="/ops/users">
          <input name="q" placeholder="Search name or email" defaultValue={query} />
          <label><input type="checkbox" name="disabled" value="1" /> include disabled</label>
          <button type="submit">Search</button>
        </form>
        <table className="ops-table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>State</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><a href={`/ops/users/${u.id}`}>{u.name}</a></td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>
                  {u.disabled && <span className="ops-tag bad">Disabled</span>}
                  {!u.hasPassword && <span className="ops-tag warn">No password</span>}
                  {!u.disabled && u.hasPassword && <span className="ops-tag good">Active</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
