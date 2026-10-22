/** Portable PRF recovery. Hosts own authenticator ceremonies, signing, relay leases and import policy. */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { base64url } from '@scure/base';
import { base64ToBytes, bytesToBase64, hexToBytes } from './serialization.js';
import { parsePasskeyBackup, validPasskeyRpId, PASSKEY_BACKUP_FORMAT, type PasskeyVaultRecord } from './passkey.js';
import { classifyPasskeyHandle } from './passkey-modes.js';

export const RECOVERY_EVENT_KIND = 31777;
export const RECOVERY_PAYLOAD_VERSION = 4;
export const RECOVERY_MAX_BYTES = 64 * 1024;
export const RECOVERY_MAX_BLOB_BYTES = 128 * 1024;
/** Legacy stored-mode PRF input, used as is. Tagged stored passkeys use `storedPrfInput()`. */
export const RECOVERY_PRF_INPUT = 'keytr-v1';
export const RECOVERY_SCHEMAS = Object.freeze({ seed: 'com.nostrwot.seed.v1', vault: 'com.nostrwot.vault.v1' } as const);
const HEADER_BYTES = 45;
const GCM_TAG_BYTES = 16;
const MAX_CONTENT_LENGTH = 4 * Math.ceil((RECOVERY_MAX_BYTES + HEADER_BYTES + GCM_TAG_BYTES) / 3);
export type RecoveryScope = 'private-key' | 'seed' | 'vault';
export interface RecoveryContext {
  /** Canonical standard base64, as used by vault enrollment records. */
  credentialId: string;
  rpId: string;
  /** Event author, also stored as raw bytes in the discoverable credential's user handle. */
  pubkey: string;
  scope: RecoveryScope;
  /** Required agreement between apps; defaults to RECOVERY_SCHEMAS for typed scopes. */
  schema?: string;
}
export interface RecoveryEventTemplate { kind: number; pubkey: string; created_at: number; content: string; tags: string[][]; }
export interface RecoveryEvent extends RecoveryEventTemplate { id: string; sig: string; }
export type RecoveryVerifier = (event: RecoveryEvent) => boolean | Promise<boolean>;

