import bcrypt from "bcryptjs";

export type OpsEnv = {
  OPS_ADMIN_EMAILS?: string;
  OPS_PASSWORD_HASH?: string;
  OPS_SECRET?: string;
};

// Cost-10 hash of a value nobody knows. Compared against when the supplied email
// is not on the list, so the allowed and denied paths burn the same CPU and the
// list cannot be probed by timing.
const DECOY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

function readEnv(env?: OpsEnv): OpsEnv {
  return env ?? (process.env as OpsEnv);
}

function allowedEmails(env?: OpsEnv): string[] {
  return (readEnv(env).OPS_ADMIN_EMAILS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** True only when every credential the gate needs is configured. Fails closed. */
export function opsEnabled(env?: OpsEnv): boolean {
  const e = readEnv(env);
  return Boolean(e.OPS_PASSWORD_HASH?.trim() && e.OPS_SECRET?.trim() && allowedEmails(env).length);
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
    return allowed && matched;
  } catch {
    return false;
  }
}
