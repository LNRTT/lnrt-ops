import type { Migration } from "../migrate";
import { m001Init } from "./001-init";
import { m002Errors } from "./002-errors";

/** Ordered. Never reorder or edit a shipped migration — append a new one. */
export const ALL_MIGRATIONS: Migration[] = [m001Init, m002Errors];
