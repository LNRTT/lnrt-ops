import type { Pool } from "pg";

export type CheckStatus = "ok" | "warn" | "fail";
export type CheckOutcome = { status: CheckStatus; detail?: string };
export type CheckResult = CheckOutcome & { id: string; label: string; durationMs: number };
export type CheckContext = { pool: Pool };
export type Check = { id: string; label: string; run(ctx: CheckContext): Promise<CheckOutcome> };

const DEFAULT_TIMEOUT_MS = 5_000;

async function withTimeout(p: Promise<CheckOutcome>, ms: number): Promise<CheckOutcome> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<CheckOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: "fail", detail: `Timed out after ${ms} ms` }), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Runs every check concurrently. A check that throws or hangs fails alone —
 * one broken probe must never blank the health page.
 */
export async function runChecks(
  checks: Check[], ctx: CheckContext, timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CheckResult[]> {
  return Promise.all(
    checks.map(async (c): Promise<CheckResult> => {
      const started = Date.now();
      let outcome: CheckOutcome;
      try {
        outcome = await withTimeout(Promise.resolve(c.run(ctx)), timeoutMs);
      } catch (err) {
        outcome = { status: "fail", detail: err instanceof Error ? err.message : String(err) };
      }
      return { id: c.id, label: c.label, ...outcome, durationMs: Date.now() - started };
    }),
  );
}
