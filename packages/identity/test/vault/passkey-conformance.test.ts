import { verifyEvent } from 'nostr-tools';
import { HDKey } from '@scure/bip32';
import { expect, test, vi } from 'vitest';
import vectors from './fixtures/passkey-draft-vectors.json' with { type: 'json' };
import { publicKeyFromPrivate } from '../../src/accounts/derivation.js';
import { hexToBytes, bytesToBase64 } from '../../src/vault/serialization.js';
import { encryptStoredRecord, findStoredRecords, openStoredRecord, openStoredRecords, sealStoredRecord, storedPayloadKeys, storedSeedKey, buildStoredRecordEvent, validateStoredRecordEvent, type StoredPayload } from '../../src/vault/passkey-store.js';
const prf = new Uint8Array(32).fill(7);
const secret = '01'.repeat(32);
const context = { credentialId: 'AQIDBA==', rpId: 'example.com', author: publicKeyFromPrivate(hexToBytes(secret)) };
const vault = (updated_at: number): StoredPayload => ({ type: 'vault', vault: { updated_at, accounts: [{ kind: 'key', secret }] } });
for (const v of vectors.stored.records) test(v.description, () => {
  const ctx = { credentialId: bytesToBase64(hexToBytes(v.credential_id)), rpId: v.rp_id, author: v.author };
  expect(openStoredRecord(hexToBytes(v.record), hexToBytes(v.prf_output), ctx).type).toBe(v.payload_type === 1 ? 'key' : 'vault');
});
for (const v of vectors.stored.vault_plaintexts) test(v.description, () => {
  if (typeof v.expect === 'string') {
    expect(() => openStoredRecord(sealStoredRecord(('hex' in v ? hexToBytes(v.hex as string) : new TextEncoder().encode(v.text)), prf, 'vault', context), prf, context)).toThrow();
    return;
  }
  const parsed = JSON.parse(v.text);
  const first = parsed.accounts[v.expect.usable[0]];
  const ctx = { ...context, author: first ? publicKeyFromPrivate(first.kind === 'key' ? hexToBytes(first.secret) : storedSeedKey(parsed.seed, first.path)) : context.author };
  const record = sealStoredRecord(('hex' in v ? hexToBytes(v.hex as string) : new TextEncoder().encode(v.text)), prf, 'vault', ctx);
  if (!first) { expect(() => openStoredRecord(record, prf, ctx)).toThrow('Author'); return; }
  const payload = openStoredRecord(record, prf, ctx);
  expect(payload).toEqual({ type: 'vault', vault: parsed });
  const keys = storedPayloadKeys(payload);
  expect(keys).toHaveLength(v.expect.usable.length);
  expect(keys.findIndex(k => k.default)).toBe(v.expect.usable.indexOf(v.expect.default_index));
  expect(keys.filter(k => k.default)).toHaveLength(1);
});
test('provider vault competes with newest relay vault and lookup uses credential coordinates', async () => {
  const blob = encryptStoredRecord(vault(1), prf, context);
  const record = encryptStoredRecord(vault(2), prf, context);
  const event = { ...buildStoredRecordEvent(record, context, 2), id: 'ab'.repeat(32), sig: 'cd'.repeat(64) };
  const filters: unknown[] = [];
  const candidates = await findStoredRecords({ relays: ['wss://relay.example'], transport: { query: async (_url, filter) => { filters.push(filter); return [event]; }, publish: async () => true } }, { ...context, blob, verify: () => true });
  expect(filters.length).toBeGreaterThan(0);
  expect(filters.every(f => Array.isArray((f as Record<string, unknown>)['#d']))).toBe(true);
  expect(candidates).toHaveLength(2);
  expect(openStoredRecords(candidates, prf, context)?.payload).toEqual(vault(2));
  blob[blob.length - 1] ^= 1;
  expect(openStoredRecords(candidates, prf, context)?.source).toBe('relays');
});

