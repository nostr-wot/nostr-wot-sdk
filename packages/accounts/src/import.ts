/**
 * Classify pasted key material into something an account can be built from.
 *
 * Two functions, deliberately, because the two callers want opposite things:
 *
 * - {@link parseImportInput} validates. Returning an `ImportInput` is a claim the material is
 *   usable, so the checksum holds, the scalar is on the curve and the payload is well formed
 *   before the claim is made. A mistyped npub that survives classification becomes a watch-only
 *   account pointing at a pubkey nobody holds, and the user finds out weeks later.
 * - {@link detectImportKind} only looks at the shape. It exists so the UI can say *which* thing
 *   the user was trying to paste when validation fails. With strict parsing alone, a seed phrase
 *   with one mistyped word is indistinguishable from random text, and the only message available
 *   is "unrecognized input" — at the exact moment someone is recovering an identity.
 *
 * Strict parse for safety, loose detect for the error message. `parseImportInput` is layered on
 * `detectImportKind`, so the two can never disagree about what shape something is.
 *
 * Ported from the extension's `src/domain/accounts/importInput.ts`, `creation.ts` (the accepted
 * shapes) and `src/constants/accounts.ts`.
 */
import { hexToBytes } from '@noble/hashes/utils.js';
import { bech32DecodeFixed, bech32Decode } from './bech32.js';
import { isValidPrivateKey, validateMnemonic } from './derivation.js';
import { V2_PAYLOAD_LENGTH, VERSION_LEGACY, VERSION_V2 } from './nip49.js';

export const ENCRYPTED_PRIVATE_KEY_PREFIX = 'ncryptsec1';
export const PRIVATE_KEY_PREFIX = 'nsec1';
export const PUBLIC_KEY_PREFIX = 'npub1';
export const BUNKER_PREFIX = 'bunker://';
export const PRIVATE_KEY_HEX_PATTERN = /^[0-9a-f]{64}$/i;
export const IMPORT_MNEMONIC_WORD_COUNTS: readonly number[] = [12, 24];

/** A bunker URI carries the signer's 64-char hex pubkey, then optional query parameters. */
const BUNKER_PATTERN = /^bunker:\/\/([0-9a-f]{64})(\?.*)?$/i;

/** Legacy 0x01 backups are version(1) + salt(16) + iv(12) + AES-GCM ciphertext(48). */
const LEGACY_PAYLOAD_LENGTH = 1 + 16 + 12 + 48;

export type ImportInput =
  | { kind: 'nsec'; privkey: Uint8Array }
  | { kind: 'npub'; pubkey: string }
  | { kind: 'mnemonic'; mnemonic: string }
  | { kind: 'ncryptsec'; payload: string }
  | { kind: 'hex-private'; privkey: Uint8Array }
  | { kind: 'bunker'; uri: string };

export type ImportKind = ImportInput['kind'];

function countWords(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function normalizeMnemonic(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(' ').toLowerCase();
}

/**
 * What the user appears to have pasted, by shape alone.
 *
 * This validates nothing: a bad checksum, an off-curve scalar and a misspelled word all still
 * report their kind. Use it for the error message, never to decide that material is importable.
 */
export function detectImportKind(raw: string): ImportKind | null {
  if (typeof raw !== 'string') return null;
  const input = raw.trim();
  if (!input) return null;
  const lower = input.toLowerCase();

  if (lower.startsWith(ENCRYPTED_PRIVATE_KEY_PREFIX)) return 'ncryptsec';
  if (lower.startsWith(PRIVATE_KEY_PREFIX)) return 'nsec';
  if (lower.startsWith(PUBLIC_KEY_PREFIX)) return 'npub';
  if (lower.startsWith(BUNKER_PREFIX)) return 'bunker';
  if (PRIVATE_KEY_HEX_PATTERN.test(input)) return 'hex-private';
  if (IMPORT_MNEMONIC_WORD_COUNTS.includes(countWords(input))) return 'mnemonic';
  return null;
}

/**
 * Classify and validate import material. Null means "not something we can import", including a
 * well-shaped string whose checksum does not hold or whose key is not on the curve.
 *
 * The returned `privkey` for the nsec and hex cases is live key material: the caller owns it and
 * should zero it once the account is built.
 */
export function parseImportInput(raw: string): ImportInput | null {
  const kind = detectImportKind(raw);
  if (!kind) return null;
  const input = raw.trim();

  switch (kind) {
    case 'ncryptsec': {
      const decoded = bech32Decode(input);
      if (!decoded || decoded.hrp !== 'ncryptsec') return null;
      // A valid checksum over a truncated or unknown-version payload is still unopenable.
      const version = decoded.bytes[0];
      const expected =
        version === VERSION_V2
          ? V2_PAYLOAD_LENGTH
          : version === VERSION_LEGACY
            ? LEGACY_PAYLOAD_LENGTH
            : null;
      if (expected === null || decoded.bytes.length !== expected) return null;
      return { kind: 'ncryptsec', payload: input };
    }

    case 'nsec': {
      const privkey = bech32DecodeFixed(input, 'nsec', 32);
      if (!privkey || !isValidPrivateKey(privkey)) return null;
      return { kind: 'nsec', privkey };
    }

    case 'npub': {
      const pubkey = bech32DecodeFixed(input, 'npub', 32);
      return pubkey ? { kind: 'npub', pubkey: bytesToHexLower(pubkey) } : null;
    }

    case 'bunker':
      return BUNKER_PATTERN.test(input) ? { kind: 'bunker', uri: input } : null;

    case 'hex-private': {
      const privkey = hexToBytes(input.toLowerCase());
      return isValidPrivateKey(privkey) ? { kind: 'hex-private', privkey } : null;
    }

    case 'mnemonic': {
      const mnemonic = normalizeMnemonic(input);
      return validateMnemonic(mnemonic) ? { kind: 'mnemonic', mnemonic } : null;
    }
  }
}
