/**
 * Classify pasted key material into something an account can be built from.
 *
 * The extension's `detectImportType` is a UI hint that deliberately does not validate;
 * this is the opposite. Recognising a prefix and handing back an `ImportInput` is a claim
 * that the material is usable, so the checksum is verified before the claim is made. A
 * mistyped npub that survives classification becomes a watch-only account pointing at a
 * pubkey nobody holds, and the user finds out weeks later.
 *
 * Ported from the extension's `src/domain/accounts/importInput.ts`, `creation.ts` (the
 * accepted shapes) and `src/constants/accounts.ts`.
 */
import { hexToBytes } from '@noble/hashes/utils.js';
import { bech32DecodeFixed, bech32Decode } from './bech32.js';
import { validateMnemonic } from './derivation.js';

export const ENCRYPTED_PRIVATE_KEY_PREFIX = 'ncryptsec1';
export const PRIVATE_KEY_PREFIX = 'nsec1';
export const PUBLIC_KEY_PREFIX = 'npub1';
export const BUNKER_PREFIX = 'bunker://';
export const PRIVATE_KEY_HEX_PATTERN = /^[0-9a-f]{64}$/i;
export const IMPORT_MNEMONIC_WORD_COUNTS: readonly number[] = [12, 24];

/** A bunker URI carries the signer's 64-char hex pubkey, then optional query parameters. */
const BUNKER_PATTERN = /^bunker:\/\/([0-9a-f]{64})(\?.*)?$/i;

export type ImportInput =
  | { kind: 'nsec'; privkey: Uint8Array }
  | { kind: 'npub'; pubkey: string }
  | { kind: 'mnemonic'; mnemonic: string }
  | { kind: 'ncryptsec'; payload: string }
  | { kind: 'hex-private'; privkey: Uint8Array }
  | { kind: 'bunker'; uri: string };

function countWords(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Classify and validate import material. Null means "not something we can import",
 * including a well-shaped string whose checksum does not hold.
 *
 * The returned `privkey` for the nsec and hex cases is live key material: the caller owns
 * it and should zero it once the account is built.
 */
export function parseImportInput(raw: string): ImportInput | null {
  if (typeof raw !== 'string') return null;
  const input = raw.trim();
  if (!input) return null;

  if (input.toLowerCase().startsWith(ENCRYPTED_PRIVATE_KEY_PREFIX)) {
    const decoded = bech32Decode(input);
    if (!decoded || decoded.hrp !== 'ncryptsec') return null;
    return { kind: 'ncryptsec', payload: input };
  }

  if (input.toLowerCase().startsWith(PRIVATE_KEY_PREFIX)) {
    const privkey = bech32DecodeFixed(input, 'nsec', 32);
    return privkey ? { kind: 'nsec', privkey } : null;
  }

  if (input.toLowerCase().startsWith(PUBLIC_KEY_PREFIX)) {
    const pubkey = bech32DecodeFixed(input, 'npub', 32);
    return pubkey ? { kind: 'npub', pubkey: bytesToHexLower(pubkey) } : null;
  }

  if (input.toLowerCase().startsWith(BUNKER_PREFIX)) {
    return BUNKER_PATTERN.test(input) ? { kind: 'bunker', uri: input } : null;
  }

  if (PRIVATE_KEY_HEX_PATTERN.test(input)) {
    return { kind: 'hex-private', privkey: hexToBytes(input.toLowerCase()) };
  }

  if (IMPORT_MNEMONIC_WORD_COUNTS.includes(countWords(input))) {
    const mnemonic = input.split(/\s+/).filter(Boolean).join(' ').toLowerCase();
    return validateMnemonic(mnemonic) ? { kind: 'mnemonic', mnemonic } : null;
  }

  return null;
}
