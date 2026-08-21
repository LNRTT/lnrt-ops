import type { Migration } from "../migrate";
import { m001Init } from "./001-init";

/** Ordered. Never reorder or edit a shipped migration — append a new one. */
export const ALL_MIGRATIONS: Migration[] = [m001Init];
