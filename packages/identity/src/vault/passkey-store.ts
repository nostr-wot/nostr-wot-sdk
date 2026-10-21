/**
 * Stored mode for tagged passkeys (`npk1`): a private key, a seed or a seed with accounts,
 * encrypted under the PRF output and bound to its type, RP, author and credential. Legacy stored
 * passkeys (32-byte handles) keep their formats in recovery.ts; nothing here reads or writes them.
 *
 * record = "NPK" | 0x01 | type | iv(12) | hkdf_salt(32) | AES-256-GCM(key, iv, plaintext, aad)
 * aad    = "NPK" | 0x01 | type | len(rp_id)(1) | rp_id | author(32) | len(credential)(2, BE) | credential
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { base64urlnopad } from '@scure/base';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { derivePath, isValidPrivateKey, mnemonicToSeed, normalizeDerivationPath, publicKeyFromPrivate, NIP06_PATH } from '../accounts/derivation.js';
import { base64ToBytes, bytesToBase64, hexToBytes } from './serialization.js';
import { validPasskeyRpId } from './passkey.js';
import {
  canonicalCredential, mismatchedTag, publishAll, queryNewest, relayList, signUnchanged, validEventShape, verifiedPlain, RECOVERY_EVENT_KIND,
  type RecoveryEvent, type RecoveryEventTemplate, type RecoveryPorts, type RecoveryVerifier,
} from './recovery.js';

const LABEL = 'nostr-passkey:store:v1';
const VERSION_TAG = 'npk1';
export const STORED_MAX_PLAINTEXT_BYTES = 65536;
const TYPES = { key: 0x01, seed: 0x02, vault: 0x03 } as const;
type StoredPayloadType = keyof typeof TYPES;
const HEADER = [0x4e, 0x50, 0x4b, 0x01] as const;
const HEADER_BYTES = 5 + 12 + 32;
const TAG_BYTES = 16;
const MAX_RECORD_BYTES = HEADER_BYTES + STORED_MAX_PLAINTEXT_BYTES + TAG_BYTES;
const SEED_PATH_PREFIX = "m/44'/1237'/";

/** Public PRF input for tagged stored passkeys: SHA-256 of the stored label. */
export function storedPrfInput(): Uint8Array {
  return sha256(new TextEncoder().encode(LABEL));
}

/** `credentialId` is canonical standard base64, as elsewhere in this package. */
export interface StoredRecordContext { credentialId: string; rpId: string; author: string; }
function credential(context: StoredRecordContext): Uint8Array {
  if (!context || !validPasskeyRpId(context.rpId) || typeof context.author !== 'string' || !/^[a-f0-9]{64}$/.test(context.author)) throw new Error('Invalid stored record context');
  return canonicalCredential(context.credentialId);
}
/** Does this byte string start like a record of this format? Says nothing about validity. */
export function isStoredRecord(bytes: Uint8Array): boolean {
  return bytes instanceof Uint8Array && bytes.length > HEADER.length && HEADER.every((byte, i) => bytes[i] === byte);
}
export function storedRecordAad(type: StoredPayloadType, context: StoredRecordContext): Uint8Array {
  const id = credential(context);
  const rp = new TextEncoder().encode(context.rpId);
  const aad = new Uint8Array(5 + 1 + rp.length + 32 + 2 + id.length);
  let at = 0;
  aad.set(HEADER, at); at += 4; aad[at++] = TYPES[type];
  aad[at++] = rp.length; aad.set(rp, at); at += rp.length;
  aad.set(hexToBytes(context.author), at); at += 32;
  aad[at++] = id.length >> 8; aad[at++] = id.length & 0xff; aad.set(id, at);
  return aad;
}
function recordKey(prf: Uint8Array, salt: Uint8Array): Uint8Array {
  if (!(prf instanceof Uint8Array) || prf.length !== 32) throw new Error('PRF output must be 32 bytes');
  return hkdf(sha256, prf, salt, new TextEncoder().encode(LABEL), 32);
}
/** The record's own authenticated type byte, never a guess from its length. */
function recordType(record: Uint8Array): StoredPayloadType {
  const type = isStoredRecord(record) ? (Object.keys(TYPES) as StoredPayloadType[]).find(name => TYPES[name] === record[4]) : undefined;
  if (!type || record.length <= HEADER_BYTES + TAG_BYTES || record.length > MAX_RECORD_BYTES || (type === 'key' && record.length !== HEADER_BYTES + 32 + TAG_BYTES)) throw new Error('Invalid stored record');
  return type;
}
/** Seal plaintext with a chosen salt and IV. Exported for vector tests; reusing an IV breaks AES-GCM. */
export function sealStoredRecord(plaintext: Uint8Array, prf: Uint8Array, type: StoredPayloadType, context: StoredRecordContext, salt = randomBytes(32), iv = randomBytes(12)): Uint8Array {
  const aad = storedRecordAad(type, context);
  if (!(plaintext instanceof Uint8Array) || !plaintext.length || plaintext.length > STORED_MAX_PLAINTEXT_BYTES || (type === 'key' && plaintext.length !== 32)) throw new Error('Invalid stored payload size');
  if (salt.length !== 32 || iv.length !== 12) throw new Error('Invalid stored record nonce');
  const key = recordKey(prf, salt);
  try {
    const ciphertext = gcm(key, iv, aad).encrypt(plaintext);
    const record = new Uint8Array(HEADER_BYTES + ciphertext.length);
    record.set(HEADER); record[4] = TYPES[type]; record.set(iv, 5); record.set(salt, 17); record.set(ciphertext, HEADER_BYTES);
    return record;
  } finally { key.fill(0); }
}

