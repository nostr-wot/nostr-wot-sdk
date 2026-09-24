/**
 * Sealing and opening a version 1 vault record.
 */
import { describe, test, expect } from 'vitest';
import type { Account } from '@nostr-wot/accounts';
import { sealPayload, openRecord } from '../src/record.js';
import { noblePbkdf2, encrypt } from '../src/crypto.js';
import { base64ToBytes, bytesToBase64 } from '../src/serialization.js';
import { VAULT_SALT_BYTES, VAULT_IV_BYTES } from '../src/constants.js';

const account: Account = {
  id: 'acct_1',
  name: 'Main',
  type: 'generated',
  pubkey: 'ab'.repeat(32),
  privkey: 'cd'.repeat(32),
  mnemonic: `${'abandon '.repeat(23)}art`,
  nip46Config: null,
  readOnly: false,
  createdAt: 1,
  derivationIndex: 0,
  derivationPath: "m/44'/1237'/0'/0/0",
};

/**
 * A stand-in for a hardware accelerated PBKDF2, at a work factor that keeps this file fast.
 * `sealPayload` and `openRecord` must both take the count from the record, so a port that
 * ignores the iterations argument would fail the round trip rather than pass it.
 */
const noblePbkdf2Fast = {
  derive: (password: string, salt: Uint8Array, iterations: number) =>
    noblePbkdf2.derive(password, salt, Math.min(iterations, 1)),
};

const fastKdf = {
  derive: (password: string, salt: Uint8Array, iterations: number) =>
    noblePbkdf2.derive(password, salt, Math.min(iterations, 1)),
};

describe('sealing a record', () => {
  test('a sealed payload opens back to the same accounts', async () => {
    const record = await sealPayload(
      { accounts: [account], activeAccountId: 'acct_1' },
      'hunter22',
      fastKdf,
    );
    expect(record.version).toBe(1);
    const { payload, cacheKeyMinted } = await openRecord(record, 'hunter22', fastKdf);
    expect(payload.accounts[0]).toEqual(account);
    expect(payload.activeAccountId).toBe('acct_1');
    // sealPayload always writes a cacheKey, so reading one back never has to mint one.
    expect(cacheKeyMinted).toBe(false);
  });

  test('the wrong password does not open the record', async () => {
    const record = await sealPayload(
      { accounts: [account], activeAccountId: 'acct_1' },
      'hunter22',
      fastKdf,
    );
    await expect(openRecord(record, 'wrong', fastKdf)).rejects.toThrow();
  });

  test('a record records the work factor it was written with', async () => {
    const strong = await sealPayload({ accounts: [], activeAccountId: null }, 'hunter22', fastKdf);
    const empty = await sealPayload({ accounts: [], activeAccountId: null }, '', fastKdf);
    expect(strong.iterations).toBe(600_000);
    expect(empty.iterations).toBe(210_000);
  });

  test('the envelope carries a fresh 32 byte salt and a fresh 12 byte iv', async () => {
    const a = await sealPayload({ accounts: [], activeAccountId: null }, 'hunter22', fastKdf);
    const b = await sealPayload({ accounts: [], activeAccountId: null }, 'hunter22', fastKdf);
    expect(base64ToBytes(a.salt).length).toBe(VAULT_SALT_BYTES);
    expect(base64ToBytes(a.iv).length).toBe(VAULT_IV_BYTES);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
  });

  /**
   * The extension's `create()` fills in a cache key when the payload has none, so a record it
   * wrote always carries one. Writing records without it would send every extension unlock
   * down the "no cacheKey, re-save immediately" branch.
   */
  test('a payload with no cache key gets a fresh 32 byte one', async () => {
    const record = await sealPayload({ accounts: [], activeAccountId: null }, 'hunter22', fastKdf);
    const { payload } = await openRecord(record, 'hunter22', fastKdf);
    expect(base64ToBytes(payload.cacheKey!).length).toBe(32);
  });

  test('a payload that has a cache key keeps exactly that one', async () => {
    const cacheKey = 'KysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKys=';
    const record = await sealPayload(
      { cacheKey, accounts: [], activeAccountId: null },
      'hunter22',
      fastKdf,
    );
    const opened = await openRecord(record, 'hunter22', fastKdf);
    expect(opened.payload.cacheKey).toBe(cacheKey);
    expect(opened.cacheKeyMinted).toBe(false);
  });

  test('the empty password still encrypts rather than storing plaintext', async () => {
    const record = await sealPayload({ accounts: [account], activeAccountId: null }, '', fastKdf);
    expect(record.ciphertext).not.toContain('abandon');
    expect((await openRecord(record, '', fastKdf)).payload.accounts[0]).toEqual(account);
  });
});

