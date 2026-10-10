import { describe, expect, test } from 'vitest';
import { webcrypto } from 'node:crypto';
import { MemoryStore } from '@nostr-wot/storage';
import { Vault } from '../src/vault.js';
import { VAULT_STORAGE_KEY } from '../src/constants.js';
import { openRecord, sealPayload } from '../src/record.js';
import { encrypt, noblePbkdf2 } from '../src/crypto.js';
import { bytesToBase64, base64ToBytes } from '../src/serialization.js';
import {
  createPasskeyRecord,
  openPasskeyRecord,
  parsePasskeyBackup,
  serializePasskeyBackup,
  sealPasskeyPayload,
  withPasskeyVaultKey,
  wrapVaultKey,
  unwrapVaultKey,
  validatePasskeyRecord,
  PASSKEY_KDF_CONTEXT,
  PASSKEY_RP_ID,
} from '../src/passkey.js';
import type { Account } from '@nostr-wot/accounts';
import type { VaultRecord } from '../src/types.js';

const b64 = (byte: number, length = 32) => bytesToBase64(new Uint8Array(length).fill(byte));
const input = { credentialId: b64(1, 16), prfSalt: b64(2), prf: b64(3) };
const second = { credentialId: b64(4, 16), prfSalt: b64(5), prf: b64(6) };
const account: Account = {
  id: 'one',
  name: 'One',
  type: 'nsec',
  pubkey: 'ab'.repeat(32),
  privkey: 'cd'.repeat(32),
  mnemonic: null,
  nip46Config: null,
  readOnly: false,
  createdAt: 1,
};
const payload = { accounts: [account], activeAccountId: 'one', cacheKey: b64(7) };
const kdf = {
  derive: (password: string, salt: Uint8Array) => noblePbkdf2.derive(password, salt, 1),
};

