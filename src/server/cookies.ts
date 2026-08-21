/** Reads one cookie out of a raw `Cookie:` header. Returns undefined when absent. */
export function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Builds a `Set-Cookie` value from the attribute shape `opsCookieAttrs()` returns. */
export function serializeCookie(
  name: string, value: string, attrs: Record<string, unknown>,
): string {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  if (attrs.maxAge !== undefined) bits.push(`Max-Age=${attrs.maxAge}`);
  if (attrs.path) bits.push(`Path=${attrs.path}`);
  if (attrs.httpOnly) bits.push("HttpOnly");
  if (attrs.secure) bits.push("Secure");
  if (attrs.sameSite) {
    bits.push(`SameSite=${String(attrs.sameSite).replace(/^./, (c) => c.toUpperCase())}`);
  }
  return bits.join("; ");
}
