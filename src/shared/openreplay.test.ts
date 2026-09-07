import { test } from "node:test";
import assert from "node:assert/strict";
import { openReplayUrl } from "./openreplay";

const project = "https://replay.example.test/42";
test("replay links retain the exact project, session and error position, dropping other data", () => {
  assert.equal(openReplayUrl(`${project}/session/123456?jumpto=4500&token=secret#private`, project), `${project}/session/123456?jumpto=4500`);
  assert.equal(openReplayUrl(`${project}/session/123456?jumpto=-1`, project), `${project}/session/123456`);
});
test("untrusted replay links cannot point outside the configured project", () => {
  for (const url of ["javascript:alert(1)", "//evil.test/42/session/123", "http://replay.example.test/42/session/123",
    "https://evil.test/42/session/123", "https://replay.example.test.evil.test/42/session/123",
    "https://u:p@replay.example.test/42/session/123", `${project}/../43/session/123`,
    `${project}/session/123/redirect`, `${project}/session/%31`, `${project}/session/nope`, null, {},
    ` ${project}/session/123`, `${project}/session/123\n`]) {
    assert.equal(openReplayUrl(url, project), undefined, String(url));
  }
});
test("storage can strip query credentials before a project is known", () => {
  assert.equal(openReplayUrl(`${project}/session/123?password=secret`), `${project}/session/123`);
});
