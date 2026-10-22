/**
 * Passkey key modes: the proposal's derived and handle vectors, then the behaviour that keeps the
 * modes apart during login. Stored record vectors and formats are in passkey-store.test.ts.
 * The vectors are a copy of the extension's `nips/passkey/passkey-key-mode-vectors.json`.
 */
import { describe, expect, test, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import vectors from './fixtures/passkey-key-mode-vectors.json' with { type: 'json' };
import { bytesToBase64, bytesToHex, hexToBytes } from '../../src/vault/serialization.js';
import { DEFAULT_DERIVED_PARAMETER_SET, classifyPasskeyHandle, derivedPrfInput, deriveNostrKey, encodeDerivedHandle, encodeStoredHandle, type DerivedParameterSet } from '../../src/vault/passkey-modes.js';
import { derivePasskeyIdentity, resolvePasskeyIdentity } from '../../src/vault/passkey-identity.js';
import { buildRecoveryEvent, encryptRecoveryPayload, restoreRecovery, RECOVERY_PRF_INPUT, type RecoveryContext, type RecoveryEvent, type RecoveryFilter } from '../../src/vault/recovery.js';
import { buildStoredRecordEvent, encryptStoredRecord, storedPrfInput, type StoredPayload } from '../../src/vault/passkey-store.js';
import { createPasskeyRecord, serializePasskeyBackup, PASSKEY_RECOVERY_PRF_SALT } from '../../src/vault/passkey.js';

const [DEFAULT_SET, REGISTRY_SET] = vectors.derived_parameter_sets;
/** A registry-assigned set as a host would configure it, from registry data rather than SDK constants. */
const REGISTRY: DerivedParameterSet = { id: REGISTRY_SET.parameter_set, saltLabel: REGISTRY_SET.salt_label, infoLabel: REGISTRY_SET.info_label };
const DEFAULT = DEFAULT_DERIVED_PARAMETER_SET;
/** The vectors spell fields in snake case; the SDK in camel case. */
const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const expected = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).map(([key, entry]) => [camel(key), entry]));
const RP = 'wallet.example.com';
const CREDENTIAL = 'AQIDBA==';
const CREDENTIAL_TAG = 'AQIDBA';
const UUID_HANDLE = hexToBytes(vectors.handles.find(h => h.description === 'untagged UUID text handle')!.handle!);
const KIH_HANDLE = hexToBytes(vectors.handles.find(h => h.expect.legacy === 'key-in-handle')!.handle!);
const SEVENS = new Uint8Array(32).fill(7);
/** Private key 1; its public key is the author of every record here. */
const PRIVATE_ONE = hexToBytes('00'.repeat(31) + '01');
const AUTHOR = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const STORED_OUTPUT = new Uint8Array(32).fill(5);
const LEGACY_OUTPUT = new Uint8Array(32).fill(6);
const LEGACY_PAYLOAD = new Uint8Array(32).fill(9);
const RELAYS = ['wss://recovery.example.com'];
const LEGACY_INPUT = bytesToHex(new TextEncoder().encode(RECOVERY_PRF_INPUT));

describe('vectors', () => {
  test('stored and legacy stored PRF inputs', () => {
    expect(bytesToHex(storedPrfInput())).toBe(vectors.stored.prf_input);
    expect(bytesToHex(sha256(new TextEncoder().encode(vectors.stored.prf_label)))).toBe(vectors.stored.prf_input);
    expect(RECOVERY_PRF_INPUT).toBe(vectors.legacy_stored.prf_input_utf8);
    expect(LEGACY_INPUT).toBe(vectors.legacy_stored.prf_input);
  });
  test.each([[DEFAULT_SET, DEFAULT], [REGISTRY_SET, REGISTRY]] as const)('parameter set %# derives the pinned key', (vector, set) => {
    expect(set).toMatchObject({ id: vector.parameter_set, saltLabel: vector.salt_label, infoLabel: vector.info_label });
    expect(bytesToHex(derivedPrfInput(set))).toBe(vector.prf_input);
    const prf = hexToBytes(vector.prf_output);
    const key = deriveNostrKey(prf, set);
    expect(bytesToHex(key.secret)).toBe(vector.secret_key);
    expect(key.pubkey).toBe(vector.public_key);
    expect(bytesToHex(prf)).toBe(vector.prf_output);
  });
  test.each(vectors.handles)('classifies $description', vector => {
    expect(classifyPasskeyHandle(vector.handle === null ? null : hexToBytes(vector.handle))).toEqual(expected(vector.expect));
  });
  test('encoders produce the tagged vector handles', () => {
    for (const [set, description] of [[DEFAULT, 'tagged derived, parameter set 0x01'], [REGISTRY, 'tagged derived, parameter set 0x02']] as const) {
      const vector = vectors.handles.find(h => h.description === description)!;
      expect(bytesToHex(encodeDerivedHandle(set, hexToBytes(vector.handle!).slice(6)))).toBe(vector.handle);
    }
    const stored = vectors.handles.find(h => h.description === 'tagged stored')!;
    expect(bytesToHex(encodeStoredHandle(stored.expect.author!))).toBe(stored.handle);
  });
});

