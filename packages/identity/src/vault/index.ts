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
  MemoryNip46Config,
  OpaqueWalletConfig,
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
  bytesToHexBytes,
  hexBytesToBytes,
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

export type {
  AccountRemovalInfo,
  ImportedPqKeys,
  PqKeyPair,
  RemoteSignerAccount,
  RemoteSignerCredentials,
  VaultAccount,
  VaultAccountWithWallet,
  VaultOptions,
} from './vault.js';
export { Vault, VaultLockedOutError } from './vault.js';

export {
  PASSKEY_RP_ID,
  PASSKEY_VAULT_VERSION,
  PASSKEY_BACKUP_FORMAT,
  PASSKEY_MAX_BACKUP_BYTES,
  PASSKEY_MAX_CREDENTIALS,
  PASSKEY_KDF_CONTEXT,
  validatePasskeyInput,
  validatePasskeyEnrollment,
  validatePasskeyRecord,
  parsePasskeyBackup,
  serializePasskeyBackup,
  wrapVaultKey,
  unwrapVaultKey,
  withPasskeyVaultKey,
  sealPasskeyPayload,
  createPasskeyRecord,
  openPasskeyRecord,
} from './passkey.js';
export type {
  PasskeyMetadata,
  PasskeyInput,
  PasskeyProof,
  PasskeyWrapper,
  PasskeyEnrollment,
  PasskeyVaultRecord,
} from './passkey.js';

export { LEGACY_PASSKEY_RP_ID, PASSKEY_RECOVERY_PRF_SALT, validPasskeyRpId } from './passkey.js';
export {
  RECOVERY_EVENT_KIND, RECOVERY_PAYLOAD_VERSION, RECOVERY_MAX_BYTES, RECOVERY_MAX_BLOB_BYTES,
  RECOVERY_PRF_INPUT, RECOVERY_SCHEMAS, recoverySchema, recoveryCoordinate,
  encryptRecoveryPayload, decryptRecoveryPayload, buildRecoveryEvent,
  validateRecoveryEvent, recoveryContextFromEvent, saveRecovery, restoreRecovery,
} from './recovery.js';
export type { RecoveryScope, RecoveryContext, RecoveryEvent, RecoveryEventTemplate, RecoveryVerifier, RecoveryProvider, RecoveryTransport, RecoveryFilter, PasskeyAssertionRequest, PasskeyAssertionResult } from './recovery.js';

export { DEFAULT_DERIVED_PARAMETER_SET, derivedPrfInput, deriveNostrKey, encodeDerivedHandle, encodeStoredHandle, classifyPasskeyHandle } from './passkey-modes.js';
export type { DerivedParameterSet, PasskeyHandleClass } from './passkey-modes.js';
export { STORED_RECOVERY_EVENT_KIND, storedPrfInput, encryptStoredRecord, openStoredRecord, storedPayloadKeys, storedSeedKey, saveStoredRecord } from './passkey-store.js';
export type { StoredRecordContext, StoredPayload, StoredSeed, StoredVault, StoredVaultAccount, StoredKey } from './passkey-store.js';
export { resolvePasskeyIdentity, derivePasskeyIdentity } from './passkey-identity.js';
export type { PasskeyIdentity, PasskeyIdentityError, ResolvePasskeyIdentityOptions } from './passkey-identity.js';
export { parseNosskeyAccount, nosskeyPrfInput, recoverNosskeyAccount } from './nosskey.js';
export type { NosskeyAccount } from './nosskey.js';
