/**
 * Stored records for tagged passkeys: the proposal's `key` vector byte for byte, the seed and vault
 * payloads, AAD binding, author checks, size limits, relay events, saving and no rollback.
 */
import { describe, expect, test, vi } from 'vitest';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import vectors from './fixtures/passkey-key-mode-vectors.json' with { type: 'json' };
import nip06 from '../accounts/fixtures/nip06-vectors.json' with { type: 'json' };
import { bytesToBase64, bytesToHex, hexToBytes } from '../../src/vault/serialization.js';
import { publicKeyFromPrivate } from '../../src/accounts/derivation.js';
import {
  buildStoredRecordEvent, encryptStoredRecord, isStoredRecord, openStoredRecord, openStoredRecords, saveStoredRecord, sealStoredRecord, storedPayloadKeys,
  storedRecordAad, storedSeedKey, validateStoredRecordEvent, STORED_MAX_PLAINTEXT_BYTES, type StoredPayload, type StoredRecordContext, type StoredVault,
} from '../../src/vault/passkey-store.js';

const vector = vectors.stored.records[0];
const VECTOR_CONTEXT: StoredRecordContext = { credentialId: bytesToBase64(hexToBytes(vector.credential_id)), rpId: vector.rp_id, author: vector.author };
const PRF = hexToBytes(vector.prf_output);
const PRIVATE_ONE = hexToBytes(vector.plaintext);
const ENTROPY = bytesToHex(mnemonicToEntropy(nip06.mnemonic, wordlist));
const SEED = { entropy: ENTROPY };
const SEED_AUTHOR = nip06.vectors[0].pubkey;
const context: StoredRecordContext = { credentialId: 'AQIDBA==', rpId: 'example.com', author: SEED_AUTHOR };
const signed = (template: object) => ({ ...template, id: 'cd'.repeat(32), sig: 'ef'.repeat(64) }) as never;
const verify = async () => true;
const pubkeys = (payload: StoredPayload) => storedPayloadKeys(payload).map(key => key.pubkey);
/** Encrypt and open again, as a host restoring from a file would. */
const roundTrip = (payload: StoredPayload, ctx = context) => openStoredRecord(encryptStoredRecord(payload, PRF, ctx), PRF, ctx);

describe('vector', () => {
  test('the key record encrypts with the fixed salt and IV to exactly the vector bytes', () => {
    expect(bytesToHex(storedRecordAad('key', VECTOR_CONTEXT))).toBe(vector.aad);
    expect(bytesToHex(hkdf(sha256, PRF, hexToBytes(vector.hkdf_salt), new TextEncoder().encode(vectors.stored.prf_label), 32))).toBe(vector.aes_key);
    const record = sealStoredRecord(PRIVATE_ONE, PRF, 'key', VECTOR_CONTEXT, hexToBytes(vector.hkdf_salt), hexToBytes(vector.iv));
    expect(bytesToHex(record)).toBe(vector.record);
    expect(record).toHaveLength(vector.record_length);
    expect(bytesToBase64(record)).toBe(vector.record_base64);
    expect(record[4]).toBe(vectors.stored.payload_types.key);
    expect(openStoredRecord(record, PRF, VECTOR_CONTEXT)).toEqual({ type: 'key', key: PRIVATE_ONE });
  });
  test('fresh salt and IV on every encryption', () => {
    const payload: StoredPayload = { type: 'key', key: PRIVATE_ONE };
    const one = encryptStoredRecord(payload, PRF, VECTOR_CONTEXT); const two = encryptStoredRecord(payload, PRF, VECTOR_CONTEXT);
    expect(bytesToHex(one.subarray(5, 49))).not.toBe(bytesToHex(two.subarray(5, 49)));
  });
});

describe('AAD binding', () => {
  const record = hexToBytes(vector.record);
  test.each([
    ['rp', { ...VECTOR_CONTEXT, rpId: 'other.example.com' }],
    ['author', { ...VECTOR_CONTEXT, author: SEED_AUTHOR }],
    ['credential', { ...VECTOR_CONTEXT, credentialId: bytesToBase64(new Uint8Array(16).fill(0xab)) }],
  ])('a different %s fails', (_name, other) => {
    expect(() => openStoredRecord(record, PRF, other)).toThrow();
  });
  test('a different type byte fails rather than being read as another type', () => {
    for (const byte of [0x03, 0x04]) {
      const changed = new Uint8Array(record); changed[4] = byte;
      expect(() => openStoredRecord(changed, PRF, VECTOR_CONTEXT)).toThrow();
    }
  });
  test('a key record of the wrong length is invalid', () => {
    expect(() => openStoredRecord(record.subarray(0, 96), PRF, VECTOR_CONTEXT)).toThrow('Invalid stored record');
    expect(() => sealStoredRecord(new Uint8Array(31), PRF, 'key', VECTOR_CONTEXT)).toThrow();
  });
  test('raw records are told apart from JSON envelopes by their prefix', () => {
    expect(isStoredRecord(record)).toBe(true);
    expect(isStoredRecord(new TextEncoder().encode('{"format":"nostr-wot-passkey-recovery"}'))).toBe(false);
  });
});

