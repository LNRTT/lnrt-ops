import bcrypt from "bcryptjs";

export type OpsEnv = {
  OPS_ADMIN_EMAILS?: string;
  OPS_PASSWORD_HASH?: string;
  OPS_SECRET?: string;
  /** Set to "1" to log the shape of a rejected sign-in. Never logs the value. */
  OPS_DEBUG_LOGIN?: string;
};

// Cost-10 hash of a value nobody knows. Compared against when the supplied email
// is not on the list, so the allowed and denied paths burn the same CPU and the
// list cannot be probed by timing.
const DECOY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

// HS256 signing key floor. Shorter keys are brute-forceable offline from one
// captured cookie, where no rate limit applies.
const MIN_SECRET_LENGTH = 32;

// $2a$/$2b$/$2y$, a two-digit cost, then a 53-char salt+digest.
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

let warned = false;

/** Logs once why the gate refused to come up. Never prints any value. */
function warnOnce(reason: string): void {
  if (warned) return;
  warned = true;
  console.error(`[ops] /ops is disabled: ${reason}`);
}

function readEnv(env?: OpsEnv): OpsEnv {
  return env ?? (process.env as OpsEnv);
}

function allowedEmails(env?: OpsEnv): string[] {
  return (readEnv(env).OPS_ADMIN_EMAILS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * True only when every credential the gate needs is present AND well-formed.
 * Fails closed: a misconfigured gate is a 404, never a weakened gate. The
 * reason is logged once to the container log, because a bare 404 is otherwise
 * impossible to diagnose.
 */
export function opsEnabled(env?: OpsEnv): boolean {
  const e = readEnv(env);
  const secret = e.OPS_SECRET?.trim() ?? "";
  const hash = e.OPS_PASSWORD_HASH?.trim() ?? "";

  if (!allowedEmails(env).length) { warnOnce("OPS_ADMIN_EMAILS is empty"); return false; }
  if (!hash) { warnOnce("OPS_PASSWORD_HASH is not set"); return false; }
  if (!BCRYPT_HASH.test(hash)) {
    warnOnce("OPS_PASSWORD_HASH is not a bcrypt hash — did a plaintext password get pasted in?");
    return false;
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    warnOnce(`OPS_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    return false;
  }
  return true;
}

export function isAllowedEmail(email: string, env?: OpsEnv): boolean {
  return allowedEmails(env).includes(email.trim().toLowerCase());
}

/** Never throws; a misconfigured gate denies rather than erroring. */
export async function verifyCredentials(
  email: string, password: string, env?: OpsEnv,
): Promise<boolean> {
  if (!opsEnabled(env)) return false;
  const allowed = isAllowedEmail(email, env);
  const hash = allowed ? readEnv(env).OPS_PASSWORD_HASH! : DECOY_HASH;
  try {
    const matched = await bcrypt.compare(password, hash);
    if (!(allowed && matched)) await describeRejection(email, password, hash, allowed, env);
    return allowed && matched;
  } catch {
    return false;
  }
}

/**
 * Temporary diagnostic, off unless OPS_DEBUG_LOGIN=1.
 *
 * When an operator insists they typed the right password, the useful question
 * is what actually arrived — a password manager overwriting the field, a pasted
 * trailing space, or a different value entirely. This reports the shape of the
 * submission and never the submission itself: no password, no hash, no email
 * beyond whether it was on the allow-list.
 */
async function describeRejection(
  email: string, password: string, hash: string, allowed: boolean, env?: OpsEnv,
): Promise<void> {
  if (readEnv(env).OPS_DEBUG_LOGIN !== "1") return;
  let trimmedWouldMatch = false;
  try {
    if (allowed && password.trim() !== password) {
      trimmedWouldMatch = await bcrypt.compare(password.trim(), hash);
    }
  } catch {
    // A diagnostic must never change the outcome it is diagnosing.
  }
  console.error(
    "[ops][debug] rejected sign-in:",
    JSON.stringify({
      emailOnAllowList: allowed,
      chars: password.length,
      bytes: Buffer.byteLength(password, "utf8"),
      charsAfterTrim: password.trim().length,
      trimmedWouldMatch,
      hasNonAscii: /[^\x20-\x7e]/.test(password),
      firstCharCode: password.charCodeAt(0) || null,
      lastCharCode: password.charCodeAt(password.length - 1) || null,
    }),
  );
}
