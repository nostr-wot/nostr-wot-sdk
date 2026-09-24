import { describe, test, expect } from 'vitest';
import {
  iterationsFor,
  noblePbkdf2,
  encrypt,
  decrypt,
  VAULT_PBKDF2_ITERATIONS,
  LEGACY_VAULT_PBKDF2_ITERATIONS,
} from '../src/crypto.js';

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

  test('each encryption uses a fresh iv', async () => {
    const key = await noblePbkdf2.derive('hunter22', new Uint8Array(16).fill(7), 1000);
    const a = encrypt(key, 'x');
    const b = encrypt(key, 'x');
    expect(a.iv).not.toEqual(b.iv);
  });
});