describe('payloads', () => {
  test('the seed main account is the NIP-06 vector', () => {
    expect(publicKeyFromPrivate(storedSeedKey(SEED))).toBe(SEED_AUTHOR);
    expect(publicKeyFromPrivate(storedSeedKey({ ...SEED, passphrase: 'extra' }))).not.toBe(SEED_AUTHOR);
  });
  test('seed and vault round trip through a record', () => {
    const vault: StoredVault = { seed: SEED, accounts: [{ kind: 'derived', path: "m/44'/1237'/0'/0/0", label: 'Personal', default: true }, { kind: 'derived', path: "m/44'/1237'/0'/0/3" }, { kind: 'key', secret: vector.plaintext, label: 'Imported' }] };
    for (const payload of [{ type: 'seed', seed: { ...SEED, passphrase: '' } }, { type: 'vault', vault }] as StoredPayload[]) expect(roundTrip(payload)).toEqual(payload);
  });
  test('vault paths derive exactly, under both account layouts', () => {
    // The last-level layout is pinned by the accounts package's NIP-06 fixture.
    const accountLayout = "m/44'/1237'/3'/0/0";
    const vault: StoredVault = { seed: SEED, accounts: [...nip06.vectors.slice(0, 3).map(v => ({ kind: 'derived', path: v.path })), { kind: 'derived', path: accountLayout }] };
    const keys = pubkeys(roundTrip({ type: 'vault', vault }));
    expect(keys.slice(0, 3)).toEqual(nip06.vectors.slice(0, 3).map(v => v.pubkey));
    expect(keys[3]).toBe(publicKeyFromPrivate(storedSeedKey(SEED, accountLayout)));
    expect(nip06.vectors.map(v => v.pubkey)).not.toContain(keys[3]);
  });
  test.each(["m/44'/0'/0'/0/0", "m/84'/1237'/0'/0/0", "m/44'/1237'", "m/44'/1237'/", "m/44h/1237h/0h/0/0", "m/44'/1237'/00'/0/0", "m/44'/1237'/0'/0/2147483648", " m/44'/1237'/0'/0/0", 'm/44\'/1237\'/x', 3])('rejects the path %j', path => {
    expect(() => storedSeedKey(SEED, path as string)).toThrow();
    expect(() => encryptStoredRecord({ type: 'vault', vault: { seed: SEED, accounts: [{ kind: 'derived', path: path as string }] } }, PRF, context)).toThrow();
  });
  test('unknown fields, ext namespaces and account kinds survive a rewrite unchanged', () => {
    const text = JSON.stringify({ seed: SEED, accounts: [{ kind: 'derived', path: "m/44'/1237'/0'/0/0", color: 'blue' }, { kind: 'hardware', device: 'x' }], ext: { 'com.example.app': { theme: 'dark', nested: [1, 2] }, 'org.other': {} }, future: { field: true } });
    const record = sealStoredRecord(new TextEncoder().encode(text), PRF, 'vault', context);
    const opened = openStoredRecord(record, PRF, context);
    const rewritten = openStoredRecord(encryptStoredRecord(opened, PRF, context), PRF, context);
    expect(JSON.stringify((rewritten as { vault: StoredVault }).vault)).toBe(text);
  });
  test.each([
    ['empty accounts', { seed: SEED, accounts: [] }],
    ['a derived account without a seed', { accounts: [{ kind: 'derived', path: "m/44'/1237'/0'/0/0" }] }],
    ['a derived account with only an index', { seed: SEED, accounts: [{ kind: 'derived', index: 0 }] }],
    ['an invalid key', { accounts: [{ kind: 'key', secret: '00'.repeat(32) }] }],
    ['an account with no kind', { accounts: [{ kind: 'key', secret: vector.plaintext }, { label: 'x' }] }],
    ['an ext namespace that is not reverse DNS', { accounts: [{ kind: 'key', secret: vector.plaintext }], ext: { app: {} } }],
    ['a non-string label', { accounts: [{ kind: 'key', secret: vector.plaintext, label: 1 }] }],
    ['two default accounts', { accounts: [{ kind: 'key', secret: vector.plaintext, default: true }, { kind: 'key', secret: vector.plaintext, default: true }] }],
    ['a non-boolean default', { accounts: [{ kind: 'key', secret: vector.plaintext, default: 'yes' }] }],
  ])('rejects a vault with %s', (_name, vault) => {
    const ctx = { ...context, author: publicKeyFromPrivate(PRIVATE_ONE) };
    expect(() => encryptStoredRecord({ type: 'vault', vault: vault as never }, PRF, ctx)).toThrow('Invalid stored payload');
    expect(() => openStoredRecord(sealStoredRecord(new TextEncoder().encode(JSON.stringify(vault)), PRF, 'vault', ctx), PRF, ctx)).toThrow('Invalid stored payload');
  });
  test.each(['', 'ab'.repeat(15), 'ab'.repeat(17), 'AB'.repeat(16), 'ab'.repeat(33)])('rejects seed entropy %j', entropy => {
    expect(() => encryptStoredRecord({ type: 'seed', seed: { entropy } }, PRF, context)).toThrow();
  });
  test('plaintext is limited to 65,536 bytes', () => {
    const ctx = { ...context, author: publicKeyFromPrivate(PRIVATE_ONE) };
    const big = (length: number) => ({ type: 'vault', vault: { accounts: [{ kind: 'key', secret: vector.plaintext, label: 'x'.repeat(length) }] } }) as StoredPayload;
    const overhead = JSON.stringify((big(0) as { vault: StoredVault }).vault).length;
    expect(encryptStoredRecord(big(STORED_MAX_PLAINTEXT_BYTES - overhead), PRF, ctx)).toBeInstanceOf(Uint8Array);
    expect(() => encryptStoredRecord(big(STORED_MAX_PLAINTEXT_BYTES - overhead + 1), PRF, ctx)).toThrow('size');
    expect(() => sealStoredRecord(new Uint8Array(STORED_MAX_PLAINTEXT_BYTES + 1), PRF, 'vault', ctx)).toThrow();
  });
  test('importable keys: unknown kinds are skipped, labels and the default are kept, and the author must be one of them', () => {
    const imported = publicKeyFromPrivate(PRIVATE_ONE);
    expect(pubkeys({ type: 'key', key: PRIVATE_ONE })).toEqual([imported]);
    // A seed promises only its main account.
    expect(pubkeys({ type: 'seed', seed: SEED })).toEqual([SEED_AUTHOR]);
    const vault: StoredVault = { seed: SEED, accounts: [{ kind: 'derived', path: "m/44'/1237'/2'/0/0" }, { kind: 'future', anything: 1 }, { kind: 'key', secret: vector.plaintext, label: 'Imported', default: true }] };
    const keys = storedPayloadKeys({ type: 'vault', vault });
    expect(keys.map(({ pubkey, label, default: isDefault }) => ({ pubkey, label, isDefault }))).toEqual([
      { pubkey: publicKeyFromPrivate(storedSeedKey(SEED, "m/44'/1237'/2'/0/0")), label: undefined, isDefault: false },
      { pubkey: imported, label: 'Imported', isDefault: true },
    ]);
    expect(() => encryptStoredRecord({ type: 'vault', vault }, PRF, context)).toThrow('Author');
    expect(() => encryptStoredRecord({ type: 'seed', seed: SEED }, PRF, { ...context, author: publicKeyFromPrivate(storedSeedKey(SEED, "m/44'/1237'/0'/0/1")) })).toThrow('Author');
    expect(roundTrip({ type: 'vault', vault }, { ...context, author: imported })).toEqual({ type: 'vault', vault });
  });
  test('an author mismatch after decryption is refused before anything is returned', () => {
    // A key record whose AAD names the seed author but holds another key.
    const wrong = sealStoredRecord(PRIVATE_ONE, PRF, 'key', context);
    expect(() => openStoredRecord(wrong, PRF, context)).toThrow('Author');
    expect(() => openStoredRecords([{ record: wrong, author: SEED_AUTHOR, source: 'passkey' }], PRF, context)).toThrow('Author');
  });
  test('a newer record that fails is not rolled back to an older one for a known author', () => {
    const older = { record: encryptStoredRecord({ type: 'seed', seed: SEED }, PRF, context), author: SEED_AUTHOR, source: 'relays' as const };
    const newer = { record: encryptStoredRecord({ type: 'seed', seed: SEED }, new Uint8Array(32).fill(1), context), author: SEED_AUTHOR, source: 'relays' as const };
    expect(openStoredRecords([newer, older], PRF, context)).toBeNull();
    expect(openStoredRecords([older], PRF, context)).toMatchObject({ payload: { type: 'seed' } });
  });
});

