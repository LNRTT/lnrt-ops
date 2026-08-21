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

// A run of 8+ hex chars preceded by `-` or `.` looks like a content hash
// (e.g. Next.js's `/_next/static/chunks/4821-9f3ac1b2.js`).
const CONTENT_HASH = /([-.])[0-9a-f]{8,}(?=[-.]|$)/gi;

/**
 * Normalises a stack frame location so the identical bug fingerprints the
 * same regardless of deploy (content-hashed chunk names) or environment
 * (dev absolute path vs. container path).
 */
function normalizeLocation(loc: string): string {
  let out = loc;

  // Drop query string / fragment.
  out = out.replace(/[?#].*$/, "");

  // Drop origin, keep path.
  out = out.replace(/^[a-z]+:\/\/[^/]+/i, "");

  // Replace content-hash-looking runs in the filename with a placeholder.
  out = out.replace(CONTENT_HASH, "$1<hash>");

  // Collapse machine-specific prefixes.
  const srcIdx = out.indexOf("/src/");
  const appIdx = out.indexOf("/app/");
  if (srcIdx !== -1) {
    out = out.slice(srcIdx);
  } else if (appIdx !== -1) {
    out = out.slice(appIdx);
  } else {
    const parts = out.split("/");
    out = parts[parts.length - 1] ?? out;
  }

  return out;
}

// V8: "at fn (loc)" or "at loc"
const V8_FRAME = /^at\s+(.*)$/;
// SpiderMonkey/JSC: "fn@loc" or "@loc"
const SPIDERMONKEY_FRAME = /^([^@]*)@(.+)$/;
// Trailing `path:line:col` or `path:line`, optionally wrapped in parens.
const LOCATION = /\(?([^\s()]+:\d+(?::\d+)?)\)?$/;

/**
 * The first stack frame belonging to the application rather than a dependency.
 * Grouping on a `node_modules` frame would merge every unrelated bug that
 * happens to fail inside the same library.
 *
 * Understands both the V8 stack shape (`at fn (loc)`) used by Chrome/Node and
 * the SpiderMonkey/JSC shape (`fn@loc`) used by Firefox and Safari.
 */
export function firstAppFrame(stack: string | undefined): string {
  if (!stack) return "";
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let candidate: string | null = null;
    const v8Match = trimmed.match(V8_FRAME);
    if (v8Match) {
      candidate = v8Match[1]!;
    } else {
      const smMatch = trimmed.match(SPIDERMONKEY_FRAME);
      if (smMatch) candidate = smMatch[2]!;
    }
    if (candidate === null) continue;

    if (candidate.includes("node_modules")) continue;
    if (candidate.includes("node:internal")) continue;

    const m = candidate.match(LOCATION);
    if (m) return normalizeLocation(m[1]!);
  }
  return "";
}

export function fingerprint(input: { type: string; message: string; stack?: string }): string {
  const basis = [input.type, normalizeMessage(input.message), firstAppFrame(input.stack)].join("|");
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}