test('new events use the new kind without a v tag and seed writes become vaults', () => {
 const seed = { entropy: '01'.repeat(16) };
 const ctx = { ...context, author: publicKeyFromPrivate(storedSeedKey(seed)) };
 const record = encryptStoredRecord({ type: 'seed', seed }, prf, ctx);
 expect(openStoredRecord(record, prf, ctx)).toEqual({ type: 'vault', vault: { seed, accounts: [{ kind: 'derived', path: "m/44'/1237'/0'/0/0" }] } });
 const event = buildStoredRecordEvent(record, ctx, 1);
 expect(event.kind).toBe(31778);
 expect(event.tags.some(tag => tag[0] === 'v')).toBe(false);
});
test('newest eligible malformed vault prevents rollback, with provider failover', async () => {
 const record = encryptStoredRecord(vault(1), prf, context);
 const older = { ...buildStoredRecordEvent(record, context, 1), id: 'ab'.repeat(32), sig: 'cd'.repeat(64) };
 const newer = { ...older, created_at: 2, content: 'invalid', id: 'ef'.repeat(32) };
 const candidates = await findStoredRecords({ relays: ['wss://relay.example'], transport: { query: async () => [older, newer], publish: async () => true } }, { ...context, verify: () => true });
 expect(openStoredRecords(candidates, prf, context)).toBeNull();
 const failures: unknown[] = [];
 expect(openStoredRecords([{ record, author: context.author, source: 'passkey' }, ...candidates], prf, { ...context, onFailure: failure => failures.push(failure) })?.source).toBe('passkey');
 expect(failures).toHaveLength(1);
});

test('stored derivation refuses a library retry at a different BIP32 index', () => {
 const original = HDKey.prototype.deriveChild;
 const spy = vi.spyOn(HDKey.prototype, 'deriveChild').mockImplementation(function (this: HDKey, index: number) { return original.call(this, index + 1); });
 try { expect(() => storedSeedKey({ entropy: '01'.repeat(16) })).toThrow(); } finally { spy.mockRestore(); }
});
test('an older immutable key may open when a newer key candidate fails', () => {
 const valid = encryptStoredRecord({ type: 'key', key: hexToBytes(secret) }, prf, context);
 const invalid = valid.slice(); invalid[invalid.length - 1] ^= 1;
 expect(openStoredRecords([{ record: invalid, author: context.author, source: 'relays' }, { record: valid, author: context.author, source: 'relays' }], prf, context)?.payload.type).toBe('key');
});

test('malformed provider NPK data is retained and reported alongside a usable relay', async () => {
 const record = encryptStoredRecord(vault(1), prf, context);
 const event = { ...buildStoredRecordEvent(record, context, 1), id: 'ab'.repeat(32), sig: 'cd'.repeat(64) };
 const candidates = await findStoredRecords({ relays: ['wss://relay.example'], transport: { query: async () => [event], publish: async () => true } }, { ...context, blob: new Uint8Array([78,80,75,1,3]), verify: () => true });
 const failures: unknown[] = [];
 expect(openStoredRecords(candidates, prf, { ...context, onFailure: f => failures.push(f) })?.source).toBe('relays');
 expect(failures).toHaveLength(1);
});
test('direct candidates cannot roll back a malformed latest vault event', () => {
 const record = encryptStoredRecord(vault(1), prf, context);
 const event = { ...buildStoredRecordEvent(record, context, 2), id: 'ab'.repeat(32), sig: 'cd'.repeat(64) };
 expect(openStoredRecords([{ record: new Uint8Array(), author: context.author, source: 'relays', event }, { record, author: context.author, source: 'relays', event: { ...event, created_at: 1 } }], prf, context)).toBeNull();
});

test('the exact shared signed relay vector validates with its minimal d and rp tags', async () => {
 const vector = vectors.stored.records[0];
 const ctx = { credentialId: bytesToBase64(hexToBytes(vector.credential_id)), rpId: vector.rp_id, author: vector.author };
 expect(await validateStoredRecordEvent(vectors.relay.signed_event.event, ctx, verifyEvent)).toEqual(hexToBytes(vector.record));
});
test('earlier npk1 seed events remain readable but cannot be published on the new kind', async () => {
 const seed = { entropy: '01'.repeat(16) };
 const ctx = { ...context, author: publicKeyFromPrivate(storedSeedKey(seed)) };
 const record = sealStoredRecord(new TextEncoder().encode(JSON.stringify(seed)), prf, 'seed', ctx);
 const event = { kind: 31777, pubkey: ctx.author, created_at: 1, id: 'ab'.repeat(32), sig: 'cd'.repeat(64), content: bytesToBase64(record), tags: [['d','AQIDBA:seed'], ['credential','AQIDBA'], ['v','npk1'], ['rp',ctx.rpId], ['type','seed']] };
 expect(await validateStoredRecordEvent(event, ctx, () => true)).toEqual(record);
 expect(openStoredRecord(record, prf, ctx)).toEqual({ type: 'seed', seed });
 expect(() => buildStoredRecordEvent(record, ctx, 1)).toThrow('vault');
});