describe('relay events', () => {
  const record = encryptStoredRecord({ type: 'seed', seed: SEED }, PRF, context);
  test('tags name the credential, type and format', async () => {
    const template = buildStoredRecordEvent(record, context, 5);
    expect(template).toMatchObject({ kind: 31777, pubkey: SEED_AUTHOR, content: bytesToBase64(record) });
    expect(template.tags).toEqual([['d', 'AQIDBA:seed'], ['credential', 'AQIDBA'], ['v', 'npk1'], ['rp', 'example.com'], ['type', 'seed']]);
    expect(await validateStoredRecordEvent(signed(template), context, verify)).toEqual(record);
  });
  test.each([
    ['a type tag disagreeing with the record', (e: any) => ({ ...e, tags: e.tags.map((t: string[]) => t[0] === 'type' ? ['type', 'vault'] : t) })],
    ['a legacy version tag', (e: any) => ({ ...e, tags: e.tags.map((t: string[]) => t[0] === 'v' ? ['v', '4'] : t) })],
    ['a duplicated tag', (e: any) => ({ ...e, tags: [...e.tags, ['rp', 'example.com']] })],
    ['another author', (e: any) => ({ ...e, pubkey: 'ab'.repeat(32) })],
    ['non-canonical content', (e: any) => ({ ...e, content: `${e.content}\n` })],
    ['content that is not a record', (e: any) => ({ ...e, content: bytesToBase64(new TextEncoder().encode('{"format":"nostr-wot-passkey-recovery"}')) })],
  ])('rejects %s', async (_name, mutate) => {
    await expect(validateStoredRecordEvent(mutate(signed(buildStoredRecordEvent(record, context, 5))), context, verify)).rejects.toThrow();
  });
  test('rejects a bad signature', async () => {
    await expect(validateStoredRecordEvent(signed(buildStoredRecordEvent(record, context, 5)), context, async () => false)).rejects.toThrow('signature');
  });
});

