/**
 * The post-quantum message envelope.
 *
 * A self-describing binary payload carrying an ML-KEM-1024 ciphertext and an
 * XChaCha20-Poly1305-sealed message. It is designed to sit anywhere a string fits —
 * in practice, as the `content` of a NIP-17 kind:14 rumor, sealed and gift-wrapped
 * per NIP-59 with no change to either.
 *
 * Design decisions, and why:
 *
 * - **Its own version byte, not NIP-44's.** Overloading NIP-44's version registry
 *   would squat a number the NIP-44 authors own. This envelope is self-describing
 *   and version-prefixed, so it can be adopted, renumbered or superseded without
 *   colliding with anyone.
 *
 * - **Hybrid, never bare.** The ML-KEM shared secret is combined with the classic
 *   NIP-44 conversation key through HKDF. The result is no weaker than either input,
 *   so a break in a comparatively young lattice scheme cannot make messaging *worse*
 *   than it is today. Lattice schemes do break — HAWK, a third-round NIST candidate,
 *   fell in July 2026.
 *
 * - **Everything is authenticated, including the framing.** Version, algorithm and
 *   both party pubkeys go into the AEAD's associated data, so an attacker cannot
 *   splice a valid ciphertext onto a different conversation, downgrade the algorithm
 *   byte, or replay a message as though it came from someone else.
 *
 * - **Length is padded.** Without padding, ciphertext length leaks message length,
 *   which is a real metadata leak on a public relay. We use NIP-44's padding scheme
 *   rather than inventing one, so the leakage profile is identical to what Nostr
 *   already accepts.
 *
 * ## Wire format
 *
 * ```
 * version   1 byte    0x01
 * alg       1 byte    0x01 = ML-KEM-1024 + NIP-44 conversation key, XChaCha20-Poly1305
 * kem_ct    1568      ML-KEM-1024 ciphertext
 * nonce     24        XChaCha20-Poly1305 nonce
 * sealed    variable  AEAD(padded_plaintext), includes the 16-byte tag
 * ```
 *
 * base64-encoded for transport. Overhead is ~2.2 KB per message.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  encapsulate, decapsulate, hybridKey,
  toBase64, fromBase64,
  KEM_PUBLIC_KEY_BYTES,
} from './index.js';

/** Envelope format version. */
export const ENVELOPE_VERSION = 0x01;

/** ML-KEM-1024 + NIP-44 conversation key, sealed with XChaCha20-Poly1305. */
export const ALG_MLKEM1024_XCHACHA = 0x01;

/** ML-KEM-1024 ciphertext length, per FIPS 203. */
export const KEM_CIPHERTEXT_BYTES = 1568;

const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const HEADER_BYTES = 2 + KEM_CIPHERTEXT_BYTES + NONCE_BYTES;

/** Largest plaintext we will encrypt, matching NIP-44's ceiling. */
export const MAX_PLAINTEXT_BYTES = 65535;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface EnvelopeParties {
  /** Sender's secp256k1 x-only pubkey, 64 lowercase hex characters. */
  sender: string;
  /** Recipient's secp256k1 x-only pubkey, 64 lowercase hex characters. */
  recipient: string;
}

/** An x-only pubkey as it appears on the wire: 64 lowercase hex characters. */
const XONLY_HEX = /^[0-9a-f]{64}$/;

/**
 * Reject party pubkeys that are not exactly 64 lowercase hex characters.
 *
 * The associated data joins both pubkeys with `:`, so a party string containing a
 * colon makes distinct conversations produce *identical* associated data: a payload
 * sealed as `{ sender: 'aaaa:bbbb', recipient: 'cccc' }` opens cleanly under
 * `{ sender: 'aaaa', recipient: 'bbbb:cccc' }`. That defeats precisely the binding
 * this envelope advertises — that a ciphertext cannot be replayed into another
 * conversation or have its direction swapped.
 *
 * Real x-only pubkeys are colon-free, so validating rejects nothing a conforming
 * implementation would ever send, and it does not change a single wire byte.
 *
 * Case is checked for a second reason: uppercase hex produces different associated
 * data, so it would interoperate with nothing. Rejecting it turns a message no other
 * client can read into a loud failure at the boundary rather than a silent one.
 */
function assertParties(parties: EnvelopeParties): void {
  if (!XONLY_HEX.test(parties.sender) || !XONLY_HEX.test(parties.recipient)) {
    throw new Error('Invalid party pubkey: expected 64 lowercase hex characters');
  }
}

// ── Padding (NIP-44 scheme) ─────────────────────────────────────────────────

function calcPaddedLen(len: number): number {
  if (len <= 0) throw new Error('Invalid plaintext length');
  if (len <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

function pad(plaintext: Uint8Array): Uint8Array {
  if (plaintext.length === 0) throw new Error('Cannot encrypt an empty message');
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('Message too long');
  const padded = new Uint8Array(2 + calcPaddedLen(plaintext.length));
  new DataView(padded.buffer).setUint16(0, plaintext.length, false);
  padded.set(plaintext, 2);
  return padded;
}

function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < 2) throw new Error('Malformed padding');
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint16(0, false);
  if (len === 0 || len > MAX_PLAINTEXT_BYTES) throw new Error('Malformed padding');
  const out = padded.subarray(2, 2 + len);
  if (out.length !== len) throw new Error('Malformed padding');
  // The declared length must match the padding the sender should have produced.
  if (padded.length !== 2 + calcPaddedLen(len)) throw new Error('Malformed padding');
  return out;
}