describe('pure functions', () => {
  test('random derived handles are unlinkable and classify back', () => {
    const one = encodeDerivedHandle(DEFAULT); const two = encodeDerivedHandle(DEFAULT);
    expect(one).toHaveLength(22); expect(bytesToHex(one)).not.toBe(bytesToHex(two));
    expect(classifyPasskeyHandle(encodeDerivedHandle(REGISTRY))).toEqual({ mode: 'derived', parameterSet: 2 });
  });
  test.each([
    ['a reserved byte', { ...REGISTRY, id: 0x80 }],
    ['byte zero', { ...REGISTRY, id: 0 }],
    ['an empty label', { ...REGISTRY, infoLabel: '' }],
    ['a redefined 0x01', { ...REGISTRY, id: 1 }],
  ])('rejects a parameter set with %s', (_name, set) => {
    expect(() => derivedPrfInput(set)).toThrow('parameter set');
    expect(() => deriveNostrKey(SEVENS, set)).toThrow('parameter set');
    expect(() => encodeDerivedHandle(set)).toThrow('parameter set');
  });
  test('encoders and derivation reject bad input', () => {
    expect(() => encodeDerivedHandle(DEFAULT, new Uint8Array(15))).toThrow();
    expect(() => encodeStoredHandle('AB'.repeat(32))).toThrow();
    expect(() => deriveNostrKey(new Uint8Array(31), DEFAULT)).toThrow();
  });
  test('an NPK-prefixed handle that is not a valid version 1 handle, nor 32 bytes, is unsupported', () => {
    const handle = encodeDerivedHandle(DEFAULT); handle[4] = 0x03;
    expect(classifyPasskeyHandle(handle)).toEqual({ mode: 'unsupported' });
    const short = new Uint8Array(31); short.set([0x4e, 0x50, 0x4b]);
    expect(classifyPasskeyHandle(short)).toEqual({ mode: 'unsupported' });
    expect(classifyPasskeyHandle(new Uint8Array([0x4e, 0x50, 0x4b]))).toEqual({ mode: 'unsupported' });
  });
  test('derived inputs never equal either stored input', () => {
    for (const set of [DEFAULT, REGISTRY]) for (const stored of [vectors.stored.prf_input, LEGACY_INPUT]) expect(bytesToHex(derivedPrfInput(set))).not.toBe(stored);
  });
});