/** Unknown fields are kept, so a value decoded and encoded again round trips them. */
export interface StoredSeed { entropy: string; passphrase?: string; [field: string]: unknown; }
export type StoredVaultAccount =
  /** `path` is the full BIP-32 path, `'` for hardened levels, under `m/44'/1237'/`. Derived exactly, never inferred. */
  | { kind: 'derived'; path: string; label?: string; default?: boolean; [field: string]: unknown }
  | { kind: 'key'; secret: string; label?: string; default?: boolean; [field: string]: unknown }
  /** A kind this package does not know: skipped on import, kept unchanged on rewrite. */
  | { kind: string; label?: string; default?: boolean; [field: string]: unknown };
export interface StoredVault {
  seed?: StoredSeed;
  accounts: StoredVaultAccount[];
  /** Application data by reverse-DNS namespace. Keep namespaces you do not know unchanged. */
  ext?: Record<string, unknown>;
  [field: string]: unknown;
}
export type StoredPayload =
  | { type: 'key'; key: Uint8Array }
  | { type: 'seed'; seed: StoredSeed }
  | { type: 'vault'; vault: StoredVault };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const REVERSE_DNS = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const validHexKey = (hex: unknown) => typeof hex === 'string' && /^[a-f0-9]{64}$/.test(hex) && (() => { const key = hexToBytes(hex); try { return isValidPrivateKey(key); } finally { key.fill(0); } })();
