/** Reads one cookie out of a raw `Cookie:` header. Returns undefined when absent. */
export function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      const raw = v.join("=");
      // decodeURIComponent throws URIError on a bad escape (e.g. a bare "%").
      // A hostile or truncated Cookie header must not turn every session-gated
      // route into an anonymous 500 — fall back to the raw, undecoded value.
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

// Cookie attributes are interpolated into the Set-Cookie header without
// encoding (only the value goes through encodeURIComponent). A ';', CR or LF
// inside name/path/sameSite would let a caller inject extra attributes or
// even a second header. This is an exported helper, so it is a programming
// error to pass such a value, not user input — throw rather than sanitize.
const FORBIDDEN_ATTR_CHARS = /[;\r\n]/;

/** Builds a `Set-Cookie` value from the attribute shape `opsCookieAttrs()` returns. */
export function serializeCookie(
  name: string, value: string, attrs: Record<string, unknown>,
): string {
  if (FORBIDDEN_ATTR_CHARS.test(name)) {
    throw new Error(`serializeCookie: invalid cookie name ${JSON.stringify(name)}`);
  }
  if (attrs.path !== undefined && FORBIDDEN_ATTR_CHARS.test(String(attrs.path))) {
    throw new Error(`serializeCookie: invalid cookie path ${JSON.stringify(attrs.path)}`);
  }
  if (attrs.sameSite !== undefined && FORBIDDEN_ATTR_CHARS.test(String(attrs.sameSite))) {
    throw new Error(`serializeCookie: invalid cookie sameSite ${JSON.stringify(attrs.sameSite)}`);
  }
  if (attrs.maxAge !== undefined && !Number.isInteger(attrs.maxAge)) {
    throw new Error(`serializeCookie: maxAge must be an integer, got ${JSON.stringify(attrs.maxAge)}`);
  }

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
