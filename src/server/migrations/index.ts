import type { Migration } from "../migrate.ts";
import { m001Init } from "./001-init.ts";

/** Ordered. Never reorder or edit a shipped migration — append a new one. */
export const ALL_MIGRATIONS: Migration[] = [m001Init];
