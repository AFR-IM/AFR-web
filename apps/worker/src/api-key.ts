// src/api-key.ts — API keys for machine clients.
//
// A human-verification gate in front of a public POST endpoint is hostile to
// the legitimate caller: an AI agent or a script cannot run a browser widget.
// The `api_keys` table exists for exactly that case — a key proves the caller
// is an authorised machine client, so the gate can step aside.
//
// The key itself never touches the database: only its SHA-256 hash is stored,
// so a database leak does not hand over usable credentials.

import type { Db } from './db.ts';

/** Header carrying the key. Dedicated (rather than `Authorization`) so it
 * cannot collide with the bearer token used by the owner mailbox routes. */
export const API_KEY_HEADER = 'x-afr-agent-key';

/** SHA-256 of the key, hex encoded — the value stored in `api_keys.key_hash`.
 * WebCrypto only: the module is bundled into the Worker, where node:crypto
 * does not exist. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(key),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Whether the presented key is a live key of this account.
 *
 * A revoked key (`revoked_at` set) and an unknown key are indistinguishable
 * from the outside — both answer false. */
export async function isValidApiKey(db: Db, key: string | null | undefined): Promise<boolean> {
  if (!key) return false;
  const trimmed = key.trim();
  if (!trimmed) return false;
  try {
    const row = await db
      .prepare(
        'SELECT key_hash FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1',
      )
      .get<{ key_hash: string }>(await hashApiKey(trimmed));
    return Boolean(row);
  } catch {
    // A missing table or a failing read must not open the gate.
    return false;
  }
}
