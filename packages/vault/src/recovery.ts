/** Portable PRF recovery. Hosts own authenticator ceremonies, signing, relay leases and import policy. */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { base64url } from '@scure/base';
import { base64ToBytes, bytesToBase64 } from './serialization.js';
import { validPasskeyRpId } from './passkey.js';

export const RECOVERY_EVENT_KIND = 31777;
export const RECOVERY_PAYLOAD_VERSION = 4;
export const RECOVERY_MAX_BYTES = 64 * 1024;
export const RECOVERY_MAX_BLOB_BYTES = 128 * 1024;
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

function credentialBytes(context: RecoveryContext): Uint8Array {
  if (!context || !validPasskeyRpId(context.rpId) || !/^[a-f0-9]{64}$/.test(context.pubkey) || !['private-key', 'seed', 'vault'].includes(context.scope) || typeof context.credentialId !== 'string' || context.credentialId.length > 1368) throw new Error('Invalid recovery context');
  const bytes = base64ToBytes(context.credentialId);
  if (!bytes.length || bytes.length > 1024 || bytesToBase64(bytes) !== context.credentialId) throw new Error('Invalid recovery credential');
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
  if (!event || event.kind !== RECOVERY_EVENT_KIND || event.pubkey !== context.pubkey || !Number.isSafeInteger(event.created_at) || event.created_at < 0 || !Array.isArray(event.tags) || event.tags.length > 32 || event.tags.some(tag => !Array.isArray(tag) || !tag.length || tag.length > 8 || tag.some(value => typeof value !== 'string' || value.length > 2048)) || !/^[a-f0-9]{64}$/.test(event.id) || !/^[a-f0-9]{128}$/.test(event.sig)) throw new Error('Invalid recovery event');
  for (const expected of tags(context)) {
    const found = event.tags.filter(tag => Array.isArray(tag) && tag[0] === expected[0]);
    if (found.length !== 1 || JSON.stringify(found[0]) !== JSON.stringify(expected)) throw new Error(`Invalid recovery ${expected[0]}`);
  }
  parseBlob(event.content, context);
  // Only plain NIP-01 fields reach the host verifier, never cached verification markers.
  const copy = { id: event.id, sig: event.sig, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags.map(tag => [...tag]), content: event.content };
  if (!await verify(copy)) throw new Error('Invalid recovery signature');
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

/** Implemented by a browser/native adapter. PRF input is public; returned PRF bytes are secret. */
export interface RecoveryProvider {
  authenticate(options: { credentialId: string; rpId: string; prfInput: Uint8Array }): Promise<Uint8Array>;
  discover(options: { rpId: string }): Promise<{ credentialId: string; pubkey: string; blob?: Uint8Array }>;
  writeBlob(credentialId: string, blob: Uint8Array, rpId: string): Promise<boolean>;
}
export interface RecoveryTransport {
  publish(relay: string, event: RecoveryEvent, options: { signal: AbortSignal; assertSession?: () => void }): Promise<boolean>;
  query(relay: string, filter: { kinds: number[]; authors: string[]; limit: number }, options: { signal: AbortSignal }): Promise<RecoveryEvent[]>;
}
interface RecoveryPorts { provider: RecoveryProvider; transport: RecoveryTransport; relays: readonly string[]; assertSession?: () => void; timeoutMs?: number; }
const now = () => Math.floor(Date.now() / 1000);
function relayList(relays: readonly string[]): string[] {
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
/** Write confirmation is required. Cancellation/refusal never silently falls through to relays. */
export async function saveRecovery(options: RecoveryPorts & { payload: Uint8Array; context: RecoveryContext; largeBlobSupported: boolean; allowRelay?: boolean; prf?: Uint8Array; sign: (event: RecoveryEventTemplate) => Promise<RecoveryEvent>; verify: RecoveryVerifier }): Promise<{ destination: 'passkey' | 'relays'; event: RecoveryEvent; acceptedRelays: string[] }> {
  credentialBytes(options.context);
  if (!options.largeBlobSupported && !options.allowRelay) throw new Error('Relay recovery requires explicit consent');
  if (!options.largeBlobSupported) relayList(options.relays);
  const material = options.prf ?? await options.provider.authenticate({ ...options.context, prfInput: new TextEncoder().encode(RECOVERY_PRF_INPUT) });
  try {
    options.assertSession?.();
    const template = buildRecoveryEvent(options.context, encryptRecoveryPayload(options.payload, material, options.context), now());
    const event = await options.sign(template);
    if (JSON.stringify({ kind: event.kind, pubkey: event.pubkey, created_at: event.created_at, content: event.content, tags: event.tags }) !== JSON.stringify(template)) throw new Error('Signer changed recovery event');
    await validateRecoveryEvent(event, options.context, options.verify);
    options.assertSession?.();
    if (options.largeBlobSupported) {
      const blob = new TextEncoder().encode(JSON.stringify({ format: 'nostr-wot-passkey-recovery', version: 1, event }));
      if (blob.length > RECOVERY_MAX_BLOB_BYTES) throw new Error('Recovery blob exceeds size limit');
      if (!await options.provider.writeBlob(options.context.credentialId, blob, options.context.rpId)) throw new Error('Passkey recovery storage was not confirmed');
      options.assertSession?.();
      return { destination: 'passkey', event, acceptedRelays: [] };
    }
    const results = await Promise.all(relayList(options.relays).map(async relay => {
      try { options.assertSession?.(); return await bounded(signal => options.transport.publish(relay, event, { signal, assertSession: options.assertSession }), options.timeoutMs) ? relay : null; }
      catch { return null; }
    }));
    options.assertSession?.();
    const acceptedRelays = results.filter((relay): relay is string => relay !== null);
    if (!acceptedRelays.length) throw new Error('Recovery could not be saved on any relay');
    return { destination: 'relays', event, acceptedRelays };
  } finally { if (!options.prf) material.fill(0); }
}
/** Returns authenticated opaque bytes. The host validates/imports its schema and controls vault replacement. */
export async function restoreRecovery(options: RecoveryPorts & { rpId: string; verify: RecoveryVerifier; scope?: RecoveryScope; schema?: string }): Promise<{ payload: Uint8Array; context: RecoveryContext; event: RecoveryEvent }> {
  if (!validPasskeyRpId(options.rpId)) throw new Error('Invalid passkey RP');
  const discovered = await options.provider.discover({ rpId: options.rpId });
  const discovery = { credentialId: discovered.credentialId, pubkey: discovered.pubkey, rpId: options.rpId };
  credentialBytes({ ...discovery, scope: 'vault' });
  let event: RecoveryEvent | undefined;
  if (discovered.blob?.length) {
    if (discovered.blob.length > RECOVERY_MAX_BLOB_BYTES) throw new Error('Recovery blob exceeds size limit');
    const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(discovered.blob));
    if (envelope?.format !== 'nostr-wot-passkey-recovery' || envelope.version !== 1) throw new Error('Invalid recovery blob');
    event = envelope.event;
  } else {
    const results = await Promise.all(relayList(options.relays).map(async relay => {
      try { return await bounded(signal => options.transport.query(relay, { kinds: [RECOVERY_EVENT_KIND], authors: [discovery.pubkey], limit: 32 }, { signal }), options.timeoutMs); }
      catch { return []; }
    }));
    const candidates: RecoveryEvent[] = [];
    for (const result of results) {
      if (!Array.isArray(result) || result.length > 32) continue;
      for (const candidate of result) {
        try {
          const context = recoveryContextFromEvent(candidate, discovery);
          if (options.scope && context.scope !== options.scope || options.schema && recoverySchema(context) !== options.schema) continue;
          await validateRecoveryEvent(candidate, context, options.verify);
          candidates.push(candidate);
        } catch { /* Invalid public events cannot choose a credential or override valid recovery. */ }
      }
    }
    event = candidates.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  }
  if (!event) throw new Error('No matching recovery found');
  const context = recoveryContextFromEvent(event, discovery);
  if (options.scope && context.scope !== options.scope || options.schema && recoverySchema(context) !== options.schema) throw new Error('Unexpected recovery scope or schema');
  await validateRecoveryEvent(event, context, options.verify);
  const material = await options.provider.authenticate({ ...discovery, prfInput: new TextEncoder().encode(RECOVERY_PRF_INPUT) });
  try {
    options.assertSession?.();
    return { payload: decryptRecoveryPayload(event.content, material, context), context, event };
  } finally { material.fill(0); }
}
