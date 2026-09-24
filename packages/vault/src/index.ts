/**
 * `@nostr-wot/vault` — the vault cryptography shared by every `@nostr-wot` host.
 *
 * PBKDF2-HMAC-SHA-256 and AES-256-GCM in pure JavaScript, byte compatible with the vaults the
 * browser extension already wrote with WebCrypto, and running where there is no `crypto.subtle`
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
} from './constants.js';
export type { Pbkdf2Port } from './crypto.js';
export { iterationsFor, noblePbkdf2, encrypt, decrypt } from './crypto.js';

export type {
  MemoryAccount,
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
} from './serialization.js';
export { openRecord, sealPayload } from './record.js';