function validSeedPath(path: unknown): path is string {
  return typeof path === 'string' && normalizeDerivationPath(path) === path && path.startsWith(SEED_PATH_PREFIX) && path.length > SEED_PATH_PREFIX.length;
}
function validSeed(seed: unknown): seed is StoredSeed {
  // BIP-39 entropy is 16 to 32 bytes in steps of 4.
  return isObject(seed) && typeof seed.entropy === 'string' && /^(?:[a-f0-9]{8}){4,8}$/.test(seed.entropy) && (seed.passphrase === undefined || typeof seed.passphrase === 'string');
}
function validVault(vault: unknown): vault is StoredVault {
  if (!isObject(vault) || (vault.seed !== undefined && !validSeed(vault.seed)) || !Array.isArray(vault.accounts) || !vault.accounts.length) return false;
  if (vault.ext !== undefined && (!isObject(vault.ext) || Object.keys(vault.ext).some(namespace => !REVERSE_DNS.test(namespace)))) return false;
  if (vault.accounts.filter(account => isObject(account) && account.default === true).length > 1) return false;
  return vault.accounts.every(account => isObject(account) && typeof account.kind === 'string'
    && (account.label === undefined || typeof account.label === 'string') && (account.default === undefined || typeof account.default === 'boolean')
    && (account.kind === 'derived' ? vault.seed !== undefined && validSeedPath(account.path) : account.kind !== 'key' || validHexKey(account.secret)));
}
function encodePayload(payload: StoredPayload): Uint8Array {
  let bytes: Uint8Array;
  if (payload?.type === 'key' && isValidPrivateKey(payload.key)) bytes = Uint8Array.from(payload.key);
  else if (payload?.type === 'seed' && validSeed(payload.seed)) bytes = new TextEncoder().encode(JSON.stringify(payload.seed));
  else if (payload?.type === 'vault' && validVault(payload.vault)) bytes = new TextEncoder().encode(JSON.stringify(payload.vault));
  else throw new Error('Invalid stored payload');
  if (bytes.length > STORED_MAX_PLAINTEXT_BYTES) { bytes.fill(0); throw new Error('Stored payload exceeds size limit'); }
  return bytes;
}
function decodePayload(type: StoredPayloadType, plaintext: Uint8Array): StoredPayload {
  if (type === 'key') {
    if (!isValidPrivateKey(plaintext)) throw new Error('Invalid stored payload');
    return { type, key: Uint8Array.from(plaintext) };
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)); } catch { throw new Error('Invalid stored payload'); }
  if (type === 'seed' && validSeed(value)) return { type, seed: value };
  if (type === 'vault' && validVault(value)) return { type, vault: value };
  throw new Error('Invalid stored payload');
}

/** Key at exactly `path` of a stored seed: the English mnemonic of its entropy, with its passphrase. Caller zeroes it. */
export function storedSeedKey(seed: StoredSeed, path: string = NIP06_PATH): Uint8Array {
  if (!validSeed(seed)) throw new Error('Invalid stored seed');
  if (!validSeedPath(path)) throw new Error('Invalid stored seed path');
  const entropy = hexToBytes(seed.entropy);
  try {
    const bip39 = mnemonicToSeed(entropyToMnemonic(entropy, wordlist), seed.passphrase ?? '');
    try { return derivePath(bip39, path); } finally { bip39.fill(0); }
  } finally { entropy.fill(0); }
}

/** One importable identity of a payload. */
export interface StoredKey { pubkey: string; secret: Uint8Array; label?: string; default: boolean; }
/**
 * The payload's importable identities, in order: the key, the seed's main account, or each vault
 * account of a known kind (others are skipped). Use a single one directly; for several, let the
 * user choose with the `default` one preselected. Caller zeroes every `secret`.
 */
export function storedPayloadKeys(payload: StoredPayload): StoredKey[] {
  const entry = (secret: Uint8Array, account?: StoredVaultAccount): StoredKey => ({ pubkey: publicKeyFromPrivate(secret), secret, ...(account?.label !== undefined ? { label: account.label } : {}), default: account?.default === true });
  if (payload.type === 'key') return [entry(Uint8Array.from(payload.key))];
  // A seed promises only its main account; other accounts may live under either layout.
  if (payload.type === 'seed') return [entry(storedSeedKey(payload.seed, NIP06_PATH))];
  const keys: StoredKey[] = [];
  try {
    for (const account of payload.vault.accounts) {
      if (account.kind === 'key') keys.push(entry(hexToBytes(account.secret as string), account));
      else if (account.kind === 'derived') keys.push(entry(storedSeedKey(payload.vault.seed!, account.path as string), account));
    }
    return keys;
  } catch (error) { for (const key of keys) key.secret.fill(0); throw error; }
}
function hasAuthor(payload: StoredPayload, author: string): boolean {
  const keys = storedPayloadKeys(payload);
  try { return keys.some(key => key.pubkey === author); } finally { for (const key of keys) key.secret.fill(0); }
}