/** Canonical standard base64 credential ID, 1 to 1024 bytes. */
export function canonicalCredential(credentialId: unknown): Uint8Array {
  if (typeof credentialId !== 'string' || credentialId.length > 1368) throw new Error('Invalid recovery credential');
  const bytes = base64ToBytes(credentialId);
  if (!bytes.length || bytes.length > 1024 || bytesToBase64(bytes) !== credentialId) throw new Error('Invalid recovery credential');
  return bytes;
}
function credentialBytes(context: RecoveryContext): Uint8Array {
  if (!context || !validPasskeyRpId(context.rpId) || !/^[a-f0-9]{64}$/.test(context.pubkey) || !['private-key', 'seed', 'vault'].includes(context.scope) || typeof context.credentialId !== 'string' || context.credentialId.length > 1368) throw new Error('Invalid recovery context');
  const bytes = canonicalCredential(context.credentialId);
  if (context.scope !== 'private-key' && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(recoverySchema(context))) throw new Error('Invalid recovery schema');
  if (context.scope === 'private-key' && context.schema !== undefined) throw new Error('Single-key recovery has no schema tag');
  return bytes;
}
export function recoverySchema(context: RecoveryContext): string {
  return context.schema ?? (context.scope === 'private-key' ? '' : RECOVERY_SCHEMAS[context.scope]);
}
/** Preserve the reference implementation's padded base64url identifier encoding. */
export function recoveryCoordinate(context: RecoveryContext): string {
  const encoded = base64url.encode(credentialBytes(context));
  return context.scope === 'private-key' ? encoded : `${encoded}:${context.scope}:${recoverySchema(context)}`;
}
function binding(context: RecoveryContext): Uint8Array {
  const credential = credentialBytes(context);
  if (context.scope === 'private-key') return new Uint8Array([...new TextEncoder().encode('keytr'), 1, ...credential]);
  return new TextEncoder().encode(JSON.stringify(['keytr', RECOVERY_PAYLOAD_VERSION, context.scope, recoverySchema(context), context.rpId, context.pubkey, base64url.encode(credential)]));
}
function encryptionKey(prf: Uint8Array, salt: Uint8Array, context: RecoveryContext): Uint8Array {
  if (!(prf instanceof Uint8Array) || prf.length !== 32) throw new Error('PRF output must be 32 bytes');
  return hkdf(sha256, prf, salt, new TextEncoder().encode(context.scope === 'private-key' ? 'keytr nsec encryption v1' : 'keytr payload encryption v4'), 32);
}
function parseBlob(content: string, context: RecoveryContext): Uint8Array {
  if (typeof content !== 'string' || content.length > MAX_CONTENT_LENGTH) throw new Error('Recovery exceeds size limit');
  const bytes = base64ToBytes(content);
  const expectedVersion = context.scope === 'private-key' ? 1 : RECOVERY_PAYLOAD_VERSION;
  if (bytesToBase64(bytes) !== content || bytes.length <= HEADER_BYTES + GCM_TAG_BYTES || bytes.length > RECOVERY_MAX_BYTES + HEADER_BYTES + GCM_TAG_BYTES || bytes[0] !== expectedVersion || (context.scope === 'private-key' && bytes.length !== 93)) throw new Error('Invalid recovery size or version');
  return bytes;
}
/** Does not retain or clear caller-owned plaintext or PRF buffers. */
export function encryptRecoveryPayload(payload: Uint8Array, prf: Uint8Array, context: RecoveryContext): string {
  const aad = binding(context);
  if (!(payload instanceof Uint8Array) || !payload.length || payload.length > RECOVERY_MAX_BYTES || (context.scope === 'private-key' && payload.length !== 32)) throw new Error('Invalid recovery payload size');
  const iv = randomBytes(12); const salt = randomBytes(32); const key = encryptionKey(prf, salt, context);
  try {
    const ciphertext = gcm(key, iv, aad).encrypt(payload);
    const blob = new Uint8Array(HEADER_BYTES + ciphertext.length);
    blob[0] = context.scope === 'private-key' ? 1 : RECOVERY_PAYLOAD_VERSION;
    blob.set(iv, 1); blob.set(salt, 13); blob.set(ciphertext, HEADER_BYTES);
    return bytesToBase64(blob);
  } finally { key.fill(0); }
}
/** Caller owns the returned plaintext and must validate its schema and clear it after use. */
export function decryptRecoveryPayload(content: string, prf: Uint8Array, context: RecoveryContext): Uint8Array {
  const aad = binding(context); const blob = parseBlob(content, context);
  const key = encryptionKey(prf, blob.subarray(13, 45), context);
  try { return gcm(key, blob.subarray(1, 13), aad).decrypt(blob.subarray(45)); }
  finally { key.fill(0); }
}
function tags(context: RecoveryContext): string[][] {
  const credential = base64url.encode(credentialBytes(context));
  return [['d', recoveryCoordinate(context)], ['rp', context.rpId], ['algo', 'aes-256-gcm'], ['kdf', 'hkdf-sha256'], ['v', context.scope === 'private-key' ? '1' : String(RECOVERY_PAYLOAD_VERSION)], ...(context.scope === 'private-key' ? [] : [['credential', credential], ['type', context.scope], ['schema', recoverySchema(context)]])];
}
export function buildRecoveryEvent(context: RecoveryContext, content: string, createdAt: number): RecoveryEventTemplate {
  credentialBytes(context); parseBlob(content, context);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('Invalid recovery timestamp');
  return { kind: RECOVERY_EVENT_KIND, pubkey: context.pubkey, created_at: createdAt, content, tags: tags(context) };
}
export async function validateRecoveryEvent(event: RecoveryEvent, context: RecoveryContext, verify: RecoveryVerifier): Promise<void> {
  credentialBytes(context);
  if (!validEventShape(event, context.pubkey)) throw new Error('Invalid recovery event');
  const tag = mismatchedTag(event, tags(context));
  if (tag) throw new Error(`Invalid recovery ${tag}`);
  parseBlob(event.content, context);
  if (!await verifiedPlain(event, verify)) throw new Error('Invalid recovery signature');
}
/** NIP-01 shape of a kind 31777 event by `author`, with bounded tags. Content is checked by each format. */
export function validEventShape(event: RecoveryEvent, author: string): boolean {
  return !!event && event.kind === RECOVERY_EVENT_KIND && event.pubkey === author && Number.isSafeInteger(event.created_at) && event.created_at >= 0 && Array.isArray(event.tags) && event.tags.length <= 32 && !event.tags.some(tag => !Array.isArray(tag) || !tag.length || tag.length > 8 || tag.some(value => typeof value !== 'string' || value.length > 2048)) && /^[a-f0-9]{64}$/.test(event.id) && /^[a-f0-9]{128}$/.test(event.sig);
}
/** The name of the first expected tag that is missing, duplicated or different, if any. */
export function mismatchedTag(event: RecoveryEvent, expected: string[][]): string | undefined {
  return expected.find(want => { const found = event.tags.filter(tag => tag[0] === want[0]); return found.length !== 1 || JSON.stringify(found[0]) !== JSON.stringify(want); })?.[0];
}
/** Only plain NIP-01 fields reach the host verifier, never cached verification markers. */
export async function verifiedPlain(event: RecoveryEvent, verify: RecoveryVerifier): Promise<boolean> {
  return !!await verify({ id: event.id, sig: event.sig, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags.map(tag => [...tag]), content: event.content });
}
/** Detect explicit type tags, then validate signature/context before trusting the result. */
export function recoveryContextFromEvent(event: RecoveryEvent, discovery: { credentialId: string; rpId: string; pubkey: string }): RecoveryContext {
  if (!event || !Array.isArray(event.tags)) throw new Error('Invalid recovery event');
  const version = event.tags.filter(tag => tag[0] === 'v');
  if (version.length !== 1) throw new Error('Invalid recovery version');
  if (version[0][1] === '1') return { ...discovery, scope: 'private-key' };
  if (version[0][1] !== String(RECOVERY_PAYLOAD_VERSION)) throw new Error('Unsupported recovery version');
  const type = event.tags.filter(tag => tag[0] === 'type'); const schema = event.tags.filter(tag => tag[0] === 'schema');
  if (type.length !== 1 || schema.length !== 1 || !['seed', 'vault'].includes(type[0][1])) throw new Error('Invalid recovery type or schema');
  return { ...discovery, scope: type[0][1] as RecoveryScope, schema: schema[0][1] };
}