describe('portable passkey records', () => {
  test('create, unlock, re-seal, add enrollment and recover preserve payload and cache key', async () => {
    const original = createPasskeyRecord(payload, input);
    expect((await openPasskeyRecord(original, input)).payload).toEqual(payload);
    const next = await withPasskeyVaultKey(original, input, (key) =>
      sealPasskeyPayload(payload, key, {
        rpId: PASSKEY_RP_ID,
        passkeys: [...original.passkeys, wrapVaultKey(key, second)],
      }),
    );
    expect(next.iv).not.toBe(original.iv);
    const backup = parsePasskeyBackup(serializePasskeyBackup(next));
    expect((await openPasskeyRecord(backup, second)).payload).toEqual(payload);
    expect(JSON.stringify(backup)).not.toContain('"prf":');
    expect(original.passkeys).toHaveLength(1);
  });

  test('WebCrypto and portable wrapping interoperate in both directions with bound metadata', async () => {
    const raw = new Uint8Array(32).fill(9);
    const material = await webcrypto.subtle.importKey(
      'raw',
      base64ToBytes(input.prf),
      'HKDF',
      false,
      ['deriveKey'],
    );
    const key = await webcrypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: base64ToBytes(input.prfSalt),
        info: new TextEncoder().encode(PASSKEY_KDF_CONTEXT),
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const additionalData = new TextEncoder().encode(
      JSON.stringify([PASSKEY_KDF_CONTEXT, PASSKEY_RP_ID, input.credentialId, input.prfSalt]),
    );
    const wrapper = wrapVaultKey(raw, input);
    expect(
      new Uint8Array(
        await webcrypto.subtle.decrypt(
          { name: 'AES-GCM', iv: base64ToBytes(wrapper.iv), additionalData },
          key,
          base64ToBytes(wrapper.ciphertext),
        ),
      ),
    ).toEqual(raw);
    const iv = new Uint8Array(12).fill(8);
    const ciphertext = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData },
      key,
      raw,
    );
    expect(
      unwrapVaultKey(
        {
          ...wrapper,
          iv: bytesToBase64(iv),
          ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
        },
        input,
      ),
    ).toEqual(raw);
    expect(() =>
      unwrapVaultKey(
        { ...wrapper, credentialId: second.credentialId },
        { ...input, credentialId: second.credentialId },
      ),
    ).toThrow();
  });

  test('rejects mismatched proofs, malformed records, duplicate wrappers and wrong RP', async () => {
    const record = createPasskeyRecord(payload, input);
    await expect(openPasskeyRecord(record, second)).rejects.toThrow();
    await expect(openPasskeyRecord(record, { ...input, prf: b64(99) })).rejects.toThrow();
    for (const changed of [
      { version: 3 },
      { rpId: 'example.com' },
      { passkeys: [record.passkeys[0], record.passkeys[0]] },
      { iv: 'AAAA' },
      { protection: 'other' },
    ]) {
      expect(() => validatePasskeyRecord({ ...record, ...changed })).toThrow();
    }
    expect(() => parsePasskeyBackup(JSON.stringify({ format: 'other', vault: record }))).toThrow();
    await expect(openRecord(record as unknown as VaultRecord, '', kdf)).rejects.toThrow(
      'Unsupported',
    );
    const password = await sealPayload(payload, '', kdf);
    await expect(
      openRecord({ ...password, protection: 'future' } as VaultRecord, '', kdf),
    ).rejects.toThrow('Unsupported');
  });

  test('missing legacy cache keys must be persisted and then stay stable', async () => {
    const original = createPasskeyRecord(payload, input);
    const legacy = await withPasskeyVaultKey(original, input, (key) => {
      const { iv, ciphertext } = encrypt(
        key,
        JSON.stringify({ accounts: payload.accounts, activeAccountId: payload.activeAccountId }),
      );
      return { ...original, iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) };
    });
    const opened = await openPasskeyRecord(legacy, input);
    expect(opened.cacheKeyMinted).toBe(true);
    const saved = await withPasskeyVaultKey(legacy, input, (key) =>
      sealPasskeyPayload(opened.payload, key, legacy),
    );
    expect(await openPasskeyRecord(saved, input)).toEqual({
      payload: opened.payload,
      cacheKeyMinted: false,
    });
    const corrupted = { ...saved, ciphertext: b64(0, base64ToBytes(saved.ciphertext).length) };
    await expect(openPasskeyRecord(corrupted, input)).rejects.toThrow();
  });

  test('scoped keys are zeroed after success and error, and caller-owned inputs survive', async () => {
    const record = createPasskeyRecord(payload, input);
    let copy: Uint8Array | undefined;
    await withPasskeyVaultKey(record, input, (key) => {
      copy = key;
    });
    expect(copy).toEqual(new Uint8Array(32));
    await expect(
      withPasskeyVaultKey(record, input, (key) => {
        copy = key;
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(copy).toEqual(new Uint8Array(32));
    expect(input.prf).toBe(b64(3));
  });

  test('password saves and password changes retain enrolled wrappers', async () => {
    const store = new MemoryStore();
    const enrollment = createPasskeyRecord(payload, input);
    const record = await sealPayload(payload, 'password1', kdf);
    record.registeredPasskeys = { rpId: enrollment.rpId, passkeys: enrollment.passkeys };
    await store.set(VAULT_STORAGE_KEY, record);
    const vault = new Vault({ store, kdf });
    expect(await vault.unlock('password1')).toBe(true);
    await vault.addAccount({ ...account, id: 'two' });
    expect((await store.get<VaultRecord>(VAULT_STORAGE_KEY))?.registeredPasskeys).toEqual(
      record.registeredPasskeys,
    );
    await vault.changePassword('password1', 'password2');
    expect((await store.get<VaultRecord>(VAULT_STORAGE_KEY))?.registeredPasskeys).toEqual(
      record.registeredPasskeys,
    );
    vault.lock();
  });
});

describe('host account lifecycle', () => {
  test('removal explanations expose only seed relationships, including canonical paths', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf });
    await vault.create('', [account]);
    expect(vault.getAccountRemovalInfo('one')).toEqual({
      reason: 'key',
      relatedCount: 0,
    });
    await vault.addAccount({
      ...account,
      id: 'main',
      mnemonic: 'seed',
      derivationPath: "m/44'/1237'/0'/0/0",
    });
    expect(vault.getAccountRemovalInfo('main')).toEqual({
      reason: 'only-seed',
      relatedCount: 0,
    });
    await vault.addAccount({ ...account, id: 'child', mnemonic: 'seed', derivationIndex: 1 });
    expect(vault.getAccountRemovalInfo('main')).toEqual({
      reason: 'main-seed',
      relatedCount: 1,
    });
    expect(vault.getAccountRemovalInfo('child')).toEqual({
      reason: 'derived-seed',
      relatedCount: 1,
    });
    await vault.removeAccount('main');
    await vault.addAccount({ ...account, id: 'sibling', mnemonic: 'seed', derivationIndex: 2 });
    expect(vault.getAccountRemovalInfo('child')).toEqual({
      reason: 'sibling-seed',
      relatedCount: 1,
    });
    vault.lock();
    expect(() => vault.getAccountRemovalInfo('main')).toThrow('locked');
  });

  test('clearActiveAccount is memory-only and revokes in-flight capabilities', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf });
    await vault.create('', [account]);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scope = vault.withCacheKey(async (key) => {
      await wait;
      return key.slice();
    });
    vault.clearActiveAccount();
    expect(vault.getActiveAccountId()).toBeNull();
    release();
    await expect(scope).rejects.toThrow();
    vault.lock();
    await vault.unlock('');
    expect(vault.getActiveAccountId()).toBe('one');
    vault.lock();
    expect(() => vault.clearActiveAccount()).not.toThrow();
  });

  test('clearing selection during a mutation read rolls back without retaining a zeroed account', async () => {
    class PausingStore extends MemoryStore {
      pause = false;
      entered!: () => void;
      release!: () => void;
      async get<T>(key: string): Promise<T | undefined> {
        if (this.pause && key === VAULT_STORAGE_KEY) {
          this.pause = false;
          this.entered();
          await new Promise<void>((resolve) => {
            this.release = resolve;
          });
        }
        return super.get<T>(key);
      }
    }
    const store = new PausingStore();
    const vault = new Vault({ store, kdf });
    await vault.create('', [account]);
    const entered = new Promise<void>((resolve) => {
      store.entered = resolve;
    });
    store.pause = true;
    const adding = vault.addAccount({ ...account, id: 'two' });
    await entered;
    vault.clearActiveAccount();
    store.release();
    await expect(adding).rejects.toThrow('session changed');
    expect(vault.listAccounts().map((a) => a.id)).toEqual(['one']);
    expect(vault.getActiveAccountId()).toBeNull();
    await expect(vault.withPrivkey('one', async (key) => bytesToBase64(key))).resolves.toBe(
      bytesToBase64(new Uint8Array(32).fill(0xcd)),
    );
    vault.lock();
  });

  test('empty cleanup waits for independent listeners and is idempotent across concurrent calls', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf });
    await vault.create('', []);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    vault.onDestroy(async () => {
      calls.push('first');
      entered();
      await wait;
      throw new Error('cleanup failed');
    });
    vault.onDestroy(async () => {
      calls.push('second');
    });
    let settled = false;
    const first = vault.destroyIfEmpty().then((result) => {
      settled = true;
      return result;
    });
    const second = vault.destroyIfEmpty();
    await started;
    expect(settled).toBe(false);
    expect(vault.isLocked()).toBe(true);
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(calls).toEqual(['first', 'second']);
    expect(await vault.exists()).toBe(false);
  });

  test('empty cleanup requires authenticated empty state and runs after queued mutations', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf });
    await vault.create('', [account]);
    expect(await vault.destroyIfEmpty()).toBe(false);
    await vault.removeAccount('one');
    vault.lock();
    expect(await vault.destroyIfEmpty()).toBe(false);
    await vault.unlock('');
    const adding = vault.addAccount(account);
    const cleanup = vault.destroyIfEmpty();
    await adding;
    expect(await cleanup).toBe(false);
    const removing = vault.removeAccount('one');
    const deleting = vault.destroyIfEmpty();
    await removing;
    expect(await deleting).toBe(true);
    expect(vault.isLocked()).toBe(true);
    expect(await vault.exists()).toBe(false);
  });
});
