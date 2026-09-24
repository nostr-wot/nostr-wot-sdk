/**
 * Vault cryptography: PBKDF2-HMAC-SHA-256 key derivation and AES-256-GCM, in pure JavaScript.
 *
 * Every byte here matches what the browser extension's WebCrypto implementation produces and
 * consumes, because the vaults users already have were written by it. Nothing in this module
 * touches WebCrypto's `SubtleCrypto`, a DOM global or a UI framework, so the same code runs in
 * an extension, in a React Native app and in a Node test.
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
  /**
   * Derive a {@link VAULT_KEY_BYTES}-byte key.
   *
   * **The caller takes ownership of the returned buffer and will zero it** once it is finished
   * with it — `sealPayload` and `openRecord` both do, in a `finally`, because a derived vault
   * key left on the heap is the thing this whole module exists to avoid. An implementation must
   * therefore hand back a buffer it does not retain: allocate a fresh one per call, and never
   * return a cached, pooled or shared array, or a view into one. The default
   * {@link noblePbkdf2} allocates fresh through `pbkdf2Async`.
   */
  derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array>;
}

/**
 * Reject anything that is not a 256-bit key.
 *
 * noble's own check accepts 16, 24 and 32 bytes, because those are all valid AES key sizes. For
 * this vault they are not: a 16-byte key silently produces AES-128-GCM and reports success.
 * That matters because {@link Pbkdf2Port} is an injection seam for a third-party implementation
 * and nothing else inspects what that implementation returns, so a host whose native PBKDF2 uses
 * a 16-byte dkLen would write AES-128 vaults with no error anywhere.
 */
function assertVaultKey(key: Uint8Array): Uint8Array {
  if (key.length !== VAULT_KEY_BYTES) {
    throw new Error(
      `vault key must be ${VAULT_KEY_BYTES} bytes (256 bits) for AES-256-GCM, got ${key.length}`,
    );
  }
  return key;
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
 *
 * Throws unless `key` is exactly {@link VAULT_KEY_BYTES} long — see {@link assertVaultKey}.
 *
 * The caller owns the lifetime of `key` and of `plaintext`. This package cannot zero either: a
 * JavaScript string is immutable and unreachable to overwrite, and the key array belongs to
 * whoever derived it. Keep both alive for as short a time as the host allows, and zero the key
 * bytes yourself when done.
 */
export function encrypt(
  key: Uint8Array,
  plaintext: string,
): { iv: Uint8Array; ciphertext: Uint8Array } {
  assertVaultKey(key);
  const iv = randomBytes(VAULT_IV_BYTES);
  return { iv, ciphertext: gcm(key, iv).encrypt(new TextEncoder().encode(plaintext)) };
}

/**
 * Decrypt an AES-256-GCM payload.
 *
 * Throws when the tag does not authenticate — a wrong key fails loudly rather than returning
 * plausible garbage — and unless `key` is exactly {@link VAULT_KEY_BYTES} long.
 *
 * The caller owns the lifetime of `key` and of the returned plaintext. This package cannot zero
 * the returned string: JavaScript strings are immutable, so the secret stays readable in the
 * heap until the garbage collector happens to reclaim it. Hand it straight to whatever consumes
 * it and do not stash it.
 */
export function decrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): string {
  assertVaultKey(key);
  return new TextDecoder().decode(gcm(key, iv).decrypt(ciphertext));
}