describe('saveStoredRecord', () => {
  const provider = (writeBlob: () => Promise<boolean>) => ({ authenticate: vi.fn(async () => PRF.slice()), discover: vi.fn(), writeBlob: vi.fn(writeBlob) });
  const transport = () => ({ publish: vi.fn(async () => true), query: vi.fn(async () => []) });
  const base = { payload: { type: 'seed', seed: SEED } as StoredPayload, context, relays: ['wss://relay.example.com'], sign: async (event: object) => signed(event), verify };
  test('a confirmed blob write stores the raw record and never contacts relays', async () => {
    const authenticator = provider(async () => true); const relays = transport();
    const saved = await saveStoredRecord({ ...base, provider: authenticator, transport: relays, largeBlobSupported: true });
    expect(saved.destination).toBe('passkey');
    expect(authenticator.writeBlob.mock.calls[0][1]).toEqual(saved.record);
    expect(isStoredRecord(saved.record)).toBe(true);
    expect(bytesToHex(authenticator.authenticate.mock.calls[0][0].prfInput)).toBe(vectors.stored.prf_input);
    expect(relays.publish).not.toHaveBeenCalled();
  });
  test('a refused, failed or unconfirmed blob write is reported, never claimed saved or sent to relays', async () => {
    const relays = transport();
    for (const write of [async () => false, async () => { throw new Error('quota'); }]) {
      await expect(saveStoredRecord({ ...base, provider: provider(write), transport: relays, largeBlobSupported: true, allowRelay: true })).rejects.toThrow();
    }
    expect(relays.publish).not.toHaveBeenCalled();
  });
  test('relays need consent, and the published event validates', async () => {
    const relays = transport();
    await expect(saveStoredRecord({ ...base, provider: provider(async () => true), transport: relays, largeBlobSupported: false })).rejects.toThrow('consent');
    const saved = await saveStoredRecord({ ...base, provider: provider(async () => true), transport: relays, largeBlobSupported: false, allowRelay: true });
    expect(saved).toMatchObject({ destination: 'relays', acceptedRelays: ['wss://relay.example.com'] });
    expect(await validateStoredRecordEvent(saved.event!, context, verify)).toEqual(saved.record);
  });
  test('refuses an author that is not one of the stored keys, and zeroes its PRF output', async () => {
    const output = PRF.slice(); const authenticator = { ...provider(async () => true), authenticate: vi.fn(async () => output) };
    await expect(saveStoredRecord({ ...base, context: { ...context, author: vector.author }, provider: authenticator, transport: transport(), largeBlobSupported: true })).rejects.toThrow('Author');
    expect(authenticator.authenticate).not.toHaveBeenCalled();
    await saveStoredRecord({ ...base, provider: authenticator, transport: transport(), largeBlobSupported: true });
    expect(output.every(byte => byte === 0)).toBe(true);
  });
});
