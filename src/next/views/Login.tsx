/**
 * The login password visibility script. A password manager can silently fill the
 * wrong entry, and without a way to see the field an operator cannot tell a
 * mistyped password from a broken gate — which is exactly the situation /ops
 * exists to resolve. Kept inline and dependency-free; the rest of the portal
 * still runs with JavaScript disabled, including signing in.
 */
const SHOW_PASSWORD = `
(function () {
  var box = document.getElementById("ops-pw-show");
  var field = document.getElementById("ops-pw");
  if (!box || !field) return;
  box.addEventListener("change", function () {
    field.type = box.checked ? "text" : "password";
  });
})();
`;

export function Login({ error }: { error?: string }) {
  return (
    <div className="ops-card" style={{ maxWidth: 380, margin: "10vh auto" }}>
      <h1>Operations</h1>
      <p className="ops-note">Sign in with your operations credentials.</p>
      {error && <p className="ops-error" role="alert">Invalid email or password.</p>}
      <form method="post" action="/ops/api/login">
        <p>
          <label className="ops-field" htmlFor="ops-login-email"><span>Email</span>
          <input
            id="ops-login-email"
            name="email"
            type="email"
            placeholder="Email"
            required
            autoComplete="off"
            style={{ width: "100%" }}
          /></label>
        </p>
        <p>
          <label className="ops-field" htmlFor="ops-pw"><span>Ops password</span>
          <input
            id="ops-pw"
            name="password"
            type="password"
            placeholder="Ops password"
            required
            // Never "current-password": the ops password shares a domain with
            // the host application's own login, so a password manager offers
            // the app's credential here and can overwrite what the operator
            // typed at submit time — the field looks right and the wrong bytes
            // are sent.
            autoComplete="off"
            style={{ width: "100%" }}
          /></label>
        </p>
        <p className="ops-note">
          <label className="ops-checkbox">
            <input type="checkbox" id="ops-pw-show" /> Show password
          </label>
        </p>
        <button type="submit">Sign in</button>
      </form>
      <script dangerouslySetInnerHTML={{ __html: SHOW_PASSWORD }} />
    </div>
  );
}
