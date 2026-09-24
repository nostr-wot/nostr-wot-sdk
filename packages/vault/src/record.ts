/**
 * Sealing and opening a version 1 vault record.
 *
 * Ported from the browser extension's `create()` and `unlock()` in
 * `src/services/vault/vault.ts`, reduced to the part that touches the record: everything about
 * sessions, storage, auto-lock and keep-alive stays with the host. What is left is the format,
 * and the format has to match byte for byte, because the vaults people already have were
 * written by that code.
 */
import { randomBytes } from '@noble/ciphers/utils.js';
import {
  LEGACY_VAULT_PBKDF2_ITERATIONS,
  VAULT_KEY_BYTES,
  VAULT_SALT_BYTES,
  VAULT_VERSION,
} from './constants.js';
import { decrypt, encrypt, iterationsFor, type Pbkdf2Port } from './crypto.js';
import { base64ToBytes, bytesToBase64 } from './serialization.js';
import type { OpenedRecord, VaultPayload, VaultRecord } from './types.js';

/**
 * Encrypt a payload into the record that goes to storage.
 *
 * The work factor comes from {@link iterationsFor} and is written into the record, so that
 * reading it back never has to guess and raising the constant later cannot lock anyone out.
 *
 * A payload with no `cacheKey` gets a fresh random one, exactly as the extension's `create()`
 * does. Writing records without the field would send every extension unlock down its "no cache
 * key, re-save the whole vault right now" branch.
 *
 * `password` is not validated here. {@link MIN_PASSWORD_LENGTH} is a host-level policy, and the
 * empty password is legitimate: it is how "never lock" mode is stored, still encrypted rather
 * than sitting in storage as plaintext.
 */
export async function sealPayload(
  payload: VaultPayload,
  password: string,
  kdf: Pbkdf2Port,
): Promise<VaultRecord> {
  const salt = randomBytes(VAULT_SALT_BYTES);
  const iterations = iterationsFor(password);
  const key = await kdf.derive(password, salt, iterations);
  const cacheKey = payload.cacheKey || bytesToBase64(randomBytes(VAULT_KEY_BYTES));
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  // try/finally, not a trailing fill: `encrypt` throws on a key that is not 256 bits, which is
  // reachable through a third-party `Pbkdf2Port`, and a thrown error must not leave the derived
  // key sitting un-zeroed on the heap.
  try {
    ({ iv, ciphertext } = encrypt(key, JSON.stringify({ ...payload, cacheKey })));
  } finally {
    key.fill(0);
  }
  return {
    version: VAULT_VERSION,
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
}

/**
 * Decrypt a record back into its payload.
 *
 * The work factor is read off the record rather than recomputed from the password. That is the
 * whole reason old vaults still open: records written before the constant was raised carry no
 * `iterations` field, and were all written at {@link LEGACY_VAULT_PBKDF2_ITERATIONS}.
 * Recomputing would derive at 600000 and fail to open exactly the oldest vaults in the field.
 *
 * Throws when the password is wrong: AES-GCM authenticates, so a wrong key fails the tag rather
 * than returning plausible garbage. The extension turns that into `unlock() === false`; this
 * layer lets it throw so a caller can tell a wrong password from a corrupt record.
 *
 * A decrypted payload with no `cacheKey` gets a fresh random one, as the extension's `unlock()`
 * does — the field was added after the format shipped, so the caller should never have to
 * handle its absence. When that happens the result says so with `cacheKeyMinted`, and the
 * caller MUST re-seal and store the record. A host that ignores it mints a different key on
 * every unlock, and the private cache written under the previous one silently never decrypts
 * again. The extension branches on exactly this (`if (!parsed.cacheKey)` then save).
 */
export async function openRecord(
  record: VaultRecord,
  password: string,
  kdf: Pbkdf2Port,
): Promise<OpenedRecord> {
  const salt = base64ToBytes(record.salt);
  const iv = base64ToBytes(record.iv);
  const ciphertext = base64ToBytes(record.ciphertext);
  const iterations =
    typeof record.iterations === 'number' ? record.iterations : LEGACY_VAULT_PBKDF2_ITERATIONS;

  const key = await kdf.derive(password, salt, iterations);
  let json: string;
  try {
    json = decrypt(key, iv, ciphertext);
  } finally {
    key.fill(0);
  }
  const parsed = JSON.parse(json) as VaultPayload;
  const cacheKeyMinted = !parsed.cacheKey;
  // The payload is rebuilt field by field rather than spread, so an unknown TOP-LEVEL key in
  // the decrypted JSON is dropped while an unknown key on an ACCOUNT rides through
  // `toMemoryAccount`/`toStorageAccount` untouched. The asymmetry is deliberate: it is exactly
  // what the extension's `unlock()` does, and matching the extension beats being tidy. Changing
  // it here would put fields in a record that the extension never wrote.
  return {
    payload: {
      cacheKey: parsed.cacheKey || bytesToBase64(randomBytes(VAULT_KEY_BYTES)),
      accounts: parsed.accounts,
      activeAccountId: parsed.activeAccountId,
    },
    cacheKeyMinted,
  };
}
