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
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { isValidPrivateKey, mnemonicToSeed, normalizeDerivationPath, publicKeyFromPrivate, NIP06_PATH } from '../accounts/derivation.js';
import { base64ToBytes, bytesToBase64, hexToBytes } from './serialization.js';
import { validPasskeyRpId } from './passkey.js';
import {
  canonicalCredential, mismatchedTag, publishAll, queryNewest, relayList, signUnchanged, validEventShape, verifiedPlain, RECOVERY_EVENT_KIND,
  type RecoveryEvent, type RecoveryEventTemplate, type RecoveryPorts, type RecoveryVerifier,
} from './recovery.js';

const LABEL = 'nostr-passkey:store:v1';
const VERSION_TAG = 'npk1';
/** Provisional new kind; 31777 remains readable for existing credentials. */
export const STORED_RECOVERY_EVENT_KIND = 31778;
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
  if (!context || !(context.rpId === 'localhost' || validPasskeyRpId(context.rpId)) || typeof context.author !== 'string' || !/^[a-f0-9]{64}$/.test(context.author)) throw new Error('Invalid stored record context');
  return canonicalCredential(context.credentialId);
}
/** Does this byte string start like a record of this format? Says nothing about validity. */
export function isStoredRecord(bytes: Uint8Array): boolean {
  return bytes instanceof Uint8Array && bytes.length >= HEADER.length && HEADER.every((byte, i) => bytes[i] === byte);
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
  /** Authenticated content timestamp; missing means zero. */
  updated_at?: number;
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
const validHexKey = (hex: unknown) => typeof hex === 'string' && /^[a-f0-9]{64}$/.test(hex) && (() => { const key = hexToBytes(hex); try { return isValidPrivateKey(key); } finally { key.fill(0); } })();
function validSeedPath(path: unknown): path is string {
  return typeof path === 'string' && normalizeDerivationPath(path) === path && path.startsWith(SEED_PATH_PREFIX) && path.length > SEED_PATH_PREFIX.length && path.split('/').length <= 256;
}
function validSeed(seed: unknown): seed is StoredSeed {
  // BIP-39 entropy is 16 to 32 bytes in steps of 4.
  return isObject(seed) && typeof seed.entropy === 'string' && /^(?:[a-f0-9]{8}){4,8}$/.test(seed.entropy) && (seed.passphrase === undefined || typeof seed.passphrase === 'string');
}
function validVault(vault: unknown): vault is StoredVault {
  if (!isObject(vault) || (vault.seed !== undefined && !validSeed(vault.seed)) || !Array.isArray(vault.accounts) || !vault.accounts.length) return false;
  if (vault.ext !== undefined && !isObject(vault.ext)) return false;
  return vault.updated_at === undefined || typeof vault.updated_at === 'number' && Number.isSafeInteger(vault.updated_at) && vault.updated_at >= 0;
}
function usableAccount(account: unknown, vault: StoredVault): account is StoredVaultAccount {
  return isObject(account) && (account.label === undefined || typeof account.label === 'string')
    && (account.default === undefined || typeof account.default === 'boolean')
    && (account.kind === 'key' ? validHexKey(account.secret) : account.kind === 'derived' && vault.seed !== undefined && validSeedPath(account.path));
}
/** Parse JSON without losing duplicate names or the lexical form of updated_at. */
function strictJson(text: string): unknown {
  // JSON.parse validates the grammar; the walk retains the source tokens it normally discards.
  const result: unknown = JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/gs)!;
  let at = 0;
  const string = (token: string): string => {
    const value: string = JSON.parse(token);
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Unpaired surrogate'); }
      else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error('Unpaired surrogate');
    }
    return value;
  };
  const walk = (root = false): void => {
    const token = tokens[at++];
    if (token === '{') {
      const names = new Set<string>();
      while (tokens[at] !== '}') {
        const name = string(tokens[at++]);
        if (names.has(name)) throw new Error('Duplicate member');
        names.add(name); at++;
        if (root && name === 'updated_at' && !/^(?:0|[1-9]\d*)$/.test(tokens[at])) throw new Error('Invalid updated_at');
        walk();
        if (tokens[at] !== ',') break;
        at++;
      }
      at++;
    } else if (token === '[') {
      while (tokens[at] !== ']') { walk(); if (tokens[at] !== ',') break; at++; }
      at++;
    } else if (token.startsWith('"')) string(token);
  };
  walk(true);
  return result;
}

