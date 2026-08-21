import { randomInt } from "node:crypto";

export type OpsUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  disabled: boolean;
  hasPassword: boolean;
  lastSignInAt?: Date | null;
};

export type OpsUserQuery = {
  search?: string;
  role?: string;
  includeDisabled?: boolean;
  page?: number;
  perPage?: number;
};

export type OpsUserPage = { users: OpsUser[]; total: number };

/**
 * The one interface a host project must satisfy. Six required methods; the
 * seventh is optional on purpose — omit `hardDelete` where user rows are
 * referenced by domain data, and the delete affordance disappears from the UI.
 */
export type OpsUserStore = {
  roles: string[];
  list(q: OpsUserQuery): Promise<OpsUserPage>;
  get(id: string): Promise<OpsUser | null>;
  create(input: { email: string; name: string; role: string }): Promise<OpsUser>;
  setPassword(id: string, plaintext: string): Promise<void>;
  setRole(id: string, role: string): Promise<void>;
  setDisabled(id: string, disabled: boolean): Promise<void>;
  hardDelete?(id: string): Promise<void>;
};

// No 0/O/I/l/1 — these get read aloud over the phone.
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MIN_PASSWORD_LENGTH = 12;

export function generatePassword(length = 20): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function canHardDelete(store: OpsUserStore): boolean {
  return typeof store.hardDelete === "function";
}

/**
 * Sets a password and returns the plaintext so the caller can reveal it once.
 * The package never persists or logs it — hashing is the adapter's job.
 */
export async function resetPassword(
  store: OpsUserStore, id: string, explicit?: string,
): Promise<string> {
  if (explicit !== undefined && explicit.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const plaintext = explicit ?? generatePassword();
  await store.setPassword(id, plaintext);
  return plaintext;
}
