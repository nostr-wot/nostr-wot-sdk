import { describe, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { bytesToBase64 } from '../src/serialization.js';
import { createPasskeyRecord, openPasskeyRecord, wrapVaultKey, unwrapVaultKey, LEGACY_PASSKEY_RP_ID, PASSKEY_RP_ID } from '../src/passkey.js';
import { encryptRecoveryPayload, decryptRecoveryPayload, buildRecoveryEvent, validateRecoveryEvent, recoveryCoordinate, RECOVERY_PRF_INPUT, RECOVERY_MAX_BYTES, saveRecovery, restoreRecovery } from '../src/recovery.js';

const context = { credentialId: 'AQID', rpId: PASSKEY_RP_ID, pubkey: 'ab'.repeat(32), scope: 'vault' as const };
const prf = new Uint8Array(32).fill(7);
const payload = new TextEncoder().encode('{"accounts":["one","two"]}');
const signed = (event: any) => ({ ...event, id: 'cd'.repeat(32), sig: 'ef'.repeat(64) });
const provider = (options: any = {}) => ({ authenticate: vi.fn(async () => prf.slice()), discover: vi.fn(async () => ({ credentialId: context.credentialId, pubkey: context.pubkey })), writeBlob: vi.fn(async () => true), ...options });
const transport = (events: any[] = []) => ({ publish: vi.fn(async () => true), query: vi.fn(async () => events) });

describe('typed recovery protocol', () => {
  test.each(['private-key', 'seed', 'vault'] as const)('round trips %s and authenticates its metadata', scope => {
    const ctx = { ...context, scope };
    const bytes = scope === 'private-key' ? new Uint8Array(32).fill(1) : payload;
    const encrypted = encryptRecoveryPayload(bytes, prf, ctx);
    expect(decryptRecoveryPayload(encrypted, prf, ctx)).toEqual(bytes);
    expect(prf).toEqual(new Uint8Array(32).fill(7));
    expect(encryptRecoveryPayload(bytes, prf, ctx)).not.toBe(encrypted);
    expect(() => decryptRecoveryPayload(encrypted, new Uint8Array(32), ctx)).toThrow();
    expect(() => decryptRecoveryPayload(encrypted, prf, { ...ctx, credentialId: 'AQIE' })).toThrow();
    if (scope !== 'private-key') expect(() => decryptRecoveryPayload(encrypted, prf, { ...ctx, rpId: 'other.example' })).toThrow();
  });
  test('v1 and v4 match the independently implemented WebCrypto wire format', async () => {
    for (const scope of ['private-key', 'seed', 'vault'] as const) {
      const ctx = { ...context, scope };
      const bytes = scope === 'private-key' ? new Uint8Array(32).fill(1) : payload;
      const encrypted = encryptRecoveryPayload(bytes, prf, ctx);
      const blob = Uint8Array.from(Buffer.from(encrypted, 'base64'));
      const ikm = await webcrypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
      const key = await webcrypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: blob.slice(13, 45), info: new TextEncoder().encode(scope === 'private-key' ? 'keytr nsec encryption v1' : 'keytr payload encryption v4') }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const aad = scope === 'private-key' ? new Uint8Array([...new TextEncoder().encode('keytr'), 1, 1, 2, 3]) : new TextEncoder().encode(JSON.stringify(['keytr', 4, scope, `com.nostrwot.${scope}.v1`, ctx.rpId, ctx.pubkey, 'AQID']));
      const opened = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(1, 13), additionalData: aad }, key, blob.slice(45));
      expect(new Uint8Array(opened)).toEqual(bytes);
      const replaced = new Uint8Array(blob.length);
      replaced.set(blob.slice(0, 45));
      replaced.set(new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: blob.slice(1, 13), additionalData: aad }, key, bytes)), 45);
      expect(decryptRecoveryPayload(bytesToBase64(replaced), prf, ctx)).toEqual(bytes);
    }
  });
  test('rejects malformed, oversized, unknown and substituted formats', () => {
    for (const bytes of [new Uint8Array(), new Uint8Array(RECOVERY_MAX_BYTES + 1)]) expect(() => encryptRecoveryPayload(bytes, prf, context)).toThrow();
    for (const content of ['', '!', 'A'.repeat(100000)]) expect(() => decryptRecoveryPayload(content, prf, context)).toThrow();
    expect(() => encryptRecoveryPayload(payload, prf, { ...context, scope: 'unknown' as any })).toThrow();
    expect(() => recoveryCoordinate({ ...context, rpId: 'https://example.com' })).toThrow();
    const bytes = new Uint8Array(Buffer.from(encryptRecoveryPayload(payload, prf, context), 'base64'));
    bytes[0] = 3;
    expect(() => decryptRecoveryPayload(bytesToBase64(bytes), prf, context)).toThrow();
  });
  test('validates event metadata and signature before returning ciphertext', async () => {
    const event = signed(buildRecoveryEvent(context, encryptRecoveryPayload(payload, prf, context), 123));
    expect(event.tags).toContainEqual(['d', 'AQID:vault:com.nostrwot.vault.v1']);
    await validateRecoveryEvent(event, context, async () => true);
    await expect(validateRecoveryEvent(event, context, async () => false)).rejects.toThrow();
    await expect(validateRecoveryEvent({ ...event, tags: [...event.tags, ['v', '4']] }, context, async () => true)).rejects.toThrow();
    await expect(validateRecoveryEvent(event, { ...context, scope: 'seed' }, async () => true)).rejects.toThrow();
    await expect(validateRecoveryEvent({ ...event, pubkey: 'ff'.repeat(32) }, context, async () => true)).rejects.toThrow();
  });
});

