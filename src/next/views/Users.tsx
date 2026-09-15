import type { OpsUser } from "../../server/users";

export function Users({
  users, total, query, roles, csrf, includeDisabled = false, allowLoginLink = true,
}: { users: OpsUser[]; total: number; query: string; roles: string[]; csrf: string; includeDisabled?: boolean; allowLoginLink?: boolean }) {
  return (
    <>
      <div className="ops-page-heading"><h1>Users</h1><p className="ops-note">Manage accounts, passwords and sign-in access.</p></div>
      <details className="ops-card">
        <summary>Add a user</summary>
        <form className="ops-row ops-action-form" method="post" action="/ops/api/users/create">
          <input type="hidden" name="csrf" value={csrf} />
          <label className="ops-field" htmlFor="ops-create-email"><span>Email</span>
            <input id="ops-create-email" name="email" type="email" autoComplete="off" required />
          </label>
          <label className="ops-field" htmlFor="ops-create-name"><span>Name</span>
            <input id="ops-create-name" name="name" autoComplete="off" required />
          </label>
          <label className="ops-field" htmlFor="ops-create-role"><span>Role</span>
            <select name="role" id="ops-create-role" required defaultValue="">
              <option value="" disabled>Choose role</option>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <button type="submit">Create</button>
        </form>
        <p className="ops-note">{allowLoginLink ? "No password is set. A one-time sign-in link is produced instead." : "No password is set. Set a password on the user’s detail page after creating the account."}</p>
      </details>
      <div className="ops-card">
        <h2>Accounts ({total})</h2>
        <form className="ops-row ops-filter-form" method="get" action="/ops/users">
          <label className="ops-field" htmlFor="ops-user-search"><span>Search name or email</span>
            <input id="ops-user-search" name="q" type="search" defaultValue={query} />
          </label>
          <label className="ops-checkbox"><input type="checkbox" name="disabled" value="1" defaultChecked={includeDisabled} /> Include disabled</label>
          <button type="submit">Search</button>
          {(query || includeDisabled) && <a className="ops-clear" href="/ops/users">Clear filters</a>}
        </form>
        {users.length === 0 ? <p className="ops-note">No users match these filters.</p> : (
          <table className="ops-table ops-mobile-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>State</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td data-label="Name"><a href={`/ops/users/${encodeURIComponent(u.id)}`}>{u.name}</a></td>
                  <td data-label="Email">{u.email}</td>
                  <td data-label="Role">{u.role}</td>
                  <td data-label="State"><div className="ops-tags">
                    {u.disabled && <span className="ops-tag bad">Disabled</span>}
                    {!u.hasPassword && <span className="ops-tag warn">No password</span>}
                    {!u.disabled && u.hasPassword && <span className="ops-tag good">Active</span>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