/** Legacy seed callers now write the companion vault representation. */
function writablePayload(payload: StoredPayload): StoredPayload {
  return payload.type === 'seed' ? { type: 'vault', vault: { seed: payload.seed, accounts: [{ kind: 'derived', path: NIP06_PATH }] } } : payload;
}
function encodePayload(payload: StoredPayload): Uint8Array {
  let bytes: Uint8Array;
  if (payload?.type === 'key' && isValidPrivateKey(payload.key)) bytes = Uint8Array.from(payload.key);
  else if (payload?.type === 'seed' && validSeed(payload.seed)) bytes = new TextEncoder().encode(JSON.stringify(payload.seed));
  else if (payload?.type === 'vault' && validVault(payload.vault)) bytes = new TextEncoder().encode(JSON.stringify(payload.vault));
  else throw new Error('Invalid stored payload');
  if (payload.type !== 'key') strictJson(new TextDecoder().decode(bytes));
  if (bytes.length > STORED_MAX_PLAINTEXT_BYTES) { bytes.fill(0); throw new Error('Stored payload exceeds size limit'); }
  return bytes;
}
function decodePayload(type: StoredPayloadType, plaintext: Uint8Array): StoredPayload {
  if (type === 'key') {
    if (!isValidPrivateKey(plaintext)) throw new Error('Invalid stored payload');
    return { type, key: Uint8Array.from(plaintext) };
  }
  let value: unknown;
  try { value = strictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext)); } catch { throw new Error('Invalid stored payload'); }
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
    let node: HDKey | undefined;
    try {
      node = HDKey.fromMasterSeed(bip39);
      for (const level of path.split('/').slice(1)) {
        const index = Number(level.replace("'", '')) + (level.endsWith("'") ? 0x80000000 : 0);
        const child: HDKey = node!.deriveChild(index);
        node!.wipePrivateData(); node = child;
        if (child.index !== index) throw new Error('Invalid BIP-32 child at requested index');
      }
      if (!node!.privateKey) throw new Error('Invalid BIP-32 private key');
      return Uint8Array.from(node!.privateKey!);
    } finally { node?.wipePrivateData(); bip39.fill(0); }
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
      if (!usableAccount(account, payload.vault)) continue;
      try {
      if (account.kind === 'key') keys.push(entry(hexToBytes(account.secret as string), account));
      else if (account.kind === 'derived') keys.push(entry(storedSeedKey(payload.vault.seed!, account.path as string), account));
      } catch { /* An invalid BIP-32 result skips this account without advancing its index. */ }
    }
    const selected = keys.findIndex(key => key.default);
    keys.forEach((key, index) => { key.default = index === (selected < 0 ? 0 : selected); });
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
  payload = writablePayload(payload);
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

function tags(type: StoredPayloadType, context: StoredRecordContext, legacy = false): string[][] {
  const id = base64urlnopad.encode(credential(context));
  return legacy ? [['d', `${id}:${type}`], ['credential', id], ['v', VERSION_TAG], ['rp', context.rpId], ['type', type]] : [['d', `${id}:${type}`], ['rp', context.rpId]];
}
export function buildStoredRecordEvent(record: Uint8Array, context: StoredRecordContext, createdAt: number): RecoveryEventTemplate {
  const type = recordType(record);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('Invalid stored record timestamp');
  if (type === 'seed') throw new Error('New seed records must use a vault');
  return { kind: STORED_RECOVERY_EVENT_KIND, pubkey: context.author, created_at: createdAt, content: bytesToBase64(record), tags: tags(type, context) };
}
/** Validate an event for this credential and author and return its record bytes. */
export async function validateStoredRecordEvent(event: RecoveryEvent, context: StoredRecordContext, verify: RecoveryVerifier): Promise<Uint8Array> {
  credential(context);
  const legacy = event.kind === RECOVERY_EVENT_KIND;
  const type = event.tags?.find(tag => tag[0] === 'd')?.[1]?.split(':')[1] as StoredPayloadType;
  await eligibleEvent(event, context, type, verify);
  if (typeof event.content !== 'string' || event.content.length > 4 * Math.ceil(MAX_RECORD_BYTES / 3)) throw new Error('Invalid stored record event');
  const record = base64ToBytes(event.content);
  if (bytesToBase64(record) !== event.content || recordType(record) !== type || !legacy && type === 'seed') throw new Error('Invalid stored record event');
  return record;
}

