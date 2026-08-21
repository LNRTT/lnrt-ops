import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePassword, canHardDelete, resetPassword, type OpsUserStore } from "./users";

function fakeStore(extra: Partial<OpsUserStore> = {}): OpsUserStore & { lastPassword?: string } {
  const store: OpsUserStore & { lastPassword?: string } = {
    roles: ["ADMIN", "WORKER"],
    async list() { return { users: [], total: 0 }; },
    async get() { return null; },
    async create(input) {
      return { id: "u1", email: input.email, name: input.name, role: input.role, disabled: false, hasPassword: false };
    },
    async setPassword(_id, plaintext) { store.lastPassword = plaintext; },
    async setRole() {},
    async setDisabled() {},
    ...extra,
  };
  return store;
}

test("generated passwords are long, varied and free of ambiguous characters", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword();
    assert.equal(pw.length, 20);
    assert.match(pw, /^[^0OIl1]+$/, "must avoid characters that are misread when dictated");
    seen.add(pw);
  }
  assert.equal(seen.size, 200, "passwords must not repeat");
});

test("hard delete is offered only when the adapter implements it", () => {
  assert.equal(canHardDelete(fakeStore()), false);
  assert.equal(canHardDelete(fakeStore({ hardDelete: async () => {} })), true);
});

test("resetPassword generates one and hands it back exactly once", async () => {
  const store = fakeStore();
  const shown = await resetPassword(store, "u1");
  assert.equal(shown.length, 20);
  assert.equal(store.lastPassword, shown, "the store must receive the same plaintext that is shown");
});

test("resetPassword accepts an explicit password", async () => {
  const store = fakeStore();
  const shown = await resetPassword(store, "u1", "my chosen password");
  assert.equal(shown, "my chosen password");
  assert.equal(store.lastPassword, "my chosen password");
});

test("resetPassword rejects a short explicit password", async () => {
  await assert.rejects(() => resetPassword(fakeStore(), "u1", "short"), /at least 12/);
});
