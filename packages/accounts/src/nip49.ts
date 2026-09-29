/**
 * NIP-49 — Encrypted Private Key (ncryptsec)
 *
 * Spec-compliant v2 format (interoperable with other Nostr apps):
 *   version(0x02, 1B) || log_n(1B) || salt(16B) || nonce(24B) ||
 *   key_security_byte(1B) || ciphertext(48B = 32B key + 16B Poly1305 tag)
 * KDF: scrypt (N = 2^log_n, r = 8, p = 1, dkLen = 32), password NFKC-normalized.
 * Cipher: XChaCha20-Poly1305 with the key_security_byte as AAD.
 *
 * Decoding also accepts the legacy local-only 0x01 format (PBKDF2-SHA256 at 210K
 * iterations + AES-256-GCM: version(1) + salt(16) + iv(12) + ciphertext(48)) so backups
 * exported by older versions of the browser extension still import.
 *
 * Ported from the extension's `src/lib/crypto/nip49.ts` and `src/constants/crypto/nip49.ts`.
 * Every parameter below is copied from there rather than re-read off the NIP: ncryptsecs
 * in the field were written with these, so a difference is a file nobody can open.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/49.md — NIP-49
 */
import { scrypt } from '@noble/hashes/scrypt.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { gcm } from '@noble/ciphers/aes.js';
import { bech32Decode, bech32Encode } from './bech32.js';

export const VERSION_V2 = 0x02;
export const VERSION_LEGACY = 0x01;
/**
 * The scrypt cost the encoder writes and the lowest it accepts: 2^16, 64 MiB, the value the
 * shipping extension writes and the one NIP-49 recommends. A backup is the one artefact of
 * this system that leaves the device and can be guessed at offline for as long as anyone
 * likes, so the cost of a guess is its whole protection. The parameter on `encryptNcryptsec`
 * can raise it and cannot lower it. The DECODER accepts any cost from 1 up, because other
 * clients' backups are theirs to have written weakly and still need to import.
 */
export const DEFAULT_LOG_N = 16;
export const MIN_LOG_N = 16;
export const MAX_LOG_N = 22;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
/**
 * Blocks of headroom added to scrypt's `maxmem` beyond the `N + p` blocks the algorithm needs
 * for its `V` table and `B` block.
 *
 * `@noble/hashes` charges `maxmem` for its own scratch space as well, and says so in its
 * source: "Node requires more headroom here, so this accounting is intentionally
 * noble-specific". That accounting has already moved once. 2.0.1 charged `128·r·(N + p)` and
 * 2.2.0 onwards charges one block more, so a bound sitting exactly on either line is one
 * release away from refusing every key backup this package can write or read.
 *
 * Four blocks is 4 KiB at r = 8, next to a `V` table of N blocks: too little to matter, enough
 * to absorb the next revision. `maxmem` is not the defence against an expensive backup, since
 * it is computed from the cost factor in the payload and so can never reject it; MAX_LOG_N is.
 *
 * From the extension's `c7d0ec8`, "Fix NIP-49 scrypt bounds and guard dependency
 * compatibility".
 */
export const SCRYPT_MAXMEM_SLACK_BLOCKS = 4;
/** key_security_byte 0x02 = "client does not track this data" per NIP-49. */
export const KEY_SECURITY_UNKNOWN = 0x02;
/** 91 bytes. */
export const V2_PAYLOAD_LENGTH = 1 + 1 + 16 + 24 + 1 + 48;
export const LEGACY_PBKDF2_ITERATIONS = 210000;

const PRIVKEY_BYTES = 32;

/**
 * The `maxmem` to hand `@noble/hashes` for a scrypt cost of `2^logN`, in bytes: the `N + p`
 * blocks the algorithm itself needs, plus {@link SCRYPT_MAXMEM_SLACK_BLOCKS} blocks of
 * headroom for the library's own scratch space.
 *
 * The headroom is the whole point, so it is worth being exact about what this number is and
 * is not. It is not a measurement of scrypt's true heap, because noble also allocates PBKDF2
 * and HMAC state it does not charge here. It is a budget chosen to sit above whatever any
 * `@noble/hashes` in the declared range charges against `maxmem`, on the standing assumption
 * that the charge may rise again.
 *
 * It has already risen twice, and this package was caught by both:
 *
 * 1. The bound was once `128·r·(N + p)`, character for character the expression 2.0.1
 *    validates against. 2.2.0 onwards validates against `128·r·(N + p + 1)`, counting a
 *    scratch block it had always allocated, so every `encryptNcryptsec` and
 *    `decryptNcryptsec` threw `"maxmem" limit was hit` on a resolved 2.2.0 or later.
 * 2. The repair was `128·r·(N + p + 1)`, which is 2.4.0's expression, character for
 *    character. It moved the coupling one version along rather than removing it, and it left
 *    exactly zero blocks spare: the next noble that charges one more block breaks every
 *    backup again, and the declared `^2.4.0` admits that release the day it appears.
 *
 * Sitting a few blocks clear of the line, rather than on it, is what stops the next revision
 * doing the same thing. `maxmem` is a compatibility bound, not a safety one: it is derived
 * from the cost factor in the payload, so it can never reject an expensive backup.
 * {@link MAX_LOG_N} is what bounds that.
 *
 * From the extension's `c7d0ec8`, "Fix NIP-49 scrypt bounds and guard dependency
 * compatibility".
 *
 * @see test/scrypt-maxmem.test.ts, which probes the installed library for what it actually
 *      requires instead of restating any version's expression.
 */
export function scryptMaxMem(logN: number): number {
  const blockSize = 128 * SCRYPT_R;
  return blockSize * (2 ** logN + SCRYPT_P + SCRYPT_MAXMEM_SLACK_BLOCKS);
}