/** A fake authenticator: PRF output is a function of the input, every returned buffer is tracked. */
function passkey(options: { handle?: Uint8Array; blob?: Uint8Array; dropExtensions?: boolean; noAssert?: boolean }) {
  const issued: Uint8Array[] = [];
  const credentialId = CREDENTIAL;
  const output = (input: Uint8Array) => {
    const hex = bytesToHex(input);
    const value = hex === REGISTRY_SET.prf_input || hex === DEFAULT_SET.prf_input ? SEVENS.slice()
      : hex === vectors.stored.prf_input ? STORED_OUTPUT.slice() : hex === LEGACY_INPUT ? LEGACY_OUTPUT.slice() : sha256(input);
    issued.push(value); return value;
  };
  const evaluate = (prf?: { first: Uint8Array; second?: Uint8Array }) => prf ? { first: output(prf.first), ...(prf.second ? { second: output(prf.second) } : {}) } : undefined;
  const handle = options.handle ? { userHandle: options.handle } : {};
  const provider = {
    authenticate: vi.fn(async ({ prfInput }: { prfInput: Uint8Array }) => output(prfInput)),
    discover: vi.fn(async (request: { prf?: { first: Uint8Array; second?: Uint8Array }; largeBlob?: boolean }) =>
      options.dropExtensions ? { credentialId, ...handle } : { credentialId, ...handle, prf: evaluate(request.prf), ...(request.largeBlob && options.blob ? { blob: options.blob } : {}) }),
    assert: options.noAssert ? undefined : vi.fn(async (request: { prf?: { first: Uint8Array; second?: Uint8Array }; largeBlob?: boolean }) =>
      ({ credentialId, ...handle, prf: evaluate(request.prf), ...(request.largeBlob && options.blob ? { blob: options.blob } : {}) })),
    writeBlob: vi.fn(async () => true),
  };
  return { provider, issued, zeroed: () => issued.every(buffer => buffer.every(byte => byte === 0)) };
}

/** A relay that honours authors, #d and #credential. */
function relay(events: RecoveryEvent[]) {
  const query = vi.fn(async (_relay: string, filter: RecoveryFilter) => events.filter(event =>
    (!filter.authors || filter.authors.includes(event.pubkey)) &&
    (!filter['#d'] || event.tags.some(tag => tag[0] === 'd' && filter['#d']!.includes(tag[1]))) &&
    (!filter['#credential'] || event.tags.some(tag => tag[0] === 'credential' && filter['#credential']!.includes(tag[1])))));
  return { publish: vi.fn(async () => true), query };
}
let nextId = 1;
const signed = (template: Omit<RecoveryEvent, 'id' | 'sig'>): RecoveryEvent => ({ ...template, id: (nextId++).toString(16).padStart(64, '0'), sig: 'ef'.repeat(64) });
/** A legacy keytr event. */
function legacyRecord(scope: RecoveryContext['scope'], options: { prf?: Uint8Array; author?: string; createdAt?: number } = {}): RecoveryEvent {
  const context: RecoveryContext = { credentialId: CREDENTIAL, rpId: RP, pubkey: options.author ?? AUTHOR, scope };
  return signed(buildRecoveryEvent(context, encryptRecoveryPayload(LEGACY_PAYLOAD, options.prf ?? LEGACY_OUTPUT, context), options.createdAt ?? 10));
}
/** Raw bytes of a tagged-format record holding private key 1. */
function taggedBytes(options: { prf?: Uint8Array; payload?: StoredPayload } = {}): Uint8Array {
  const payload = options.payload ?? { type: 'key', key: PRIVATE_ONE };
  return encryptStoredRecord(payload, options.prf ?? STORED_OUTPUT, { credentialId: CREDENTIAL, rpId: RP, author: AUTHOR });
}
function taggedRecord(options: { prf?: Uint8Array; createdAt?: number } = {}): RecoveryEvent {
  return signed(buildStoredRecordEvent(taggedBytes(options), { credentialId: CREDENTIAL, rpId: RP, author: AUTHOR }, options.createdAt ?? 10));
}
const envelope = (event: RecoveryEvent) => new TextEncoder().encode(JSON.stringify({ format: 'nostr-wot-passkey-recovery', version: 1, event }));
const verify = async () => true;
const inputs = (calls: { prf?: { first: Uint8Array; second?: Uint8Array } }[][]) => calls.map(([request]) => [request.prf?.first, request.prf?.second].filter(Boolean).map(bytes => bytesToHex(bytes!)));

