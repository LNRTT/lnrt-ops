import { test } from "node:test";
import assert from "node:assert/strict";
import { getPool } from "./db";

// Dummy connection string: this test never actually connects, so it does not
// need a real database — Pool objects only connect on first query.
const URL = "postgres://ops:ops@127.0.0.1:1/getpool_probe";

test("getPool reuses the cached pool for the same connection string", () => {
  const first = getPool(URL);
  assert.equal(getPool(URL), first);
});

test("getPool returns a fresh pool once the cached one has been ended", async () => {
  const first = getPool(URL);
  await first.end();

  const second = getPool(URL);
  assert.notEqual(second, first, "an ended pool must not be handed out again");
  assert.equal(second.ended, false);

  await second.end();
});
