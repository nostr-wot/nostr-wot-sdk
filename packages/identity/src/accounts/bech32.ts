/**
 * NIP-19 bech32 entities, on `@scure/base`.
 *
 * Decoding here always verifies the checksum. That is the whole point: a mistyped npub has
 * to fail loudly, not become an account that can never receive anything.
 *
 * Ported from the extension's `src/lib/crypto/bech32.ts`, minus the nprofile TLV handling,
 * which belongs with the data package rather than with accounts.
 */
import { bech32 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/**
 * Bech32's default 90-character cap predates the payloads Nostr puts through it: an
 * ncryptsec is 91 bytes, which is 146 data characters on its own.
 */
export const BECH32_LIMIT = 5000;

export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  return bech32.encode(hrp, bech32.toWords(bytes), BECH32_LIMIT);
}

/** Null rather than a throw: callers here are classifying untrusted input, not asserting. */
export function bech32Decode(value: string): { hrp: string; bytes: Uint8Array } | null {
  try {
    const decoded = bech32.decode(value as `${string}1${string}`, BECH32_LIMIT);
    return { hrp: decoded.prefix, bytes: bech32.fromWords(decoded.words) };
  } catch {
    return null;
  }
}

/** Decode and require a specific prefix and byte length; null on any failure. */
export function bech32DecodeFixed(value: string, hrp: string, length: number): Uint8Array | null {
  const decoded = bech32Decode(value);
  if (!decoded || decoded.hrp !== hrp || decoded.bytes.length !== length) return null;
  return decoded.bytes;
}

// ── Nostr entities ──

export function npubEncode(pubkey: string | Uint8Array): string {
  const bytes = typeof pubkey === 'string' ? hexToBytes(pubkey) : pubkey;
  if (bytes.length !== 32) throw new Error('Invalid pubkey length');
  return bech32Encode('npub', bytes);
}

export function npubDecode(npub: string): string {
  const bytes = bech32DecodeFixed(npub, 'npub', 32);
  if (!bytes) throw new Error('Invalid npub');
  return bytesToHex(bytes);
}

export function nsecEncode(privkey: string | Uint8Array): string {
  const bytes = typeof privkey === 'string' ? hexToBytes(privkey) : privkey;
  if (bytes.length !== 32) throw new Error('Invalid privkey length');
  return bech32Encode('nsec', bytes);
}

/** Returns the raw bytes; the caller owns them and should zero them when done. */
export function nsecDecode(nsec: string): Uint8Array {
  const bytes = bech32DecodeFixed(nsec, 'nsec', 32);
  if (!bytes) throw new Error('Invalid nsec');
  return bytes;
}