/** A semantic assertion request. PRF inputs are public; the outputs they produce are secret. */
export interface PasskeyAssertionRequest {
  rpId: string;
  /** Targeted assertion when set; discoverable (`allowCredentials: []`) otherwise. */
  credentialId?: string;
  /** Inputs for `prf.eval.first` and `second`. */
  prf?: { first: Uint8Array; second?: Uint8Array };
  /** Ask for `largeBlob: { read: true }`. */
  largeBlob?: boolean;
}
/** What a provider returns from an assertion. PRF outputs are secret; the SDK zeroes them after use. */
export interface PasskeyAssertionResult {
  /** Canonical standard base64. */
  credentialId: string;
  /** Raw `user.id` bytes. Preferred over `pubkey`, which can only carry a handle as hex. */
  userHandle?: Uint8Array;
  /** Older shape: the user handle as lowercase hex. */
  pubkey?: string;
  blob?: Uint8Array;
  /** Outputs for `prf.eval.first` / `second`, when the platform evaluated them. */
  prf?: { first?: Uint8Array; second?: Uint8Array };
}
/** Implemented by a browser/native adapter. PRF input is public; returned PRF bytes are secret. */
export interface RecoveryProvider {
  authenticate(options: { credentialId: string; rpId: string; prfInput: Uint8Array }): Promise<Uint8Array>;
  /**
   * Discoverable assertion. `restoreRecovery` sends only `rpId`; `resolvePasskeyIdentity` also asks
   * for both PRF inputs and a largeBlob read in one prompt.
   */
  discover(options: Omit<PasskeyAssertionRequest, 'credentialId'>): Promise<PasskeyAssertionResult>;
  /** Optional targeted assertion with up to two inputs and a blob read in one prompt. */
  assert?(options: PasskeyAssertionRequest & { credentialId: string }): Promise<PasskeyAssertionResult>;
  writeBlob(credentialId: string, blob: Uint8Array, rpId: string): Promise<boolean>;
}
/** Exactly one of `authors`, `#d` or `#credential` is set. */
export interface RecoveryFilter { kinds: number[]; authors?: string[]; '#d'?: string[]; '#credential'?: string[]; limit: number; }
export interface RecoveryTransport {
  publish(relay: string, event: RecoveryEvent, options: { signal: AbortSignal; assertSession?: () => void }): Promise<boolean>;
  query(relay: string, filter: RecoveryFilter, options: { signal: AbortSignal }): Promise<RecoveryEvent[]>;
}
export interface RecoveryPorts { provider: RecoveryProvider; transport: RecoveryTransport; relays: readonly string[]; assertSession?: () => void; timeoutMs?: number; }
const now = () => Math.floor(Date.now() / 1000);
export function relayList(relays: readonly string[]): string[] {
  if (!Array.isArray(relays) || !relays.length || relays.length > 16 || relays.some(relay => typeof relay !== 'string' || relay.length > 2048 || !/^wss:\/\/[^/@?#\s]+(?:\/[^#\s]*)?$/.test(relay))) throw new Error('Invalid recovery relays');
  return [...new Set(relays)];
}
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation(controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Recovery relay timed out')); }, Math.max(1, Math.min(30000, Number.isFinite(timeoutMs) ? timeoutMs : 10000))); })]);
  } finally { clearTimeout(timer); controller.abort(); }
}
/** Sign, and refuse a signer that changed anything but `id` and `sig`. */
export async function signUnchanged(sign: (event: RecoveryEventTemplate) => Promise<RecoveryEvent>, template: RecoveryEventTemplate): Promise<RecoveryEvent> {
  const event = await sign(template);
  if (JSON.stringify({ kind: event.kind, pubkey: event.pubkey, created_at: event.created_at, content: event.content, tags: event.tags }) !== JSON.stringify(template)) throw new Error('Signer changed the event');
  return event;
}
/** Publish to every relay concurrently; the relays that acknowledged. */
export async function publishAll(options: RecoveryPorts, event: RecoveryEvent): Promise<string[]> {
  const results = await Promise.all(relayList(options.relays).map(async relay => {
    try { options.assertSession?.(); return await bounded(signal => options.transport.publish(relay, event, { signal, assertSession: options.assertSession }), options.timeoutMs) ? relay : null; }
    catch { return null; }
  }));
  options.assertSession?.();
  return results.filter((relay): relay is string => relay !== null);
}
/**
 * Query every relay with every filter and keep each author's newest event that `check` accepts,
 * newest first. Invalid public events cannot choose a credential or override a valid record.
 */
export async function queryNewest<T>(ports: Pick<RecoveryPorts, 'transport' | 'relays' | 'timeoutMs'>, filters: RecoveryFilter[], check: (event: RecoveryEvent) => Promise<T>, keepAll = false): Promise<{ event: RecoveryEvent; value: T }[]> {
  const results = await Promise.all(relayList(ports.relays).flatMap(relay => filters.map(async filter => {
    try { return await bounded(signal => ports.transport.query(relay, filter, { signal }), ports.timeoutMs); }
    catch { return []; }
  })));
  const newest = new Map<string, { event: RecoveryEvent; value: T }>();
  for (const result of results) {
    if (!Array.isArray(result) || result.length > 32) continue;
    for (const event of result) {
      try {
        const value = await check(event);
        const coordinate = keepAll ? event.id : event.pubkey;
        const current = newest.get(coordinate)?.event;
        if (!current || event.created_at > current.created_at || event.created_at === current.created_at && event.id < current.id) newest.set(coordinate, { event, value });
      } catch { /* Skipped. */ }
    }
  }
  return [...newest.values()].sort((a, b) => b.event.created_at - a.event.created_at || a.event.id.localeCompare(b.event.id));
}
/** Write confirmation is required. Cancellation/refusal never silently falls through to relays. */
export async function saveRecovery(options: RecoveryPorts & { payload: Uint8Array; context: RecoveryContext; largeBlobSupported: boolean; allowRelay?: boolean; prf?: Uint8Array; sign: (event: RecoveryEventTemplate) => Promise<RecoveryEvent>; verify: RecoveryVerifier }): Promise<{ destination: 'passkey' | 'relays'; event: RecoveryEvent; acceptedRelays: string[] }> {
  credentialBytes(options.context);
  if (!options.largeBlobSupported && !options.allowRelay) throw new Error('Relay recovery requires explicit consent');
  if (!options.largeBlobSupported) relayList(options.relays);
  const material = options.prf ?? await options.provider.authenticate({ ...options.context, prfInput: new TextEncoder().encode(RECOVERY_PRF_INPUT) });
  try {
    options.assertSession?.();
    const event = await signUnchanged(options.sign, buildRecoveryEvent(options.context, encryptRecoveryPayload(options.payload, material, options.context), now()));
    await validateRecoveryEvent(event, options.context, options.verify);
    options.assertSession?.();
    if (options.largeBlobSupported) {
      const blob = new TextEncoder().encode(JSON.stringify({ format: 'nostr-wot-passkey-recovery', version: 1, event }));
      if (blob.length > RECOVERY_MAX_BLOB_BYTES) throw new Error('Recovery blob exceeds size limit');
      if (!await options.provider.writeBlob(options.context.credentialId, blob, options.context.rpId)) throw new Error('Passkey recovery storage was not confirmed');
      options.assertSession?.();
      return { destination: 'passkey', event, acceptedRelays: [] };
    }
    const acceptedRelays = await publishAll(options, event);
    if (!acceptedRelays.length) throw new Error('Recovery could not be saved on any relay');
    return { destination: 'relays', event, acceptedRelays };
  } finally { if (!options.prf) material.fill(0); }
}

/** The user handle an assertion returned, as raw bytes, or null when it carried none. */
export function assertionHandle(assertion: PasskeyAssertionResult | undefined): Uint8Array | null {
  if (assertion?.userHandle instanceof Uint8Array) return assertion.userHandle;
  if (typeof assertion?.pubkey === 'string' && assertion.pubkey.length <= 2048 && /^(?:[a-f0-9]{2})+$/.test(assertion.pubkey)) return hexToBytes(assertion.pubkey);
  return null;
}

type RecoveryBlob =
  | { kind: 'recovery'; event: RecoveryEvent }
  /** A whole encrypted vault record (`PASSKEY_BACKUP_FORMAT`), opened with `openPasskeyRecord`. */
  | { kind: 'passkey-vault'; record: PasskeyVaultRecord }
  | { kind: 'unrecognised' };
/** Recognise a largeBlob JSON envelope. A recognised format with invalid contents throws. */
function readRecoveryBlob(blob: Uint8Array): RecoveryBlob {
  if (blob.length > RECOVERY_MAX_BLOB_BYTES) throw new Error('Recovery blob exceeds size limit');
  let text: string; let envelope: { format?: unknown; version?: unknown; event?: RecoveryEvent };
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(blob); envelope = JSON.parse(text); }
  catch { return { kind: 'unrecognised' }; }
  if (envelope?.format === 'nostr-wot-passkey-recovery') {
    if (envelope.version !== 1 || !envelope.event) throw new Error('Invalid recovery blob');
    return { kind: 'recovery', event: envelope.event };
  }
  if (envelope?.format === PASSKEY_BACKUP_FORMAT) return { kind: 'passkey-vault', record: parsePasskeyBackup(text) };
  return { kind: 'unrecognised' };
}

/** Where a credential's legacy record is looked for. `author` is known from a 32-byte handle. */
export interface StoredLookup { credentialId: string; rpId: string; author?: string; blob?: Uint8Array; strict: boolean; scope?: RecoveryScope; schema?: string; verify: RecoveryVerifier; }
export type StoredFound =
  /** Validated events, newest first, at most one per author. */
  | { kind: 'events'; source: 'passkey' | 'relays'; events: RecoveryEvent[] }
  | { kind: 'passkey-vault'; record: PasskeyVaultRecord }
  | { kind: 'none' };

async function checkedEvent(event: RecoveryEvent, lookup: StoredLookup): Promise<RecoveryEvent> {
  const context = recoveryContextFromEvent(event, { credentialId: lookup.credentialId, rpId: lookup.rpId, pubkey: lookup.author ?? event?.pubkey });
  if (lookup.scope && context.scope !== lookup.scope || lookup.schema && recoverySchema(context) !== lookup.schema) throw new Error('Unexpected recovery scope or schema');
  await validateRecoveryEvent(event, context, lookup.verify);
  return event;
}

/**
 * Find a credential's legacy record: the provider blob first, then relays. With a known author the
 * relays are asked by author; without one (an untagged handle) by `#d` for v1 and `#credential` for
 * v4. Strict lookups reject an unusable blob instead of falling through to relays. Signatures and
 * context are validated here, before any PRF request.
 */
export async function findStoredRecovery(ports: RecoveryPorts, lookup: StoredLookup): Promise<StoredFound> {
  const credential = base64url.encode(canonicalCredential(lookup.credentialId));
  if (lookup.blob?.length) {
    let parsed: RecoveryBlob;
    try { parsed = readRecoveryBlob(lookup.blob); } catch (error) { if (lookup.strict) throw error; parsed = { kind: 'unrecognised' }; }
    if (parsed.kind === 'passkey-vault') {
      if (lookup.strict) throw new Error('Invalid recovery blob');
      return parsed;
    }
    if (parsed.kind === 'recovery') {
      try { return { kind: 'events', source: 'passkey', events: [await checkedEvent(parsed.event, lookup)] }; }
      catch (error) { if (lookup.strict) throw error; }
    } else if (lookup.strict) throw new Error('Invalid recovery blob');
  }
  if (!lookup.strict && !ports.relays?.length) return { kind: 'none' };
  const filters: RecoveryFilter[] = lookup.author
    ? [{ kinds: [RECOVERY_EVENT_KIND], authors: [lookup.author], limit: 32 }]
    : [{ kinds: [RECOVERY_EVENT_KIND], '#d': [credential], limit: 32 }, { kinds: [RECOVERY_EVENT_KIND], '#credential': [credential], limit: 32 }];
  const events = (await queryNewest(ports, filters, event => checkedEvent(event, lookup))).map(found => found.event);
  return events.length ? { kind: 'events', source: 'relays', events } : { kind: 'none' };
}

/**
 * Decrypt the first event that opens with this PRF output. With a known author only the newest
 * event is tried, so a newer snapshot that fails never silently rolls back to an older one.
 * Without one, each author's newest is tried, so a stranger's event cannot shadow the real record.
 */
export function openStoredRecovery(events: RecoveryEvent[], prf: Uint8Array, lookup: Pick<StoredLookup, 'credentialId' | 'rpId' | 'author'>): { payload: Uint8Array; context: RecoveryContext; event: RecoveryEvent } | null {
  for (const event of lookup.author ? events.slice(0, 1) : events) {
    const context = recoveryContextFromEvent(event, { credentialId: lookup.credentialId, rpId: lookup.rpId, pubkey: lookup.author ?? event.pubkey });
    try { return { payload: decryptRecoveryPayload(event.content, prf, context), context, event }; }
    catch { /* Try the next author; a known author has only one candidate. */ }
  }
  return null;
}

/**
 * Legacy records only. Returns authenticated opaque bytes; the host validates/imports its schema and
 * controls vault replacement. The handle is classified first: derived, tagged stored, unsupported and
 * key-in-handle passkeys are refused (use `resolvePasskeyIdentity` for tagged ones). A 32-byte handle
 * is looked up as an author and, with no record, as an unknown handle by credential.
 */
export async function restoreRecovery(options: RecoveryPorts & { rpId: string; verify: RecoveryVerifier; scope?: RecoveryScope; schema?: string }): Promise<{ payload: Uint8Array; context: RecoveryContext; event: RecoveryEvent }> {
  if (!validPasskeyRpId(options.rpId)) throw new Error('Invalid passkey RP');
  const discovered = await options.provider.discover({ rpId: options.rpId });
  discovered?.prf?.first?.fill?.(0); discovered?.prf?.second?.fill?.(0);
  const kind = classifyPasskeyHandle(assertionHandle(discovered));
  if (kind.mode === 'derived') throw new Error('This passkey uses derived mode and has no stored recovery');
  if (kind.mode === 'unsupported') throw new Error('This passkey was made by a newer or different app');
  if (kind.mode === 'stored' && !('author' in kind)) throw new Error('Key-in-handle passkeys are not supported');
  if (kind.mode === 'stored' && !('confirmRecord' in kind)) throw new Error('Tagged stored passkeys use the npk1 format; restore them with resolvePasskeyIdentity');
  const base: StoredLookup = { credentialId: discovered.credentialId, rpId: options.rpId, blob: discovered.blob, strict: true, scope: options.scope, schema: options.schema, verify: options.verify };
  let lookup: StoredLookup = kind.mode === 'stored' ? { ...base, author: kind.author } : base;
  let found = await findStoredRecovery(options, lookup);
  if (found.kind === 'none' && lookup.author) { lookup = base; found = await findStoredRecovery(options, lookup); }
  if (found.kind !== 'events') throw new Error('No matching recovery found');
  const material = await options.provider.authenticate({ credentialId: discovered.credentialId, rpId: options.rpId, prfInput: new TextEncoder().encode(RECOVERY_PRF_INPUT) });
  try {
    options.assertSession?.();
    const opened = openStoredRecovery(found.events, material, lookup);
    if (!opened) throw new Error(lookup.author ? 'Recovery could not be decrypted with this passkey' : 'No matching recovery found');
    return opened;
  } finally { material.fill(0); }
}
