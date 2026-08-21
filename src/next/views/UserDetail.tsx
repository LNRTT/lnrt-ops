import type { OpsUser } from "../../server/users";

export function UserDetail({
  user, roles, allowDelete, allowLoginLink, reveal, csrf,
}: {
  user: OpsUser; roles: string[]; allowDelete: boolean; allowLoginLink: boolean;
  reveal?: { kind: "password" | "link"; value: string }; csrf: string;
}) {
  return (
    <>
      <div className="ops-card">
        <h2>{user.name} — {user.email}</h2>
        <p className="ops-note">
          Role {user.role} · {user.disabled ? "disabled" : "active"} ·{" "}
          {user.hasPassword ? "password set" : "no password set"}
        </p>
        <p><a href={`/ops/errors?user=${user.id}`}>View errors reported for this user</a></p>
      </div>

      {reveal && (
        <div className="ops-card">
          <h2>{reveal.kind === "password" ? "New password" : "Sign-in link"}</h2>
          <p className="ops-reveal">{reveal.value}</p>
          <p className="ops-note">
            Copy it now. It is not stored server-side, and the cookie carrying it expires within a
            minute — a refresh or a back-navigation before then will show it again.
          </p>
        </div>
      )}

      <div className="ops-card">
        <h2>Actions</h2>
        <form className="ops-row" method="post" action="/ops/api/users/password">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="id" value={user.id} />
          <input name="password" placeholder="Leave blank to generate one" />
          <button type="submit">Set password</button>
        </form>

        {allowLoginLink && (
          <form className="ops-row" method="post" action="/ops/api/users/login-link">
            <input type="hidden" name="csrf" value={csrf} />
            <input type="hidden" name="id" value={user.id} />
            <button type="submit">Create a sign-in link</button>
          </form>
        )}

        <form className="ops-row" method="post" action="/ops/api/users/role">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="id" value={user.id} />
          <select name="role" defaultValue={user.role}>
            {roles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button type="submit">Change role</button>
        </form>

        <form className="ops-row" method="post" action="/ops/api/users/disable">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="id" value={user.id} />
          <input type="hidden" name="disabled" value={user.disabled ? "0" : "1"} />
          <button type="submit">{user.disabled ? "Restore account" : "Disable account"}</button>
        </form>
      </div>

      {allowDelete && (
        <div className="ops-card">
          <h2>Delete permanently</h2>
          <form className="ops-row" method="post" action="/ops/api/users/delete">
            <input type="hidden" name="csrf" value={csrf} />
            <input type="hidden" name="id" value={user.id} />
            <input name="confirm" placeholder={`Type ${user.email} to confirm`} required />
            <button className="ops-danger" type="submit">Delete</button>
          </form>
        </div>
      )}
    </>
  );
}