// ── Associated data ─────────────────────────────────────────────────────────

/**
 * Bind the framing to the ciphertext.
 *
 * Includes both pubkeys so a ciphertext cannot be replayed into a different
 * conversation, and the algorithm byte so it cannot be silently downgraded.
 */
function associatedData(alg: number, parties: EnvelopeParties, kemCt: Uint8Array): Uint8Array {
  const prefix = encoder.encode(
    `nip-pqc/v1/env:${ENVELOPE_VERSION}:${alg}:${parties.sender}:${parties.recipient}:`,
  );
  const ad = new Uint8Array(prefix.length + kemCt.length);
  ad.set(prefix, 0);
  ad.set(kemCt, prefix.length);
  return ad;
}

// ── Encrypt / decrypt ───────────────────────────────────────────────────────

/**
 * Encrypt a message to a recipient's ML-KEM public key.
 *
 * @param plaintext        the message
 * @param recipientKemKey  recipient's ML-KEM-1024 encapsulation key (from their attestation)
 * @param conversationKey  the classic NIP-44 conversation key for this pair
 * @param parties          both secp256k1 pubkeys, bound into the AEAD
 * @returns base64 envelope, suitable as the content of a kind:14 rumor
 */
export function encryptPq(
  plaintext: string | Uint8Array,
  recipientKemKey: Uint8Array,
  conversationKey: Uint8Array,
  parties: EnvelopeParties,
): string {
  if (recipientKemKey.length !== KEM_PUBLIC_KEY_BYTES) {
    throw new Error('Invalid ML-KEM public key length');
  }
  if (conversationKey.length !== 32) throw new Error('Invalid conversation key');
  assertParties(parties);

  const bytes = typeof plaintext === 'string' ? encoder.encode(plaintext) : plaintext;
  const { cipherText: kemCt, sharedSecret } = encapsulate(recipientKemKey);
  const key = hybridKey(sharedSecret, conversationKey);
  const nonce = randomBytes(NONCE_BYTES);

  try {
    const aead = xchacha20poly1305(key, nonce, associatedData(ALG_MLKEM1024_XCHACHA, parties, kemCt));
    const sealed = aead.encrypt(pad(bytes));

    const out = new Uint8Array(HEADER_BYTES + sealed.length);
    out[0] = ENVELOPE_VERSION;
    out[1] = ALG_MLKEM1024_XCHACHA;
    out.set(kemCt, 2);
    out.set(nonce, 2 + KEM_CIPHERTEXT_BYTES);
    out.set(sealed, HEADER_BYTES);
    return toBase64(out);
  } finally {
    key.fill(0);
    sharedSecret.fill(0);
  }
}

/**
 * Decrypt an envelope with our ML-KEM secret key.
 *
 * Throws a single generic error on any failure. Distinguishing "bad padding" from
 * "bad tag" from "wrong key" would hand an attacker an oracle; a caller that needs
 * to know *why* has a debugging problem, not a protocol one.
 */
export function decryptPq(
  payload: string,
  kemSecretKey: Uint8Array,
  conversationKey: Uint8Array,
  parties: EnvelopeParties,
): string {
  try {
    if (conversationKey.length !== 32) throw new Error('Invalid conversation key');
    assertParties(parties);

    const bytes = fromBase64(payload);
    if (bytes.length < HEADER_BYTES + TAG_BYTES) throw new Error('short');
    if (bytes[0] !== ENVELOPE_VERSION) throw new Error('version');
    if (bytes[1] !== ALG_MLKEM1024_XCHACHA) throw new Error('alg');

    const kemCt = bytes.subarray(2, 2 + KEM_CIPHERTEXT_BYTES);
    const nonce = bytes.subarray(2 + KEM_CIPHERTEXT_BYTES, HEADER_BYTES);
    const sealed = bytes.subarray(HEADER_BYTES);

    const sharedSecret = decapsulate(kemCt, kemSecretKey);
    const key = hybridKey(sharedSecret, conversationKey);
    try {
      const aead = xchacha20poly1305(
        key,
        nonce,
        associatedData(ALG_MLKEM1024_XCHACHA, parties, kemCt),
      );
      return decoder.decode(unpad(aead.decrypt(sealed)));
    } finally {
      key.fill(0);
      sharedSecret.fill(0);
    }
  } catch {
    throw new Error('Decryption failed');
  }
}

/** Cheap check that a string looks like one of our envelopes, before spending work on it. */
export function isPqEnvelope(payload: string): boolean {
  try {
    const bytes = fromBase64(payload);
    return (
      bytes.length >= HEADER_BYTES + TAG_BYTES &&
      bytes[0] === ENVELOPE_VERSION &&
      bytes[1] === ALG_MLKEM1024_XCHACHA
    );
  } catch {
    return false;
  }
}

/** Bytes this envelope adds on top of the plaintext, for capacity planning. */
export const ENVELOPE_OVERHEAD_BYTES = HEADER_BYTES + TAG_BYTES + 2;