describe('resolvePasskeyIdentity: tagged handles', () => {
  test('a tagged stored handle restores its relay record by author', async () => {
    const key = passkey({ handle: encodeStoredHandle(AUTHOR) });
    const transport = relay([taggedRecord()]);
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport, relays: RELAYS, verify, parameterSet: REGISTRY });
    expect(result).toMatchObject({ mode: 'stored', format: 'npk1', source: 'relays', author: AUTHOR, payload: { type: 'key', key: PRIVATE_ONE } });
    expect(transport.query.mock.calls.map(call => call[1])).toContainEqual({ kinds: [31778], authors: [AUTHOR], '#d': ['AQIDBA:key'], limit: 32 });
    expect(key.provider.assert).not.toHaveBeenCalled();
    expect(key.zeroed()).toBe(true);
  });
  test('a tagged stored handle restores a provider record after checking relay updates', async () => {
    const key = passkey({ handle: encodeStoredHandle(AUTHOR), blob: taggedBytes() });
    const transport = relay([]);
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport, relays: RELAYS, verify });
    expect(result).toMatchObject({ mode: 'stored', format: 'npk1', source: 'passkey' });
    expect(transport.query).toHaveBeenCalled();
  });
  test('a tagged stored handle with no record is an error, never a derived identity', async () => {
    const key = passkey({ handle: encodeStoredHandle(AUTHOR), blob: envelope(legacyRecord('vault')) });
    for (const parameterSet of [undefined, REGISTRY]) {
      const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([legacyRecord('private-key')]), relays: RELAYS, verify, parameterSet });
      expect(result).toMatchObject({ mode: 'error', reason: 'missing-record' });
      expect(JSON.stringify(result)).not.toContain(REGISTRY_SET.public_key);
    }
    expect(key.zeroed()).toBe(true);
  });
  test('a failing newer immutable key permits an older opening copy', async () => {
    const key = passkey({ handle: encodeStoredHandle(AUTHOR) });
    const transport = relay([taggedRecord({ createdAt: 1 }), taggedRecord({ prf: new Uint8Array(32).fill(1), createdAt: 2 })]);
    expect(await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport, relays: RELAYS, verify, parameterSet: REGISTRY })).toMatchObject({ mode: 'stored', format: 'npk1' });
  });
  test('when discoverable login drops the extensions, a tagged stored handle asks only for the stored input and blob', async () => {
    const key = passkey({ handle: encodeStoredHandle(AUTHOR), blob: taggedBytes(), dropExtensions: true });
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([]), relays: RELAYS, verify, parameterSet: REGISTRY });
    expect(result).toMatchObject({ mode: 'stored', format: 'npk1', source: 'passkey' });
    expect(inputs(key.provider.assert!.mock.calls)).toEqual([[vectors.stored.prf_input]]);
    expect(key.provider.assert!.mock.calls[0][0].largeBlob).toBe(true);
    expect(key.zeroed()).toBe(true);
  });
  test('a tagged derived handle ignores a stored blob and record', async () => {
    const key = passkey({ handle: encodeDerivedHandle(DEFAULT), blob: taggedBytes() });
    const transport = relay([legacyRecord('private-key'), taggedRecord()]);
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport, relays: RELAYS, verify });
    expect(result).toMatchObject({ mode: 'derived', parameterSet: DEFAULT, pubkey: DEFAULT_SET.public_key });
    expect(transport.query).not.toHaveBeenCalled();
  });
  test('a handle naming the configured set derives from the login assertion alone', async () => {
    const key = passkey({ handle: encodeDerivedHandle(REGISTRY) });
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([]), verify, parameterSet: REGISTRY });
    expect(result).toMatchObject({ mode: 'derived', parameterSet: REGISTRY, pubkey: REGISTRY_SET.public_key });
    expect(bytesToHex((result as { secret: Uint8Array }).secret)).toBe(REGISTRY_SET.secret_key);
    expect(key.provider.assert).not.toHaveBeenCalled();
    expect(key.zeroed()).toBe(true);
  });
  test('a handle naming another implemented parameter set gets one targeted assertion with that set', async () => {
    const key = passkey({ handle: encodeDerivedHandle(DEFAULT) });
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([]), verify, parameterSet: REGISTRY });
    expect(result).toMatchObject({ mode: 'derived', parameterSet: DEFAULT, pubkey: DEFAULT_SET.public_key });
    expect(key.provider.assert!.mock.calls[0][0]).toMatchObject({ credentialId: CREDENTIAL, rpId: RP });
    expect(inputs(key.provider.assert!.mock.calls)).toEqual([[DEFAULT_SET.prf_input]]);
    expect(key.zeroed()).toBe(true);
  });
  test.each([
    ['a registry set the host did not configure', encodeDerivedHandle(REGISTRY)],
    ['an unimplemented parameter set', hexToBytes(vectors.handles.find(h => h.description === 'tagged derived, parameter set not in registry')!.handle!)],
    ['an unsupported NPK handle', hexToBytes(vectors.handles.find(h => h.description === 'NPK prefix with other version byte')!.handle!)],
    ['key-in-handle', KIH_HANDLE],
  ])('%s is refused with no derivation and no discovery', async (_name, handle) => {
    const key = passkey({ handle, blob: envelope(legacyRecord('vault')) });
    const transport = relay([legacyRecord('private-key'), taggedRecord()]);
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport, relays: RELAYS, verify });
    expect(result).toMatchObject({ mode: 'error', reason: 'unsupported-handle' });
    expect(transport.query).not.toHaveBeenCalled();
    expect(key.provider.assert).not.toHaveBeenCalled();
    expect(key.zeroed()).toBe(true);
  });
});

