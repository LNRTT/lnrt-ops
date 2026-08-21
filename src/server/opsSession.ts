import { SignJWT, jwtVerify } from "jose";

export const OPS_COOKIE = "lnrt_ops";
/** Carries a one-time reveal (a generated password or login link) between POST and GET. */
export const OPS_FLASH_COOKIE = "lnrt_ops_flash";

const ALG = "HS256";
export const OPS_TTL_SECONDS = 8 * 60 * 60;

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signOpsToken(
  email: string, secret: string, ttlSeconds: number = OPS_TTL_SECONDS,
): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key(secret));
}

export async function verifyOpsToken(
  token: string | undefined, secret: string,
): Promise<{ email: string } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: [ALG] });
    return typeof payload.email === "string" ? { email: payload.email } : null;
  } catch {
    return null;
  }
}

/**
 * `secure` defaults to true and the caller opts out explicitly. Deriving it from
 * NODE_ENV silently drops the flag on any HTTPS deployment that does not happen
 * to set NODE_ENV=production — a footgun on the most sensitive cookie here.
 * Browsers accept Secure cookies on http://localhost, so local development is
 * unaffected by the default.
 */
export function opsCookieAttrs(maxAgeSeconds: number, opts: { secure?: boolean } = {}) {
  return {
    httpOnly: true as const,
    secure: opts.secure ?? true,
    sameSite: "strict" as const,
    path: "/ops" as const,
    maxAge: maxAgeSeconds,
  };
}
