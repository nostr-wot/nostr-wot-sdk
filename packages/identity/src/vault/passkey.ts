/** Portable passkey vault records. The host obtains WebAuthn PRF proofs and owns storage. */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { encrypt, decrypt } from './crypto.js';
import { base64ToBytes, bytesToBase64 } from './serialization.js';
import type { OpenedRecord, VaultPayload } from './types.js';

export const PASSKEY_RP_ID = 'passkeys.nostrwot.com';
export const LEGACY_PASSKEY_RP_ID = 'passkeys.nostr-wot.com';
export const PASSKEY_RECOVERY_PRF_SALT = 'a2V5dHItdjE=';
export const PASSKEY_VAULT_VERSION = 2;
export const PASSKEY_BACKUP_FORMAT = 'nostr-wot-passkey-vault';
export const PASSKEY_MAX_BACKUP_BYTES = 16 * 1024 * 1024;
export const PASSKEY_MAX_CREDENTIALS = 8;
export const PASSKEY_KDF_CONTEXT = 'nostr-wot/vault/passkey-wrap/v1';

export interface PasskeyMetadata {
  credentialId: string;
  prfSalt: string;
  rpId?: string;
  recoveryPubkey?: string;
  recoveryScope?: 'private-key' | 'seed' | 'vault';
}
/** Transient secret material; never persist or log PRF output. */
export interface PasskeyInput extends PasskeyMetadata {
  prf: string;
  largeBlobSupported?: boolean;
}
export interface PasskeyProof {
  credentialId: string;
  prf: string;
}
export interface PasskeyWrapper extends PasskeyMetadata {
  iv: string;
  ciphertext: string;
}
export interface PasskeyEnrollment {
  rpId: string;
  passkeys: PasskeyWrapper[];
}
export interface PasskeyVaultRecord extends PasskeyEnrollment {
  version: typeof PASSKEY_VAULT_VERSION;
  protection: 'passkey';
  iv: string;
  ciphertext: string;
}

export function validPasskeyRpId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && value.includes('.') && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) && value.split('.').every(label => label.length > 0 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'));
}
function validMetadata(value: PasskeyMetadata): boolean {
  return ((value.recoveryPubkey === undefined) === (value.recoveryScope === undefined)) && (value.rpId === undefined || validPasskeyRpId(value.rpId)) && (value.recoveryPubkey === undefined || /^[a-f0-9]{64}$/.test(value.recoveryPubkey)) && (value.recoveryScope === undefined || ['private-key', 'seed', 'vault'].includes(value.recoveryScope));
}
function validPrfSalt(value: unknown): boolean { return value === PASSKEY_RECOVERY_PRF_SALT || validBase64(value, 32); }

function validBase64(value: unknown, min: number, max = min): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4) return false;
  try {
    const bytes = base64ToBytes(value);
    try {
      return bytes.length >= min && bytes.length <= max && bytesToBase64(bytes) === value;
    } finally {
      bytes.fill(0);
    }
  } catch {
    return false;
  }
}

export function validatePasskeyInput(value: unknown): asserts value is PasskeyInput {
  const input = value as PasskeyInput | null;
  if (
    !input ||
    !validBase64(input.credentialId, 1, 1024) ||
    !validPrfSalt(input.prfSalt) || !validMetadata(input) ||
    !validBase64(input.prf, 32)
  )
    throw new Error('Invalid passkey encryption response');
}

function validWrapper(value: PasskeyWrapper): boolean {
  return (
    !!value &&
    validBase64(value.credentialId, 1, 1024) &&
    validPrfSalt(value.prfSalt) && validMetadata(value) &&
    validBase64(value.iv, 12) &&
    validBase64(value.ciphertext, 48)
  );
}

export function validatePasskeyEnrollment(value: unknown): asserts value is PasskeyEnrollment {
  const record = value as PasskeyEnrollment | null;
  if (
    !record ||
    !validPasskeyRpId(record.rpId) ||
    !Array.isArray(record.passkeys) ||
    record.passkeys.length < 1 ||
    record.passkeys.length > PASSKEY_MAX_CREDENTIALS ||
    record.passkeys.some((p) => !validWrapper(p)) ||
    record.rpId !== (record.passkeys[0]?.rpId ?? LEGACY_PASSKEY_RP_ID) ||
    new Set(record.passkeys.map((p) => p.credentialId)).size !== record.passkeys.length
  )
    throw new Error('Invalid passkey enrollment');
}

export function validatePasskeyRecord(value: unknown): asserts value is PasskeyVaultRecord {
  validatePasskeyEnrollment(value);
  const record = value as PasskeyVaultRecord;
  if (
    record.version !== PASSKEY_VAULT_VERSION ||
    record.protection !== 'passkey' ||
    !validBase64(record.iv, 12) ||
    !validBase64(record.ciphertext, 16, PASSKEY_MAX_BACKUP_BYTES)
  )
    throw new Error('Invalid passkey vault backup');
}

/** Bound untrusted input before parsing or decrypting. */
export function parsePasskeyBackup(text: string): PasskeyVaultRecord {
  if (typeof text !== 'string' || text.length > PASSKEY_MAX_BACKUP_BYTES)
    throw new Error('Invalid passkey vault backup');
  const value = JSON.parse(text);
  if (value?.format !== PASSKEY_BACKUP_FORMAT) throw new Error('Invalid passkey vault backup');
  validatePasskeyRecord(value.vault);
  return value.vault;
}

