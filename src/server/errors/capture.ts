import type { OpsInstance } from "../config";
import { recordError, type CapturedError } from "./store";

const MAX_COERCED_MESSAGE = 2000;

/**
 * Renders a thrown value that isn't an `Error` into a usable message.
 * `JSON.stringify` throws on a circular structure, so this falls back to
 * `String(value)` (which never throws) rather than letting that propagate —
 * a capture must never itself become the thing that throws.
 */
function describeNonError(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json.slice(0, MAX_COERCED_MESSAGE);
  } catch {
    // fall through to String()
  }
  try {
    return String(value).slice(0, MAX_COERCED_MESSAGE);
  } catch {
    return "<unrepresentable value thrown>";
  }
}

/**
 * Normalises whatever was thrown into the shape `recordError` expects.
 * Anything can be thrown in JS, not just `Error` instances, so this degrades
 * gracefully instead of assuming `.message`/`.stack` exist.
 */
function toCapturedError(err: unknown, context?: Record<string, unknown>): CapturedError {
  if (err instanceof Error) {
    return {
      type: err.name || "Error",
      message: err.message,
      stack: err.stack,
      source: "server",
      context,
    };
  }
  return {
    type: "Error",
    message: typeof err === "string" && err ? err : describeNonError(err),
    source: "server",
    context,
  };
}

/**
 * Captures one occurrence of a server-side error into the ops error store.
 *
 * Synchronous and never throws: it must never affect the request it is
 * describing, so the actual database write happens fire-and-forget, after
 * giving the package's own migrations a chance to apply (`ops.ready()`).
 * `recordError` itself already never rejects (it logs and swallows any
 * failure), so there is nothing here worth awaiting -- the `.catch(() => {})`
 * below exists only to guard `ops.ready()` rejecting (e.g. the database is
 * unreachable), which is outside `recordError`'s own try/catch.
 */
export function captureError(ops: OpsInstance, err: unknown, context?: Record<string, unknown>): void {
  try {
    const event = toCapturedError(err, context);
    void ops.ready()
      .then(() => recordError(ops.pool, event))
      .catch(() => {
        // ops.ready() rejected -- already logged by ready()'s own catch (via
        // the pool it manages); nothing more to do here. A capture must
        // never throw or produce an unhandled rejection.
      });
  } catch {
    // Constructing the event itself (e.g. a pathological toString()) must
    // never throw either.
  }
}
