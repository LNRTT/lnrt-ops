import type { Migration } from "../migrate";

export const m002Errors: Migration = {
  id: "002-errors",
  sql: `
    CREATE TABLE ops_error_group (
      id           text PRIMARY KEY,
      type         text NOT NULL,
      message      text NOT NULL,
      culprit      text NOT NULL DEFAULT '',
      source       text NOT NULL,
      status       text NOT NULL DEFAULT 'open',
      first_seen   timestamptz NOT NULL DEFAULT now(),
      last_seen    timestamptz NOT NULL DEFAULT now(),
      event_count  bigint NOT NULL DEFAULT 0,
      stored_count bigint NOT NULL DEFAULT 0,
      last_release text
    );
    CREATE INDEX ops_error_group_last_seen_idx ON ops_error_group (last_seen DESC);
    CREATE INDEX ops_error_group_status_idx ON ops_error_group (status, last_seen DESC);

    CREATE TABLE ops_error_event (
      id         bigserial PRIMARY KEY,
      group_id   text NOT NULL REFERENCES ops_error_group(id) ON DELETE CASCADE,
      at         timestamptz NOT NULL DEFAULT now(),
      source     text NOT NULL,
      message    text NOT NULL,
      stack      text,
      url        text,
      method     text,
      user_id    text,
      user_role  text,
      request_id text,
      release    text,
      user_agent text,
      context    jsonb
    );
    CREATE INDEX ops_error_event_group_idx ON ops_error_event (group_id, at DESC);
    CREATE INDEX ops_error_event_user_idx ON ops_error_event (user_id, at DESC);
    CREATE INDEX ops_error_event_at_idx ON ops_error_event (at DESC);
  `,
};