export function serializePasskeyBackup(record: PasskeyVaultRecord): string {
  validatePasskeyRecord(record);
  const text = JSON.stringify({ format: PASSKEY_BACKUP_FORMAT, vault: record });
  if (text.length > PASSKEY_MAX_BACKUP_BYTES) throw new Error('Passkey vault backup is too large');
  return text;
}

function wrappingKey(input: PasskeyInput): Uint8Array {
  validatePasskeyInput(input);
  const prf = base64ToBytes(input.prf);
  try {
    return hkdf(
      sha256,
      prf,
      base64ToBytes(input.prfSalt),
      new TextEncoder().encode(PASSKEY_KDF_CONTEXT),
      32,
    );
  } finally {
    prf.fill(0);
  }
}

function binding(wrapper: PasskeyMetadata): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([PASSKEY_KDF_CONTEXT, wrapper.rpId ?? LEGACY_PASSKEY_RP_ID, wrapper.credentialId, wrapper.prfSalt, ...(wrapper.recoveryPubkey ? [wrapper.recoveryPubkey, wrapper.recoveryScope] : [])]),
  );
}

/** The caller retains ownership of bytes; this function never retains or zeroes them. */
export function wrapVaultKey(bytes: Uint8Array, input: PasskeyInput): PasskeyWrapper {
  if (bytes.length !== 32) throw new Error('Invalid vault key');
  const key = wrappingKey(input);
  try {
    const iv = randomBytes(12);
    const ciphertext = gcm(key, iv, binding(input)).encrypt(bytes);
    return {
      ...(input.rpId ? { rpId: input.rpId } : {}),
      ...(input.recoveryPubkey ? { recoveryPubkey: input.recoveryPubkey, recoveryScope: input.recoveryScope } : {}),
      credentialId: input.credentialId,
      prfSalt: input.prfSalt,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext),
    };
  } finally {
    key.fill(0);
  }
}

/** Caller owns the returned secret and MUST zero it after use. Prefer withPasskeyVaultKey. */
export function unwrapVaultKey(wrapper: PasskeyWrapper, proof: PasskeyProof): Uint8Array {
  if (!validWrapper(wrapper) || !proof || proof.credentialId !== wrapper.credentialId)
    throw new Error('Passkey does not belong to this vault');
  const key = wrappingKey({ ...wrapper, prf: proof.prf });
  try {
    return gcm(key, base64ToBytes(wrapper.iv), binding(wrapper)).decrypt(
      base64ToBytes(wrapper.ciphertext),
    );
  } finally {
    key.fill(0);
  }
}

/** Scoped unwrap for payload saves and enrollment; the temporary key is always zeroed. */
export async function withPasskeyVaultKey<T>(
  record: PasskeyVaultRecord,
  proof: PasskeyProof,
  operation: (key: Uint8Array) => T | Promise<T>,
): Promise<T> {
  validatePasskeyRecord(record);
  const wrapper = record.passkeys.find((p) => p.credentialId === proof.credentialId);
  if (!wrapper) throw new Error('Passkey does not belong to this vault');
  const key = unwrapVaultKey(wrapper, proof);
  try {
    return await operation(key);
  } finally {
    key.fill(0);
  }
}

/** Re-seal under an existing key/enrollment with a fresh IV. Does not mutate the payload. */
export function sealPasskeyPayload(
  payload: VaultPayload,
  key: Uint8Array,
  enrollment: PasskeyEnrollment,
): PasskeyVaultRecord {
  validatePasskeyEnrollment(enrollment);
  const cacheKey = payload.cacheKey || bytesToBase64(randomBytes(32));
  const { iv, ciphertext } = encrypt(key, JSON.stringify({ ...payload, cacheKey }));
  const record: PasskeyVaultRecord = {
    version: PASSKEY_VAULT_VERSION,
    protection: 'passkey',
    rpId: enrollment.rpId,
    passkeys: enrollment.passkeys.map((p) => ({ ...p })),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
  validatePasskeyRecord(record);
  return record;
}

/** Create an independent random vault key protected by a single enrolled passkey. */
export function createPasskeyRecord(
  payload: VaultPayload,
  input: PasskeyInput,
): PasskeyVaultRecord {
  const key = randomBytes(32);
  try {
    return sealPasskeyPayload(payload, key, {
      rpId: input.rpId ?? PASSKEY_RP_ID,
      passkeys: [wrapVaultKey(key, { ...input, rpId: input.rpId ?? PASSKEY_RP_ID })],
    });
  } finally {
    key.fill(0);
  }
}

/** Open a record or parsed recovery file. Persist a re-seal if cacheKeyMinted is true. */
export async function openPasskeyRecord(
  record: PasskeyVaultRecord,
  proof: PasskeyProof,
): Promise<OpenedRecord> {
  return withPasskeyVaultKey(record, proof, (key) => {
    const parsed = JSON.parse(
      decrypt(key, base64ToBytes(record.iv), base64ToBytes(record.ciphertext)),
    ) as VaultPayload;
    if (
      !parsed ||
      !Array.isArray(parsed.accounts) ||
      !(
        parsed.activeAccountId === null ||
        (typeof parsed.activeAccountId === 'string' &&
          parsed.accounts.some((a) => a?.id === parsed.activeAccountId))
      ) ||
      (parsed.cacheKey !== undefined && !validBase64(parsed.cacheKey, 32))
    )
      throw new Error('Invalid vault payload');
    const cacheKeyMinted = !parsed.cacheKey;
    return {
      payload: {
        accounts: parsed.accounts,
        activeAccountId: parsed.activeAccountId,
        cacheKey: parsed.cacheKey || bytesToBase64(randomBytes(32)),
      },
      cacheKeyMinted,
    };
  });
}
