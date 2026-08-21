export function Login({ error }: { error?: string }) {
  return (
    <div className="ops-card" style={{ maxWidth: 380, margin: "10vh auto" }}>
      <h2>Operations</h2>
      {error && <p className="ops-error">Invalid email or password.</p>}
      <form method="post" action="/ops/api/login">
        <p><input name="email" type="email" placeholder="Email" required style={{ width: "100%" }} /></p>
        <p><input name="password" type="password" placeholder="Ops password" required style={{ width: "100%" }} /></p>
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
