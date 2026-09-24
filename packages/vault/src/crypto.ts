/**
 * Vault cryptography: PBKDF2-HMAC-SHA-256 key derivation and AES-256-GCM, in pure JavaScript.
 *
 * Every byte here matches what the browser extension's WebCrypto implementation produces and
 * consumes, because the vaults users already have were written by it. Nothing in this module
 * touches `crypto.subtle`, a DOM global or a UI framework, so the same code runs in an
 * extension, in a React Native app and in a Node test.
 */
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import {
  VAULT_PBKDF2_ITERATIONS,
  LEGACY_VAULT_PBKDF2_ITERATIONS,
  VAULT_IV_BYTES,
  VAULT_KEY_BYTES,
} from './constants.js';

// Re-exported so a caller that reaches for the crypto module gets the work factors with it.
export { VAULT_PBKDF2_ITERATIONS, LEGACY_VAULT_PBKDF2_ITERATIONS } from './constants.js';

/**
 * How hard to stretch a given password.
 *
 * The empty password means a "never lock" vault, whose password the source code supplies in
 * public — see {@link LEGACY_VAULT_PBKDF2_ITERATIONS} for why stretching it buys nothing.
 */
export function iterationsFor(password: string): number {
  return password.length > 0 ? VAULT_PBKDF2_ITERATIONS : LEGACY_VAULT_PBKDF2_ITERATIONS;
}

/**
 * Password stretching, as a port.
 *
 * Pure JavaScript PBKDF2 at 600000 iterations costs roughly a second on a phone. The default
 * implementation is pure JavaScript so this package works everywhere with no native
 * dependency; a host that has a hardware accelerated PBKDF2 can inject it instead. It is not
 * on the common unlock path, which uses the hardware wrapped key rather than the password.
 */
export interface Pbkdf2Port {
  derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array>;
}

/** The default {@link Pbkdf2Port}: pure JavaScript, no native dependency anywhere. */
export const noblePbkdf2: Pbkdf2Port = {
  async derive(password, salt, iterations) {
    return pbkdf2Async(sha256, new TextEncoder().encode(password), salt, {
      c: iterations,
      dkLen: VAULT_KEY_BYTES,
    });
  },
};

/**
 * Encrypt with AES-256-GCM under a fresh random IV.
 *
 * `ciphertext` carries the 16-byte authentication tag appended, which is the layout WebCrypto
 * returns and expects.
 */
export function encrypt(
  key: Uint8Array,
  plaintext: string,
): { iv: Uint8Array; ciphertext: Uint8Array } {
  const iv = randomBytes(VAULT_IV_BYTES);
  return { iv, ciphertext: gcm(key, iv).encrypt(new TextEncoder().encode(plaintext)) };
}

/**
 * Decrypt an AES-256-GCM payload.
 *
 * Throws when the tag does not authenticate — a wrong key fails loudly rather than returning
 * plausible garbage.
 */
export function decrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): string {
  return new TextDecoder().decode(gcm(key, iv).decrypt(ciphertext));
}