describe('resolvePasskeyIdentity: 32-byte handles', () => {
  test('a 32-byte handle with a legacy relay record restores it with one targeted legacy assertion', async () => {
    const key = passkey({ handle: hexToBytes(AUTHOR) });
    const transport = relay([legacyRecord('private-key')]);
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport, relays: RELAYS, verify, parameterSet: REGISTRY });
    expect(result).toMatchObject({ mode: 'stored', format: 'legacy', source: 'relays', context: { scope: 'private-key', pubkey: AUTHOR } });
    expect((result as { payload: Uint8Array }).payload).toEqual(LEGACY_PAYLOAD);
    expect(transport.query.mock.calls[0][1]).toEqual({ kinds: [31777], authors: [AUTHOR], limit: 32 });
    expect(inputs(key.provider.assert!.mock.calls)).toEqual([[LEGACY_INPUT]]);
    expect(key.zeroed()).toBe(true);
  });
  test('a 32-byte handle with a legacy blob envelope asks for the legacy input and blob when the platform dropped them', async () => {
    const key = passkey({ handle: hexToBytes(AUTHOR), blob: envelope(legacyRecord('vault')), dropExtensions: true });
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([]), relays: RELAYS, verify });
    expect(result).toMatchObject({ mode: 'stored', format: 'legacy', source: 'passkey' });
    expect(inputs(key.provider.assert!.mock.calls)).toEqual([[LEGACY_INPUT]]);
  });
  test('a legacy record that does not open is an error, not a fallback', async () => {
    const key = passkey({ handle: hexToBytes(AUTHOR) });
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([legacyRecord('vault', { prf: new Uint8Array(32) })]), relays: RELAYS, verify, parameterSet: REGISTRY });
    expect(result).toMatchObject({ mode: 'error', reason: 'undecryptable-record' });
  });
  test('a 32-byte handle without a record never derives', async () => {
    const key = passkey({ handle: sha256(new Uint8Array([1])) });
    expect(await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([]), relays: RELAYS, verify, parameterSet: REGISTRY })).toMatchObject({ mode: 'error', reason: 'missing-record' });
  });
});