/** Public eligibility precedes record decoding so a broken latest vault cannot expose an older one. */
async function eligibleEvent(event: RecoveryEvent, context: StoredRecordContext, type: StoredPayloadType, verify: RecoveryVerifier): Promise<void> {
  const shapeValid = event.kind === RECOVERY_EVENT_KIND ? validEventShape(event, context.author) : !!event && event.pubkey === context.author && Number.isSafeInteger(event.created_at) && event.created_at >= 0 && Array.isArray(event.tags) && event.tags.every(tag => Array.isArray(tag) && tag.every(value => typeof value === 'string')) && /^[a-f0-9]{64}$/.test(event.id) && /^[a-f0-9]{128}$/.test(event.sig);
  if (!shapeValid || ![RECOVERY_EVENT_KIND, STORED_RECOVERY_EVENT_KIND].includes(event.kind) || !['key', 'seed', 'vault'].includes(type)) throw new Error('Invalid stored record event');
  const legacy = event.kind === RECOVERY_EVENT_KIND;
  if (!legacy && (type === 'seed' || event.tags.some(tag => tag[0] === 'v'))) throw new Error('Invalid stored record version');
  const expected = legacy ? tags(type, context, true) : tags(type, context).filter(tag => tag[0] === 'd' || event.tags.some(actual => actual[0] === 'rp'));
  const tag = mismatchedTag(event, expected);
  if (tag) throw new Error(`Invalid stored record ${tag}`);
  if (!await verifiedPlain(event, verify)) throw new Error('Invalid stored record signature');
}

/**
 * Save a payload under a tagged stored passkey. A blob write that is refused or unconfirmed rejects
 * and never falls through to relays; relays need explicit consent and at least one acknowledgement.
 * Pass `prf` from registration to skip a prompt; it stays caller-owned.
 */
