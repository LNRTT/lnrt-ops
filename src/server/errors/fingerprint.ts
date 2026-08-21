import { createHash } from "node:crypto";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HEX = /\b[0-9a-f]{16,}\b/gi;
const NUMBERS = /\b\d+\b/g;
const QUOTED = /(["'`])(?:\\.|(?!\1)[^\\])*\1/g;

/** Removes the parts of a message that differ between two hits of one bug. */
export function normalizeMessage(msg: string): string {
  return msg
    .replace(UUID, "<id>")
    .replace(LONG_HEX, "<hex>")
    .replace(QUOTED, "<str>")
    .replace(NUMBERS, "<n>")
    .trim()
    .slice(0, 500);
}

/**
 * The first stack frame belonging to the application rather than a dependency.
 * Grouping on a `node_modules` frame would merge every unrelated bug that
 * happens to fail inside the same library.
 */
function firstAppFrame(stack: string | undefined): string {
  if (!stack) return "";
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) continue;
    if (trimmed.includes("node_modules")) continue;
    if (trimmed.includes("node:internal")) continue;
    // Keep file and line, drop the column and any absolute prefix noise.
    const m = trimmed.match(/\(?([^\s()]+:\d+):\d+\)?$/);
    if (m) return m[1]!;
  }
  return "";
}

export function fingerprint(input: { type: string; message: string; stack?: string }): string {
  const basis = [input.type, normalizeMessage(input.message), firstAppFrame(input.stack)].join("|");
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}
