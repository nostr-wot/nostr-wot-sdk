/**
 * `@nostr-wot/vault` — the vault cryptography shared by every `@nostr-wot` host.
 *
 * PBKDF2-HMAC-SHA-256 and AES-256-GCM in pure JavaScript, byte compatible with the vaults the
 * browser extension already wrote with WebCrypto, and running where there is no `SubtleCrypto`
 * at all.
 */
export {
  VAULT_VERSION,
  VAULT_PBKDF2_ITERATIONS,
  LEGACY_VAULT_PBKDF2_ITERATIONS,
  MIN_PASSWORD_LENGTH,
  VAULT_SALT_BYTES,
  VAULT_IV_BYTES,
  VAULT_KEY_BYTES,
  VAULT_STORAGE_KEY,
  LOCK_STATE_KEY,
  UNLOCK_GUARD_KEY,
  AUTO_LOCK_STORAGE_KEY,
  DEFAULT_AUTO_LOCK_MS,
} from './constants.js';
export type { Pbkdf2Port } from './crypto.js';
export { iterationsFor, noblePbkdf2, encrypt, decrypt } from './crypto.js';

export type {
  MemoryAccount,
  OpenedRecord,
  MemoryVaultPayload,
  VaultPayload,
  VaultRecord,
} from './types.js';
export {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  hexToBytes,
  toMemoryAccount,
  toMemoryPayload,
  toStorageAccount,
  toStoragePayload,
  zeroMemoryAccount,
  zeroMemoryPayload,
} from './serialization.js';
export { openRecord, sealPayload } from './record.js';

export type { UnlockGuardState } from './guard.js';
export {
  UNLOCK_FAILURES_PER_LOCKOUT,
  UNLOCK_LOCKOUT_STEPS_MS,
  emptyGuardState,
  guardLockoutRemaining,
  nextGuardState,
} from './guard.js';

export type { AutoLockOption } from './autolock.js';
export { AUTO_LOCK_OPTIONS, shouldAutoLock } from './autolock.js';

export type { VaultOptions } from './vault.js';
export { Vault, VaultLockedOutError } from './vault.js';