describe('resolvePasskeyIdentity: unknown handles', () => {
  test('an untagged UUID handle on an RP configured for set 0x02 derives with it and zeroes every PRF output', async () => {
    const key = passkey({ handle: UUID_HANDLE });
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([]), verify, parameterSet: REGISTRY, exclusiveDerivedDeployment: true });
    expect(result).toMatchObject({ mode: 'derived', parameterSet: REGISTRY, pubkey: REGISTRY_SET.public_key, credentialId: CREDENTIAL });
    expect(bytesToHex((result as { secret: Uint8Array }).secret)).toBe(REGISTRY_SET.secret_key);
    expect(bytesToHex(key.provider.discover.mock.calls[0][0].prf!.second!)).toBe(REGISTRY_SET.prf_input);
    expect(key.provider.assert).not.toHaveBeenCalled();
    expect(key.issued.length).toBe(2);
    expect(key.zeroed()).toBe(true);
  });
  test.each([['an untagged', UUID_HANDLE], ['a missing', undefined]])('%s handle with no record and no configured set is ambiguous, with the candidate and no secret', async (_name, handle) => {
    const key = passkey({ handle });
    const transport = relay([]);
    const result = await resolvePasskeyIdentity({ rpId: 'app.example.com', provider: key.provider, transport, relays: RELAYS, verify });
    expect(result).toEqual({ mode: 'ambiguous', credentialId: CREDENTIAL, parameterSet: DEFAULT, pubkey: DEFAULT_SET.public_key });
    expect(transport.query).not.toHaveBeenCalled();
    expect(key.zeroed()).toBe(true);
    // Only after the user confirms: a targeted assertion reproducing that exact candidate.
    const confirmed = await derivePasskeyIdentity({ provider: key.provider, rpId: 'app.example.com', credentialId: CREDENTIAL, parameterSet: DEFAULT, expectedPubkey: DEFAULT_SET.public_key });
    expect(bytesToHex(confirmed.secret)).toBe(DEFAULT_SET.secret_key);
    await expect(derivePasskeyIdentity({ provider: key.provider, rpId: 'app.example.com', credentialId: CREDENTIAL, parameterSet: REGISTRY, expectedPubkey: DEFAULT_SET.public_key })).rejects.toThrow('confirmed');
    expect(key.zeroed()).toBe(true);
  });
  test('an app record linking the credential to the candidate resolves it as derived', async () => {
    const key = passkey({ handle: UUID_HANDLE });
    const isKnownDerived = vi.fn(async ({ pubkey }: { pubkey: string }) => pubkey === DEFAULT_SET.public_key);
    const result = await resolvePasskeyIdentity({ rpId: 'app.example.com', provider: key.provider, transport: relay([]), verify, isKnownDerived });
    expect(result).toMatchObject({ mode: 'derived', pubkey: DEFAULT_SET.public_key, parameterSet: DEFAULT });
    expect(isKnownDerived).toHaveBeenCalledWith({ credentialId: CREDENTIAL, pubkey: DEFAULT_SET.public_key, parameterSet: DEFAULT });
  });
  test.each(['private-key', 'vault'] as const)('an untagged handle ignores a legacy %s relay record', async scope => {
    const key = passkey({ handle: UUID_HANDLE });
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([legacyRecord(scope)]), relays: RELAYS, verify, parameterSet: REGISTRY });
    expect(result).toMatchObject({ mode: 'ambiguous', pubkey: REGISTRY_SET.public_key });
    expect(key.zeroed()).toBe(true);
  });
  test('an untagged handle ignores a tagged-format relay record', async () => {
    const key = passkey({ handle: UUID_HANDLE });
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([taggedRecord()]), relays: RELAYS, verify, parameterSet: REGISTRY });
    expect(result).toMatchObject({ mode: 'ambiguous', pubkey: REGISTRY_SET.public_key });
    expect(key.provider.assert).not.toHaveBeenCalled();
  });
  test('an untagged handle with a tagged-format blob is reported unreadable, never derived', async () => {
    const key = passkey({ handle: UUID_HANDLE, blob: taggedBytes() });
    expect(await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([]), verify, parameterSet: REGISTRY })).toMatchObject({ mode: 'error', reason: 'unreadable-record' });
  });
  test("a stranger's record for the credential cannot shadow the derived identity", async () => {
    const key = passkey({ handle: UUID_HANDLE });
    const forged = legacyRecord('private-key', { prf: new Uint8Array(32).fill(1), author: 'ab'.repeat(32), createdAt: 99 });
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([forged]), relays: RELAYS, verify, parameterSet: REGISTRY, exclusiveDerivedDeployment: true });
    expect(result).toMatchObject({ mode: 'derived', pubkey: REGISTRY_SET.public_key });
  });
  test('an unknown handle with a legacy envelope requires explicit legacy recovery', async () => {
    const key = passkey({ handle: UUID_HANDLE, blob: envelope(legacyRecord('seed')) });
    const transport = relay([]);
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport, relays: RELAYS, verify, parameterSet: REGISTRY });
    expect(result).toMatchObject({ mode: 'error', reason: 'unreadable-record' });
  });
  test('an unknown handle with an older vault blob refuses automatic recovery', async () => {
    const vault = createPasskeyRecord({ accounts: [], activeAccountId: null }, { credentialId: CREDENTIAL, prfSalt: PASSKEY_RECOVERY_PRF_SALT, prf: bytesToBase64(LEGACY_OUTPUT), rpId: RP });
    const key = passkey({ handle: UUID_HANDLE, blob: new TextEncoder().encode(serializePasskeyBackup(vault)) });
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([]), verify, parameterSet: REGISTRY });
    expect(result).toMatchObject({ mode: 'error', reason: 'unreadable-record' });
  });
  test('without a combined assertion, follow-ups use authenticate one input at a time', async () => {
    const key = passkey({ handle: UUID_HANDLE, dropExtensions: true, noAssert: true });
    const result = await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([]), verify, parameterSet: REGISTRY, exclusiveDerivedDeployment: true });
    expect(result).toMatchObject({ mode: 'derived', pubkey: REGISTRY_SET.public_key });
    expect(key.provider.authenticate.mock.calls.map(call => bytesToHex(call[0].prfInput))).toEqual([vectors.stored.prf_input, REGISTRY_SET.prf_input]);
    expect(key.zeroed()).toBe(true);
  });
  test('cancellation rejects and still zeroes what was returned', async () => {
    const key = passkey({ handle: encodeDerivedHandle(DEFAULT) });
    key.provider.assert!.mockRejectedValueOnce(new Error('cancelled'));
    await expect(resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([]), verify, parameterSet: REGISTRY })).rejects.toThrow('cancelled');
    expect(key.zeroed()).toBe(true);
  });
});