export async function saveStoredRecord(options: RecoveryPorts & { payload: StoredPayload; context: StoredRecordContext; largeBlobSupported: boolean; allowRelay?: boolean; prf?: Uint8Array; confirmOverwrite?: (existing: StoredPayload | null) => Promise<boolean>; sign: (event: RecoveryEventTemplate) => Promise<RecoveryEvent>; verify: RecoveryVerifier }): Promise<{ destination: 'passkey' | 'relays'; record: Uint8Array; event?: RecoveryEvent; acceptedRelays: string[] }> {
  credential(options.context);
  if (!options.largeBlobSupported && !options.allowRelay) throw new Error('Relay storage requires explicit consent');
  if (!options.largeBlobSupported) relayList(options.relays);
  const payload = writablePayload(options.payload);
  const plaintext = encodePayload(payload);
  let material: Uint8Array | undefined;
  try {
    // Checked before the prompt, so a wrong author never asks the user for anything.
    if (!hasAuthor(options.payload, options.context.author)) throw new Error('Author is not one of the stored keys');
    material = options.prf ?? await options.provider.authenticate({ credentialId: options.context.credentialId, rpId: options.context.rpId, prfInput: storedPrfInput() });
    options.assertSession?.();
    const record = sealStoredRecord(plaintext, material, payload.type, options.context);
    if (options.largeBlobSupported) {
      // A provider must positively report the existing bytes, including an empty blob.
      // Missing read support is not proof that storage is empty.
      if (!options.provider.assert) throw new Error('Cannot inspect existing passkey storage');
      const inspected = await options.provider.assert({ credentialId: options.context.credentialId, rpId: options.context.rpId, largeBlob: true });
      options.assertSession?.();
      if (inspected.credentialId !== options.context.credentialId || !(inspected.blob instanceof Uint8Array)) throw new Error('Cannot inspect existing passkey storage');
      if (inspected.blob.length) {
        let existing: StoredPayload | null = null;
        try { existing = openStoredRecord(inspected.blob, material, options.context); } catch { /* Unknown data requires explicit consent too. */ }
        try {
          if (!options.confirmOverwrite || !await options.confirmOverwrite(existing)) throw new Error('Passkey overwrite requires explicit consent');
          options.assertSession?.();
        } finally { if (existing?.type === 'key') existing.key.fill(0); }
      }
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
 * Provider and relay candidates are both collected. Each type uses credential-specific d filters;
 * vaults keep only each author's newest eligible event before decoding. A provider record needs
 * the author supplied by the handle. Key records may fall back across eligible immutable copies.
 */
export async function findStoredRecords(ports: Pick<RecoveryPorts, 'transport' | 'relays' | 'timeoutMs'>, lookup: { credentialId: string; rpId: string; author?: string; blob?: Uint8Array; verify: RecoveryVerifier }): Promise<StoredRecordCandidate[]> {
  const id = base64urlnopad.encode(canonicalCredential(lookup.credentialId));
  const candidates: StoredRecordCandidate[] = [];
  if (lookup.author && lookup.blob && isStoredRecord(lookup.blob)) {
    candidates.push({ record: lookup.blob, author: lookup.author, source: 'passkey' });
  }
  if (!ports.relays?.length) return candidates;
  const groups = await Promise.all((['vault', 'key', 'seed'] as const).map(async type => {
    const filters = [RECOVERY_EVENT_KIND, ...(type === 'seed' ? [] : [STORED_RECOVERY_EVENT_KIND])].map(kind => ({ kinds: [kind], ...(lookup.author ? { authors: [lookup.author] } : {}), '#d': [`${id}:${type}`], limit: 32 }));
    const found = await queryNewest(ports, filters, async event => {
      const context = { credentialId: lookup.credentialId, rpId: lookup.rpId, author: lookup.author ?? event.pubkey };
      await eligibleEvent(event, context, type, lookup.verify);
      return context;
    }, type === 'key');
    return Promise.all(found.map(async ({ event, value }) => {
      let record: Uint8Array;
      try { record = await validateStoredRecordEvent(event, value, () => true); }
      catch { record = new Uint8Array(); }
      return { record, author: event.pubkey, source: 'relays' as const, event };
    }));
  }));
  candidates.push(...groups.flat());
  return candidates;
}

/**
 * Open provider and eligible relay candidates, preferring vaults and their authenticated updated_at.
 * Only the newest relay vault for an author is tried. A failed source is reported through onFailure;
 * a usable independent source may still recover. Keys are immutable and may use any opening copy.
 * Callers passing candidates directly must order relay candidates newest first (lowest ID on ties).
 */
export function openStoredRecords(candidates: StoredRecordCandidate[], prf: Uint8Array, lookup: { credentialId: string; rpId: string; author?: string; onFailure?: (failure: { source: 'passkey' | 'relays'; author: string; error: unknown }) => void }): { payload: StoredPayload; author: string; source: 'passkey' | 'relays'; event?: RecoveryEvent } | null {
  let best: ReturnType<typeof openStoredRecords> = null;
  let authorError: unknown;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (lookup.author && candidate.author !== lookup.author) continue;
    try {
      const type = candidate.event?.tags.find(tag => tag[0] === 'd')?.[1]?.split(':')[1] ?? recordType(candidate.record);
      const coordinate = `${candidate.author}:${type}`;
      if (candidate.source === 'relays' && type !== 'key' && seen.has(coordinate)) continue;
      if (candidate.source === 'relays') seen.add(coordinate);
      if (recordType(candidate.record) !== type) throw new Error('Invalid stored record type');
      const payload = openStoredRecord(candidate.record, prf, { credentialId: lookup.credentialId, rpId: lookup.rpId, author: candidate.author });
      const replace = !best || payload.type === 'vault' && (best.payload.type !== 'vault' || Number(payload.vault.updated_at ?? 0) > Number(best.payload.vault.updated_at ?? 0));
      if (replace) {
        if (best?.payload.type === 'key') best.payload.key.fill(0);
        best = { payload, author: candidate.author, source: candidate.source, event: candidate.event };
      } else if (payload.type === 'key') payload.key.fill(0);
    } catch (error) {
      lookup.onFailure?.({ source: candidate.source, author: candidate.author, error });
      if (error instanceof Error && error.message === 'Author is not one of the stored keys') authorError = error;
    }
  }
  if (!best && authorError) throw authorError;
  return best;
}
