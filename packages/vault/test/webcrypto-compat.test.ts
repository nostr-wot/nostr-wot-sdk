/**
 * The test that protects existing users.
 *
 * The shipping browser extension wrote its vaults with WebCrypto. This package has to read
 * those exact bytes while running somewhere that has no `crypto.subtle` at all. Both
 * directions are checked here: that our PBKDF2 derives the identical key WebCrypto derives,
 * and that our AES-GCM decrypts a ciphertext WebCrypto produced.
 *
 * `node:crypto`'s `webcrypto` is used only as the reference implementation under test. The
 * package source never touches it.
 */
import { describe, test, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { noblePbkdf2, encrypt, decrypt } from '../src/crypto.js';

describe('WebCrypto compatibility', () => {
  test('the noble key matches what WebCrypto PBKDF2 derives', async () => {
    const salt = new Uint8Array(16).fill(3);
    const material = await webcrypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('hunter22'),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const expected = new Uint8Array(
      await webcrypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-256' },
        material,
        256,
      ),
    );
    expect(await noblePbkdf2.derive('hunter22', salt, 1000)).toEqual(expected);
  });

  test('noble decrypts a payload WebCrypto AES-GCM produced', async () => {
    const raw = new Uint8Array(32).fill(9);
    const key = await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const iv = new Uint8Array(12).fill(5);
    const ct = new Uint8Array(
      await webcrypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode('existing vault'),
      ),
    );
    expect(decrypt(raw, iv, ct)).toBe('existing vault');
  });

  /**
   * The other direction, and the one that is easy to leave out: a vault written on the phone
   * has to open in the shipping extension. Without this, changing `encrypt` to prepend the GCM
   * tag rather than append it passes the noble-to-noble roundtrip and passes the test above,
   * and every phone-written vault becomes unreadable by the extension with a green suite.
   */
  test('WebCrypto AES-GCM decrypts a payload noble produced', async () => {
    const raw = new Uint8Array(32).fill(9);
    const { iv, ciphertext } = encrypt(raw, 'phone written vault');
    const key = await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const plaintext = new Uint8Array(
      await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext),
    );
    expect(new TextDecoder().decode(plaintext)).toBe('phone written vault');
  });
});