describe('provider-first recovery orchestration', () => {
  test('confirmed blob storage never contacts relays; discovery restores without an npub', async () => {
    let blob: Uint8Array | undefined;
    const authenticator = provider({ writeBlob: vi.fn(async (_id: string, value: Uint8Array) => { blob = value.slice(); return true; }), discover: vi.fn(async () => ({ credentialId: context.credentialId, pubkey: context.pubkey, blob })) });
    const relays = transport();
    const result = await saveRecovery({ payload, context, largeBlobSupported: true, verify: async () => true, sign: async event => signed(event), provider: authenticator, transport: relays, relays: ['wss://example.com'] });
    expect(result.destination).toBe('passkey');
    expect(relays.publish).not.toHaveBeenCalled();
    const recovered = await restoreRecovery({ rpId: context.rpId, provider: authenticator, transport: relays, relays: ['wss://example.com'], verify: async () => true });
    expect(recovered.payload).toEqual(payload);
    expect(relays.query).not.toHaveBeenCalled();
  });
  test('unsupported blob uses explicit relay consent, accepts partial success and reuses an existing proof', async () => {
    const authenticator = provider();
    const relays = transport(); relays.publish.mockImplementation(async relay => relay.includes('one'));
    const options = { payload, context, largeBlobSupported: false, verify: async () => true, sign: async (event: any) => signed(event), provider: authenticator, transport: relays, relays: ['wss://one.example', 'wss://two.example'], prf };
    await expect(saveRecovery(options)).rejects.toThrow('consent');
    expect(relays.publish).not.toHaveBeenCalled();
    const result = await saveRecovery({ ...options, allowRelay: true });
    expect(result.destination).toBe('relays'); expect(result.acceptedRelays).toEqual(['wss://one.example']);
    expect(authenticator.authenticate).not.toHaveBeenCalled(); expect(authenticator.writeBlob).not.toHaveBeenCalled();
    expect(prf[0]).toBe(7);
  });
  test('cancellation and refused storage never silently publish', async () => {
    const relays = transport();
    for (const authenticator of [provider({ writeBlob: vi.fn(async () => false) }), provider({ writeBlob: vi.fn(async () => { throw new Error('cancelled'); }) })]) {
      await expect(saveRecovery({ payload, context, largeBlobSupported: true, allowRelay: true, verify: async () => true, sign: async event => signed(event), provider: authenticator, transport: relays, relays: ['wss://example.com'] })).rejects.toThrow();
    }
    expect(relays.publish).not.toHaveBeenCalled();
  });
  test('reports total relay failure and cleans up authenticator output', async () => {
    const output = prf.slice(); const authenticator = provider({ authenticate: vi.fn(async () => output) }); const relays = transport(); relays.publish.mockResolvedValue(false);
    await expect(saveRecovery({ payload, context, largeBlobSupported: false, allowRelay: true, verify: async () => true, sign: async event => signed(event), provider: authenticator, transport: relays, relays: ['wss://example.com'] })).rejects.toThrow('relay');
    expect(output.every(n => n === 0)).toBe(true);
  });
  test('relay discovery detects scope, selects newest and never falls back after failed decryption', async () => {
    const old = signed(buildRecoveryEvent(context, encryptRecoveryPayload(payload, prf, context), 1));
    const latest = signed(buildRecoveryEvent(context, encryptRecoveryPayload(payload, new Uint8Array(32), context), 2));
    const relays = transport([old, latest]); const authenticator = provider();
    await expect(restoreRecovery({ rpId: context.rpId, provider: authenticator, transport: relays, relays: ['wss://example.com'], verify: async () => true })).rejects.toThrow();
    relays.query.mockResolvedValue([old]);
    expect((await restoreRecovery({ rpId: context.rpId, provider: authenticator, transport: relays, relays: ['wss://example.com'], verify: async () => true })).context.scope).toBe('vault');
  });
});

test('new RP defaults and explicit old/custom registrations keep wrapping compatible', async () => {
  const input = { credentialId: 'AQID', prfSalt: bytesToBase64(new Uint8Array(32)), prf: bytesToBase64(prf) };
  const raw = new Uint8Array(32).fill(1);
  const old = wrapVaultKey(raw, input);
  expect(unwrapVaultKey(old, input)).toEqual(raw);
  expect(LEGACY_PASSKEY_RP_ID).toBe('passkeys.nostr-wot.com');
  expect(PASSKEY_RP_ID).toBe('passkeys.nostrwot.com');
  const payload = { accounts: [], activeAccountId: null };
  for (const rpId of [LEGACY_PASSKEY_RP_ID, PASSKEY_RP_ID, 'example.com']) {
    const enrollment = { ...input, rpId, prfSalt: bytesToBase64(new TextEncoder().encode(RECOVERY_PRF_INPUT)) };
    const record = createPasskeyRecord(payload, enrollment);
    expect((await openPasskeyRecord(record, enrollment)).payload.accounts).toEqual([]);
    expect(record.passkeys[0].rpId).toBe(rpId);
  }
});


test('recovery scope and discovery identity are bound to new vault wrappers', () => {
  const input = { credentialId: 'AQID', prfSalt: bytesToBase64(new TextEncoder().encode(RECOVERY_PRF_INPUT)), prf: bytesToBase64(prf), rpId: PASSKEY_RP_ID, recoveryPubkey: context.pubkey, recoveryScope: 'private-key' as const };
  const wrapper = wrapVaultKey(new Uint8Array(32).fill(1), input);
  expect(() => unwrapVaultKey({ ...wrapper, recoveryScope: 'vault' }, input)).toThrow();
  expect(() => unwrapVaultKey({ ...wrapper, recoveryPubkey: 'cd'.repeat(32) }, input)).toThrow();
});
