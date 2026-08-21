const SENSITIVE = /(pass|pwd|secret|token|api[-_]?key|\bkey\b|auth|cookie|session)/i;
const MAX_DEPTH = 6;
const MAX_STRING = 2000;

/**
 * Returns a copy with anything credential-shaped replaced. Keys are matched by
 * name rather than value, because a value that looks harmless today becomes a
 * credential the moment someone renames a field.
 */
export function redactContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();

  function walk(value: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) return "<deep>";
    if (typeof value === "string") return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + "…" : value;
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "<circular>";
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => walk(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? "<redacted>" : walk(v, depth + 1);
    }
    return out;
  }

  return walk(ctx, 0) as Record<string, unknown>;
}
