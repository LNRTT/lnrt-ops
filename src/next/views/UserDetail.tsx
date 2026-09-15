import type { OpsUser } from "../../server/users";
import { CopyReveal } from "./CopyReveal.js";

export function UserDetail({
  user, roles, allowDelete, allowLoginLink, reveal, csrf,
}: {
  user: OpsUser; roles: string[]; allowDelete: boolean; allowLoginLink: boolean;
  reveal?: { kind: "password" | "link"; value: string }; csrf: string;
}) {
  return (
    <>
      <p className="ops-back"><a href="/ops/users">← Back to users</a></p>
      <div className="ops-card">
        <h1>{user.name}</h1>
        <p className="ops-user-email">{user.email}</p>
        <p className="ops-note">
          Role {user.role} · {user.disabled ? "disabled" : "active"} ·{" "}
          {user.hasPassword ? "password set" : "no password set"}
        </p>
        <p><a href={`/ops/errors?user=${encodeURIComponent(user.id)}`}>View errors reported for this user</a></p>
      </div>

      {reveal && (
        <div className="ops-card">
          <p className="ops-success" role="status">
            {reveal.kind === "password" ? "Password updated successfully." : "Sign-in link created."}
          </p>
          <CopyReveal kind={reveal.kind} value={reveal.value} />
          <p className="ops-note">
            Copy it now. The cookie carrying this value expires within a minute.
            Refreshing or going back before then can show it again.
            {reveal.kind === "link" && " The link can be used to sign in once."}
          </p>
        </div>
      )}

      <div className="ops-card">
        <h2>Set a new password</h2>
        <p className="ops-note" id="ops-password-help">Enter at least 12 characters, or leave blank to generate a password. The new password replaces the current one.</p>
        <form className="ops-row ops-action-form" method="post" action="/ops/api/users/password">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="id" value={user.id} />
          <label className="ops-field" htmlFor="ops-new-password"><span>New password (optional)</span>
            <input id="ops-new-password" name="password" type="password" autoComplete="new-password" minLength={12}
              aria-describedby="ops-password-help" placeholder="Generate a password" />
          </label>
          <button type="submit">Set password</button>
        </form>
      </div>

      {allowLoginLink && (
        <div className="ops-card">
          <h2>One-time sign-in link</h2>
          <p className="ops-note">Create a link to share with this user so they can sign in without their password.</p>
          <form className="ops-row" method="post" action="/ops/api/users/login-link">
            <input type="hidden" name="csrf" value={csrf} />
            <input type="hidden" name="id" value={user.id} />
            <button type="submit">Create a sign-in link</button>
          </form>
        </div>
      )}

      <div className="ops-card">
        <h2>Account settings</h2>
        <form className="ops-row ops-action-form" method="post" action="/ops/api/users/role">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="id" value={user.id} />
          <label className="ops-field" htmlFor="ops-user-role"><span>Role</span>
            <select name="role" id="ops-user-role" defaultValue={user.role}>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <button type="submit">Change role</button>
        </form>
        <p className="ops-note">{user.disabled ? "This account is disabled. Restore it to allow access again." : "Disable this account to block access while keeping its records."}</p>
        <form className="ops-row" method="post" action="/ops/api/users/disable">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="id" value={user.id} />
          <input type="hidden" name="disabled" value={user.disabled ? "0" : "1"} />
          <button type="submit" className="ops-secondary">{user.disabled ? "Restore account" : "Disable account"}</button>
        </form>
      </div>

      {allowDelete && (
        <details className="ops-card ops-delete">
          <summary>Delete permanently</summary>
          <p className="ops-note">This action cannot be undone. Enter the user’s email to confirm.</p>
          <form className="ops-row ops-action-form" method="post" action="/ops/api/users/delete">
            <input type="hidden" name="csrf" value={csrf} />
            <input type="hidden" name="id" value={user.id} />
            <label className="ops-field" htmlFor="ops-delete-confirm"><span>Confirm email</span>
              <input id="ops-delete-confirm" name="confirm" type="email" autoComplete="off" placeholder={user.email} required />
            </label>
            <button className="ops-danger" type="submit">Delete</button>
          </form>
        </details>
      )}
    </>
  );
}
