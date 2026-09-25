/**
 * The golden vector. This is the test that protects people's keys.
 *
 * `test/fixtures/extension-vault-v1.json` was NOT produced by `sealPayload`. It was produced
 * by `scripts/generate-extension-fixture.mjs`, which imports nothing from `src/` and instead
 * reimplements the shipping browser extension's own writer against Node's WebCrypto:
 * `deriveKey` / `encrypt` from `src/services/vault/encryption.ts` and the record assembly from
 * `create()` in `src/services/vault/vault.ts`. Two independent implementations agreeing on the
 * bytes is the only thing that means anything here; a fixture sealed by the code under test
 * would be circular and would stay green through a format change that breaks every vault in
 * the field.
 *
 * Both directions are covered:
 *   - the extension wrote it, we open it       (`openRecord` over the fixture)
 *   - we wrote it, the extension opens it      (`sealPayload` decrypted by WebCrypto directly)
 */
import { describe, test, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Account } from '@nostr-wot/accounts';
import { sealPayload, openRecord } from '../src/record.js';
import { toMemoryAccount, toStorageAccount, base64ToBytes } from '../src/serialization.js';
import { noblePbkdf2 } from '../src/crypto.js';
import type { VaultPayload, VaultRecord } from '../src/types.js';
import {
  VAULT_PBKDF2_ITERATIONS,
  LEGACY_VAULT_PBKDF2_ITERATIONS,
  VAULT_SALT_BYTES,
} from '../src/constants.js';

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

const record = load<VaultRecord>('extension-vault-v1.json');
const legacyRecord = load<VaultRecord>('extension-vault-v1-no-iterations.json');
const expected = load<{ password: string; payload: VaultPayload }>('extension-vault-v1.plaintext.json');
const legacyExpected = load<{ password: string; payload: VaultPayload }>(
  'extension-vault-v1-no-iterations.plaintext.json',
);

