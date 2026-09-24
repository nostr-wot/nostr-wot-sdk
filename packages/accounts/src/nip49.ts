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
/** key_security_byte 0x02 = "client does not track this data" per NIP-49. */
export const KEY_SECURITY_UNKNOWN = 0x02;
/** 91 bytes. */
export const V2_PAYLOAD_LENGTH = 1 + 1 + 16 + 24 + 1 + 48;
export const LEGACY_PBKDF2_ITERATIONS = 210000;

const PRIVKEY_BYTES = 32;

function deriveScryptKey(password: string, salt: Uint8Array, logN: number): Uint8Array {
  const passwordBytes = new TextEncoder().encode(password.normalize('NFKC'));
  try {
    return scrypt(passwordBytes, salt, {
      N: 1 << logN,
      r: SCRYPT_R,
      p: SCRYPT_P,
      dkLen: 32,
      maxmem: 128 * SCRYPT_R * ((1 << logN) + SCRYPT_P),
    });
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