/**
 * Encrypt a payload for a passkey with a fresh salt and IV. The author must be one of the payload's
 * keys. Caller-owned payload and PRF buffers are left alone. The result is also a valid file backup.
 */
export function encryptStoredRecord(payload: StoredPayload, prf: Uint8Array, context: StoredRecordContext): Uint8Array {
  credential(context);
  const plaintext = encodePayload(payload);
  try {
    if (!hasAuthor(payload, context.author)) throw new Error('Author is not one of the stored keys');
    return sealStoredRecord(plaintext, prf, payload.type, context);
  } finally { plaintext.fill(0); }
}
/**
 * Decrypt, decode and check the author before returning anything. The caller zeroes a `key`
 * payload. Throws on any failure; `Author is not one of the stored keys` on a mismatch.
 */
export function openStoredRecord(record: Uint8Array, prf: Uint8Array, context: StoredRecordContext): StoredPayload {
  const type = recordType(record);
  const aad = storedRecordAad(type, context);
  const key = recordKey(prf, record.subarray(17, 49));
  let plaintext: Uint8Array;
  try { plaintext = gcm(key, record.subarray(5, 17), aad).decrypt(record.subarray(HEADER_BYTES)); } finally { key.fill(0); }
  try {
    const payload = decodePayload(type, plaintext);
    if (!hasAuthor(payload, context.author)) {
      if (payload.type === 'key') payload.key.fill(0);
      throw new Error('Author is not one of the stored keys');
    }
    return payload;
  } finally { plaintext.fill(0); }
}

function tags(type: StoredPayloadType, context: StoredRecordContext): string[][] {
  const id = base64urlnopad.encode(credential(context));
  return [['d', `${id}:${type}`], ['credential', id], ['v', VERSION_TAG], ['rp', context.rpId], ['type', type]];
}
export function buildStoredRecordEvent(record: Uint8Array, context: StoredRecordContext, createdAt: number): RecoveryEventTemplate {
  const type = recordType(record);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('Invalid stored record timestamp');
  return { kind: RECOVERY_EVENT_KIND, pubkey: context.author, created_at: createdAt, content: bytesToBase64(record), tags: tags(type, context) };
}
/** Validate an event for this credential and author and return its record bytes. */
export async function validateStoredRecordEvent(event: RecoveryEvent, context: StoredRecordContext, verify: RecoveryVerifier): Promise<Uint8Array> {
  credential(context);
  if (!validEventShape(event, context.author) || typeof event.content !== 'string' || event.content.length > 4 * Math.ceil(MAX_RECORD_BYTES / 3)) throw new Error('Invalid stored record event');
  const record = base64ToBytes(event.content);
  if (bytesToBase64(record) !== event.content) throw new Error('Invalid stored record event');
  const tag = mismatchedTag(event, tags(recordType(record), context));
  if (tag) throw new Error(`Invalid stored record ${tag}`);
  if (!await verifiedPlain(event, verify)) throw new Error('Invalid stored record signature');
  return record;
}

/**
 * Save a payload under a tagged stored passkey. A blob write that is refused or unconfirmed rejects
 * and never falls through to relays; relays need explicit consent and at least one acknowledgement.
 * Pass `prf` from registration to skip a prompt; it stays caller-owned.
 */