function deriveScryptKey(password: string, salt: Uint8Array, logN: number): Uint8Array {
  const passwordBytes = new TextEncoder().encode(password.normalize('NFKC'));
  try {
    return scrypt(passwordBytes, salt, {
      // `2 ** logN`, not `1 << logN`: the same value for every cost this package accepts, but
      // the shift is signed 32-bit and turns negative at logN 31, so the two expressions stop
      // agreeing the moment MAX_LOG_N is raised. scryptMaxMem already uses `2 **`, and a
      // maxmem computed for one N while scrypt runs at another is the bug this whole comment
      // block is about. Same change as the extension's `c7d0ec8`.
      N: 2 ** logN,
      r: SCRYPT_R,
      p: SCRYPT_P,
      dkLen: 32,
      maxmem: scryptMaxMem(logN),
    });
  } catch (cause) {
    // Hosts render `error.message` straight into the UI, so a library's internal message
    // reaches the user as-is: the original form of this bug showed them
    // `"maxmem" limit was hit: memUsed(128*r*(N+p+1))=67110912`. Keep the cause for debugging
    // and say something a person can act on.
    //
    // Deliberately not the wrong-password message. A backup this build cannot stretch at all
    // is a different problem from a password that does not match, and telling someone to
    // retype a password that was right is its own kind of harm. `decodeV2` keeps its
    // wrong-password catch around the AEAD open only, so this passes through it untouched.
    //
    // The wording is the extension's, from `c7d0ec8`, so a host that migrates onto this
    // package shows the string its users have already been shown.
    throw new Error("Could not derive a key from this backup's scrypt parameters", { cause });
  } finally {
    passwordBytes.fill(0);
  }
}

/**
 * Encrypt a private key with a password and encode it as an ncryptsec (NIP-49 v2).
 *
 * `logn` is the scrypt cost exponent, {@link DEFAULT_LOG_N} unless a host chooses to stretch
 * harder; anything below {@link MIN_LOG_N} is refused, because the cost of a guess is the
 * only thing standing between a backup file and the key inside it.
 */
export function encryptNcryptsec(privkey: Uint8Array, password: string, logn: number = DEFAULT_LOG_N): string {
  if (privkey.length !== PRIVKEY_BYTES) throw new Error('Invalid private key length');
  if (!Number.isInteger(logn) || logn < MIN_LOG_N || logn > MAX_LOG_N) {
    throw new Error(`Unsupported scrypt cost factor: log_n must be between ${MIN_LOG_N} and ${MAX_LOG_N}`);
  }

  let key: Uint8Array | null = null;
  try {
    const salt = randomBytes(16);
    const nonce = randomBytes(24);
    key = deriveScryptKey(password, salt, logn);

    const aad = new Uint8Array([KEY_SECURITY_UNKNOWN]);
    const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(privkey);

    const payload = new Uint8Array(V2_PAYLOAD_LENGTH);
    payload[0] = VERSION_V2;
    payload[1] = logn;
    payload.set(salt, 2);
    payload.set(nonce, 18);
    payload[42] = KEY_SECURITY_UNKNOWN;
    payload.set(ciphertext, 43);

    return bech32Encode('ncryptsec', payload);
  } finally {
    key?.fill(0);
  }
}

function decodeV2(payload: Uint8Array, password: string): Uint8Array {
  if (payload.length !== V2_PAYLOAD_LENGTH) throw new Error('Invalid ncryptsec payload length');

  const logN = payload[1]!;
  if (logN < 1 || logN > MAX_LOG_N) throw new Error('Unsupported scrypt cost factor');

  const salt = payload.slice(2, 18);
  const nonce = payload.slice(18, 42);
  const keySecurityByte = payload[42]!;
  const ciphertext = payload.slice(43);

  const key = deriveScryptKey(password, salt, logN);
  try {
    const aad = new Uint8Array([keySecurityByte]);
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    throw new Error('Wrong password or corrupted data');
  } finally {
    key.fill(0);
  }
}

function decodeLegacy(payload: Uint8Array, password: string): Uint8Array {
  const salt = payload.slice(1, 17);
  const iv = payload.slice(17, 29);
  const ciphertext = payload.slice(29);

  // Legacy backups hashed the password bytes as typed, with no NFKC pass. Adding one now
  // would lock every existing backup out, so this stays exactly as the extension wrote it.
  const passwordBytes = new TextEncoder().encode(password);
  const key = pbkdf2(sha256, passwordBytes, salt, { c: LEGACY_PBKDF2_ITERATIONS, dkLen: 32 });
  try {
    return gcm(key, iv).decrypt(ciphertext);
  } catch {
    throw new Error('Wrong password or corrupted data');
  } finally {
    passwordBytes.fill(0);
    key.fill(0);
  }
}

/**
 * Decrypt an ncryptsec string with a password, returning the raw 32-byte private key.
 *
 * Dispatches on the version byte: 0x02 = NIP-49 scrypt/XChaCha20-Poly1305, 0x01 = legacy
 * local PBKDF2/AES-GCM backups. The returned bytes are key material; zero them when done.
 */
export function decryptNcryptsec(payload: string, password: string): Uint8Array {
  const decoded = bech32Decode(payload.trim());
  if (!decoded || decoded.hrp !== 'ncryptsec') throw new Error('Invalid ncryptsec');

  const bytes = decoded.bytes;
  const version = bytes[0];
  if (version === VERSION_V2) return decodeV2(bytes, password);
  if (version === VERSION_LEGACY) return decodeLegacy(bytes, password);
  throw new Error('Unsupported ncryptsec version');
}