/** `src/services/vault/encryption.ts` — `deriveKey`, verbatim, as the reference. */
async function webcryptoDeriveKey(password: string, salt: Uint8Array, iterations: number) {
  const material = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

describe('a vault the extension wrote opens here', () => {
  test('the fixture has the envelope the extension writes', () => {
    expect(record.version).toBe(1);
    expect(record.iterations).toBe(VAULT_PBKDF2_ITERATIONS);
    expect(base64ToBytes(record.salt).length).toBe(VAULT_SALT_BYTES);
    expect(base64ToBytes(record.iv).length).toBe(12);
  });

  test('openRecord reproduces the exact payload, secrets and all', async () => {
    const { payload, cacheKeyMinted } = await openRecord(record, expected.password, noblePbkdf2);
    expect(payload).toEqual(expected.payload);
    // The extension's create() always writes a cacheKey, so reading one back never mints.
    expect(cacheKeyMinted).toBe(false);
  }, 60_000);

  test('the seeded account keeps its mnemonic and the imported one keeps its walletConfig', async () => {
    const { payload } = await openRecord(record, expected.password, noblePbkdf2);
    const [seeded, imported] = payload.accounts;
    expect(seeded!.mnemonic).toBe(expected.payload.accounts[0]!.mnemonic);
    expect(imported!.mnemonic).toBeNull();
    // A field this package does not model, carried through the memory projection untouched.
    expect(toStorageAccount(toMemoryAccount(imported!))).toEqual(imported);
    expect((imported as unknown as { walletConfig: unknown }).walletConfig).toEqual({
      provider: 'nwc',
      connectionString: 'nostr+walletconnect://deadbeef',
    });
  }, 60_000);

  /**
   * The account that carries every secret-bearing field the memory projection converts. The
   * round trip has to be lossless, and the JSON it writes has to be byte for byte what the
   * extension's own `toStorageAccount` writes — reproduced here verbatim, `{ ...rest,
   * privkey, mnemonic, pqKeys }` — so a record saved by either side reads the same to both.
   */
  test('the NIP-46 account with imported post-quantum keys round trips in the order the extension writes', async () => {
    const { payload } = await openRecord(record, expected.password, noblePbkdf2);
    const bunker = payload.accounts.find((account) => account.id === 'acct_bunker')!;
    expect(bunker.type).toBe('nip46');
    expect(bunker.pqKeys).not.toBeNull();
    const mem = toMemoryAccount(bunker);
    const strings: string[] = [];
    JSON.stringify(mem, (_key, value: unknown) => {
      if (typeof value === 'string') strings.push(value);
      return value instanceof Uint8Array ? '<bytes>' : value;
    });
    for (const secret of ['topsecret-token', '5a'.repeat(32), bunker.pqKeys!.kem.secret, bunker.pqKeys!.dsa.secret]) {
      expect(strings.some((text) => text.includes(secret)), `no string holds ${secret}`).toBe(false);
    }
    const back = toStorageAccount(mem);
    expect(back).toEqual(bunker);
    const { privkey, mnemonic, pqKeys, ...rest } = bunker;
    expect(JSON.stringify(back)).toBe(JSON.stringify({ ...rest, privkey, mnemonic, pqKeys }));
  }, 60_000);

  /**
   * The oldest vaults in the field. They predate the `iterations` field entirely and were all
   * written at 210000, so the reader has to fall back to that count rather than recompute from
   * the password — recomputing derives at 600000 and refuses to open them.
   */
  test('a record with no iterations field still opens, at the legacy count', async () => {
    expect(Object.hasOwn(legacyRecord, 'iterations')).toBe(false);
    const { payload } = await openRecord(legacyRecord, legacyExpected.password, noblePbkdf2);
    expect(payload).toEqual(legacyExpected.payload);
  }, 60_000);

  test('deriving at the strong count would not open the legacy record', async () => {
    await expect(
      openRecord({ ...legacyRecord, iterations: VAULT_PBKDF2_ITERATIONS }, legacyExpected.password, noblePbkdf2),
    ).rejects.toThrow();
    expect(LEGACY_VAULT_PBKDF2_ITERATIONS).toBe(210_000);
  }, 60_000);

  test('the wrong password does not open the fixture', async () => {
    await expect(openRecord(record, 'not the password', noblePbkdf2)).rejects.toThrow();
  }, 60_000);
});

describe('a vault written here opens in the extension', () => {
  /**
   * The direction that is easy to leave out. Without it, a change that writes, say, an
   * unpadded or URL-safe base64 salt passes every round trip in this package while every
   * phone-written vault becomes unreadable by the extension, with a green suite.
   */
  test('WebCrypto decrypts and parses a record sealed by sealPayload', async () => {
    const account: Account = {
      id: 'acct_phone',
      name: 'From the phone',
      type: 'generated',
      pubkey: 'ab'.repeat(32),
      privkey: 'cd'.repeat(32),
      mnemonic: `${'abandon '.repeat(23)}art`,
      nip46Config: null,
      readOnly: false,
      createdAt: 1727136000000,
      derivationIndex: 0,
      derivationPath: "m/44'/1237'/0'/0/0",
    };
    const payload: VaultPayload = { accounts: [account], activeAccountId: 'acct_phone' };
    // A fast KDF; the count lands in the record and the reader below honours it, which is the
    // property under test. The KDF itself is already pinned against WebCrypto elsewhere.
    const sealed = await sealPayload(payload, 'hunter22', {
      derive: (p, s, it) => noblePbkdf2.derive(p, s, Math.min(it, 1)),
    });

    // From here on, only the extension's own code path, over the stored record.
    const salt = Uint8Array.from(Buffer.from(sealed.salt, 'base64'));
    const iv = Uint8Array.from(Buffer.from(sealed.iv, 'base64'));
    const ciphertext = Uint8Array.from(Buffer.from(sealed.ciphertext, 'base64'));
    expect(salt.length).toBe(VAULT_SALT_BYTES);
    const key = await webcryptoDeriveKey('hunter22', salt, 1);
    const json = new TextDecoder().decode(
      new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)),
    );
    const parsed = JSON.parse(json) as VaultPayload;

    expect(parsed.accounts).toEqual([account]);
    expect(parsed.activeAccountId).toBe('acct_phone');
    // The extension's create() always leaves a cacheKey behind; ours has to as well, or every
    // unlock in the extension takes the "no cacheKey, re-save right now" branch.
    expect(Buffer.from(parsed.cacheKey!, 'base64').length).toBe(32);
  });

  test('the base64 the extension parses with atob round trips through our codec', async () => {
    const sealed = await sealPayload({ accounts: [], activeAccountId: null }, 'hunter22', {
      derive: (p, s, it) => noblePbkdf2.derive(p, s, Math.min(it, 1)),
    });
    for (const field of [sealed.salt, sealed.iv, sealed.ciphertext]) {
      // btoa/atob speak standard base64 with padding and reject the URL-safe alphabet.
      expect(field).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      expect(Buffer.from(field, 'base64').toString('base64')).toBe(field);
    }
  });
});