export async function saveStoredRecord(options: RecoveryPorts & { payload: StoredPayload; context: StoredRecordContext; largeBlobSupported: boolean; allowRelay?: boolean; prf?: Uint8Array; sign: (event: RecoveryEventTemplate) => Promise<RecoveryEvent>; verify: RecoveryVerifier }): Promise<{ destination: 'passkey' | 'relays'; record: Uint8Array; event?: RecoveryEvent; acceptedRelays: string[] }> {
  credential(options.context);
  if (!options.largeBlobSupported && !options.allowRelay) throw new Error('Relay storage requires explicit consent');
  if (!options.largeBlobSupported) relayList(options.relays);
  const plaintext = encodePayload(options.payload);
  let material: Uint8Array | undefined;
  try {
    // Checked before the prompt, so a wrong author never asks the user for anything.
    if (!hasAuthor(options.payload, options.context.author)) throw new Error('Author is not one of the stored keys');
    material = options.prf ?? await options.provider.authenticate({ credentialId: options.context.credentialId, rpId: options.context.rpId, prfInput: storedPrfInput() });
    options.assertSession?.();
    const record = sealStoredRecord(plaintext, material, options.payload.type, options.context);
    if (options.largeBlobSupported) {
      if (!await options.provider.writeBlob(options.context.credentialId, record, options.context.rpId)) throw new Error('Passkey storage was not confirmed');
      options.assertSession?.();
      return { destination: 'passkey', record, acceptedRelays: [] };
    }
    const event = await signUnchanged(options.sign, buildStoredRecordEvent(record, options.context, Math.floor(Date.now() / 1000)));
    await validateStoredRecordEvent(event, options.context, options.verify);
    options.assertSession?.();
    const acceptedRelays = await publishAll(options, event);
    if (!acceptedRelays.length) throw new Error('Stored record could not be saved on any relay');
    return { destination: 'relays', record, event, acceptedRelays };
  } finally {
    plaintext.fill(0);
    if (!options.prf) material?.fill(0);
  }
}

export interface StoredRecordCandidate { record: Uint8Array; author: string; source: 'passkey' | 'relays'; event?: RecoveryEvent; }
/**
 * Candidates for a credential: a raw record in the blob first, then relay events, by author when the
 * handle names one and by `#credential` otherwise, each author's newest valid event. A blob record has
 * no author of its own, so it is only usable when the handle supplies one.
 */
export async function findStoredRecords(ports: Pick<RecoveryPorts, 'transport' | 'relays' | 'timeoutMs'>, lookup: { credentialId: string; rpId: string; author?: string; blob?: Uint8Array; verify: RecoveryVerifier }): Promise<StoredRecordCandidate[]> {
  const id = base64urlnopad.encode(canonicalCredential(lookup.credentialId));
  if (lookup.author && lookup.blob && isStoredRecord(lookup.blob)) {
    try { recordType(lookup.blob); return [{ record: lookup.blob, author: lookup.author, source: 'passkey' }]; }
    catch { /* An unusable blob does not hide a relay record. */ }
  }
  if (!ports.relays?.length) return [];
  const filter = lookup.author ? { kinds: [RECOVERY_EVENT_KIND], authors: [lookup.author], limit: 32 } : { kinds: [RECOVERY_EVENT_KIND], '#credential': [id], limit: 32 };
  const found = await queryNewest(ports, [filter], async event => {
    if (event?.tags?.find(tag => tag[0] === 'v')?.[1] !== VERSION_TAG) throw new Error('Not an npk1 record');
    return validateStoredRecordEvent(event, { credentialId: lookup.credentialId, rpId: lookup.rpId, author: lookup.author ?? event.pubkey }, lookup.verify);
  });
  return found.map(({ event, value }) => ({ record: value, author: event.pubkey, source: 'relays', event }));
}

/**
 * Open the newest candidate. With a known author only the newest is tried, so a newer authenticated
 * record that fails is never rolled back to an older one; without one, each author's newest is tried,
 * so a stranger's record cannot shadow the real one. Returns null when nothing decrypts; throws
 * `Author is not one of the stored keys` on a mismatch.
 */
export function openStoredRecords(candidates: StoredRecordCandidate[], prf: Uint8Array, lookup: { credentialId: string; rpId: string; author?: string }): { payload: StoredPayload; author: string; source: 'passkey' | 'relays'; event?: RecoveryEvent } | null {
  for (const candidate of lookup.author ? candidates.slice(0, 1) : candidates) {
    try {
      const payload = openStoredRecord(candidate.record, prf, { credentialId: lookup.credentialId, rpId: lookup.rpId, author: candidate.author });
      return { payload, author: candidate.author, source: candidate.source, event: candidate.event };
    } catch (error) {
      if (error instanceof Error && error.message === 'Author is not one of the stored keys') throw error;
    }
  }
  return null;
}