describe('opening a record', () => {
  /**
   * The reason `openRecord` reads the count off the record instead of calling
   * `iterationsFor`: records written before the work factor was raised carry no `iterations`
   * field at all, and were every one of them written at 210000. Recomputing would derive at
   * 600000 and refuse to open exactly the oldest vaults in the field.
   */
  test('a record with no iterations field opens at the legacy count', async () => {
    const sealed = await sealPayload(
      { accounts: [account], activeAccountId: 'acct_1' },
      'hunter22',
      { derive: (p, s) => noblePbkdf2.derive(p, s, 210_000) },
    );
    const { iterations, ...legacy } = sealed;
    expect(iterations).toBe(600_000);
    expect(Object.hasOwn(legacy, 'iterations')).toBe(false);
    const { payload } = await openRecord(legacy, 'hunter22', {
      derive: (p, s, it) => {
        expect(it).toBe(210_000);
        return noblePbkdf2.derive(p, s, it);
      },
    });
    expect(payload.accounts[0]).toEqual(account);
  });

  test('it derives at the count the record names, not the one the password implies', async () => {
    const record = await sealPayload({ accounts: [], activeAccountId: null }, 'hunter22', fastKdf);
    record.iterations = 4242;
    const seen: number[] = [];
    await expect(
      openRecord(record, 'hunter22', {
        derive: (p, s, it) => {
          seen.push(it);
          return noblePbkdf2.derive(p, s, it);
        },
      }),
    ).rejects.toThrow();
    expect(seen).toEqual([4242]);
  });

  test('a tampered ciphertext fails authentication rather than opening', async () => {
    const record = await sealPayload({ accounts: [account], activeAccountId: null }, 'hunter22', fastKdf);
    const bytes = base64ToBytes(record.ciphertext);
    bytes[0] ^= 0xff;
    await expect(
      openRecord({ ...record, ciphertext: Buffer.from(bytes).toString('base64') }, 'hunter22', fastKdf),
    ).rejects.toThrow();
  });

  /**
   * A record whose plaintext genuinely has no `cacheKey` is legal — the field was added after
   * the format shipped. The reader mints one, exactly as the extension's `unlock()` does, so
   * the caller never has to handle an absent cache key.
   *
   * Built by hand rather than with `sealPayload`, which fills the field in: sealing it would
   * have tested nothing.
   */
  test('a decrypted payload with no cache key gets a fresh 32 byte one', async () => {
    const salt = new Uint8Array(32).fill(9);
    const key = await noblePbkdf2.derive('hunter22', salt, 1);
    const { iv, ciphertext } = encrypt(
      key,
      JSON.stringify({ accounts: [account], activeAccountId: 'acct_1' }),
    );
    const record = {
      version: 1,
      iterations: 1,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext),
    };
    const a = await openRecord(record, 'hunter22', noblePbkdf2);
    const b = await openRecord(record, 'hunter22', noblePbkdf2);
    expect(base64ToBytes(a.payload.cacheKey!).length).toBe(32);
    // Fresh, not a constant: the same record read twice must not mint the same key.
    expect(a.payload.cacheKey).not.toBe(b.payload.cacheKey);
    expect(a.payload.accounts[0]).toEqual(account);

    // And the caller is TOLD, so it can re-seal. Without this flag a host mints a different
    // key on every unlock and the private cache written under the previous one silently stops
    // decrypting — no error, just data that never comes back.
    expect(a.cacheKeyMinted).toBe(true);
    expect(b.cacheKeyMinted).toBe(true);

    // Acting on the flag is what makes it stop: re-seal, and the next open is stable.
    const resealed = await sealPayload(a.payload, 'hunter22', noblePbkdf2Fast);
    const after = await openRecord(resealed, 'hunter22', noblePbkdf2Fast);
    expect(after.cacheKeyMinted).toBe(false);
    expect(after.payload.cacheKey).toBe(a.payload.cacheKey);
  });
});
