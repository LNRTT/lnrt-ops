const SENSITIVE = /(pass|pwd|secret|token|credential|apikey|privatekey|signingkey|auth|cookie|session|bearer|key)/;
const MAX_DEPTH = 6;
const MAX_STRING = 2000;

/**
 * Normalises a key name before testing it against `SENSITIVE`: strips
 * everything that is not a letter or digit and lowercases it, so
 * `PRIVATE_KEY` and `x-api-key` match the same plain substrings that
 * `apiToken` and `SESSION_SECRET` do. A naive `\bkey\b` never matches
 * `PRIVATE_KEY` — `_` is a word character, so there is no boundary between
 * `_` and `K` — which let real credentials through unredacted.
 */
function isSensitive(name: string): boolean {
  return SENSITIVE.test(name.replace(/[^a-z0-9]/gi, "").toLowerCase());
}

/**
 * Returns a copy with anything credential-shaped replaced. Keys are matched by
 * name rather than value, because a value that looks harmless today becomes a
 * credential the moment someone renames a field.
 */
export function redactContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const ancestors = new WeakSet<object>();

  function walk(value: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) return "<deep>";
    if (typeof value === "string") return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + "…" : value;
    if (value === null || typeof value !== "object") return value;
    if (ancestors.has(value)) return "<circular>";
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.slice(0, 50).map((v) => walk(v, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = isSensitive(k) ? "<redacted>" : walk(v, depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(value);
    }
  }

  return walk(ctx, 0) as Record<string, unknown>;
}
