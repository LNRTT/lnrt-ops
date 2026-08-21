import type { Migration } from "../migrate.ts";

export const m001Init: Migration = {
  id: "001-init",
  sql: `
    CREATE TABLE ops_audit_log (
      id          bigserial PRIMARY KEY,
      at          timestamptz NOT NULL DEFAULT now(),
      actor       text        NOT NULL,
      action      text        NOT NULL,
      target_type text,
      target_id   text,
      summary     text        NOT NULL,
      ip          text,
      user_agent  text
    );
    CREATE INDEX ops_audit_log_at_idx ON ops_audit_log (at DESC);
    CREATE INDEX ops_audit_log_target_idx ON ops_audit_log (target_type, target_id);
  `,
};
