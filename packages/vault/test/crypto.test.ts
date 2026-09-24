import { describe, test, expect } from 'vitest';
import {
  iterationsFor,
  noblePbkdf2,
  encrypt,
  decrypt,
  VAULT_PBKDF2_ITERATIONS,
  LEGACY_VAULT_PBKDF2_ITERATIONS,
} from '../src/crypto.js';
import {
  VAULT_VERSION,
  MIN_PASSWORD_LENGTH,
  VAULT_KEY_BYTES,
  VAULT_SALT_BYTES,
  VAULT_IV_BYTES,
} from '../src/constants.js';

describe('vault format version 1 constants', () => {
  /**
   * Asserted against literals on purpose. Comparing `iterationsFor(x)` to the constant it
   * returns is tautological: it stays green while the constant changes underneath it and every
   * vault in the field stops unlocking. These are wire-format values, not tunables, so a change
   * to one has to fail the build.
   */
  test('the format constants are pinned to their literal values', () => {
    expect(VAULT_VERSION).toBe(1);
    expect(VAULT_PBKDF2_ITERATIONS).toBe(600000);
    expect(LEGACY_VAULT_PBKDF2_ITERATIONS).toBe(210000);
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(VAULT_KEY_BYTES).toBe(32);
    expect(VAULT_SALT_BYTES).toBe(32);
    expect(VAULT_IV_BYTES).toBe(12);
  });
});

describe('vault crypto', () => {
  test('the empty password uses the legacy work factor and a real one does not', () => {
    expect(iterationsFor('')).toBe(LEGACY_VAULT_PBKDF2_ITERATIONS);
    expect(iterationsFor('hunter22')).toBe(VAULT_PBKDF2_ITERATIONS);
  });

  test('encrypt then decrypt returns the plaintext', async () => {
    const key = await noblePbkdf2.derive('hunter22', new Uint8Array(16).fill(7), 1000);
    const { iv, ciphertext } = encrypt(key, 'the seed words');
    expect(decrypt(key, iv, ciphertext)).toBe('the seed words');
  });

  test('a wrong key fails authentication rather than returning garbage', async () => {
    const good = await noblePbkdf2.derive('hunter22', new Uint8Array(16).fill(7), 1000);
    const bad = await noblePbkdf2.derive('hunter23', new Uint8Array(16).fill(7), 1000);
    const { iv, ciphertext } = encrypt(good, 'the seed words');
    expect(() => decrypt(bad, iv, ciphertext)).toThrow();
  });

  /**
   * noble accepts 16, 24 and 32 byte AES keys, so a short key silently downgrades the vault to
   * AES-128 and reports success. `Pbkdf2Port` is an injection seam for a third-party
   * implementation, and nothing else checks what that implementation returns.
   */
  test('a key that is not 256 bits is rejected by encrypt', () => {
    expect(() => encrypt(new Uint8Array(16).fill(1), 'x')).toThrow(/256/);
    expect(() => encrypt(new Uint8Array(24).fill(1), 'x')).toThrow(/256/);
  });

  test('a key that is not 256 bits is rejected by decrypt', async () => {
    const key = await noblePbkdf2.derive('hunter22', new Uint8Array(16).fill(7), 1000);
    const { iv, ciphertext } = encrypt(key, 'the seed words');
    expect(() => decrypt(new Uint8Array(16).fill(1), iv, ciphertext)).toThrow(/256/);
    expect(() => decrypt(new Uint8Array(24).fill(1), iv, ciphertext)).toThrow(/256/);
  });

  test('each encryption uses a fresh iv', async () => {
    const key = await noblePbkdf2.derive('hunter22', new Uint8Array(16).fill(7), 1000);
    const a = encrypt(key, 'x');
    const b = encrypt(key, 'x');
    expect(a.iv).not.toEqual(b.iv);
  });
});