describe('restoreRecovery classifies the handle', () => {
  test.each([
    ['a derived passkey', encodeDerivedHandle(DEFAULT), 'derived'],
    ['an unsupported handle', hexToBytes(vectors.handles.find(h => h.description === 'NPK prefix with other version byte')!.handle!), 'newer'],
    ['key-in-handle', KIH_HANDLE, 'Key-in-handle'],
    ['a tagged stored handle', encodeStoredHandle(AUTHOR), 'npk1'],
  ])('refuses %s', async (_name, handle, message) => {
    const key = passkey({ handle });
    await expect(restoreRecovery({ rpId: RP, provider: key.provider, transport: relay([legacyRecord('vault')]), relays: RELAYS, verify })).rejects.toThrow(message);
    expect(key.provider.authenticate).not.toHaveBeenCalled();
  });
  test('accepts a 32-byte handle as bytes and as the older hex shape', async () => {
    for (const discovered of [{ credentialId: CREDENTIAL, userHandle: hexToBytes(AUTHOR) }, { credentialId: CREDENTIAL, pubkey: AUTHOR }]) {
      const key = passkey({});
      key.provider.discover.mockResolvedValueOnce(discovered as never);
      const restored = await restoreRecovery({ rpId: RP, provider: key.provider, transport: relay([legacyRecord('vault')]), relays: RELAYS, verify });
      expect(restored.payload).toEqual(LEGACY_PAYLOAD);
    }
  });
  test('locates an untagged or unconfirmed 32-byte credential by its credential tags', async () => {
    for (const handle of [UUID_HANDLE, sha256(new Uint8Array([2])), undefined]) {
      const key = passkey({ handle });
      const restored = await restoreRecovery({ rpId: RP, provider: key.provider, transport: relay([legacyRecord('private-key')]), relays: RELAYS, verify });
      expect(restored.context).toMatchObject({ scope: 'private-key', pubkey: AUTHOR });
      expect(key.zeroed()).toBe(true);
    }
  });
});

test('unknown nonempty provider data prevents guessing a derived identity', async () => {
 const key = passkey({ handle: UUID_HANDLE, blob: new Uint8Array([1, 2, 3]) });
 expect(await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([]), verify, parameterSet: REGISTRY })).toMatchObject({ mode: 'error', reason: 'unreadable-record' });
});

test('a configured parameter set alone leaves an unknown passkey ambiguous', async () => {
 const key = passkey({ handle: UUID_HANDLE });
 expect(await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([]), verify, parameterSet: REGISTRY })).toMatchObject({ mode: 'ambiguous', pubkey: REGISTRY_SET.public_key });
});
test('an explicitly exclusive derived deployment can ignore unknown provider data', async () => {
 const key = passkey({ handle: UUID_HANDLE, blob: new Uint8Array([1,2,3]) });
 expect(await resolvePasskeyIdentity({ rpId: RP, provider: key.provider, transport: relay([]), verify, parameterSet: REGISTRY, exclusiveDerivedDeployment: true })).toMatchObject({ mode: 'derived', pubkey: REGISTRY_SET.public_key });
});
