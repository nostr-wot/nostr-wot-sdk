/**
 * NIP-06 key derivation: BIP-39 seed, BIP-32 path, x-only secp256k1 public key.
 *
 * Ported from the extension's `src/domain/accounts/derivation.ts`, `src/lib/crypto/bip32.ts`,
 * `src/lib/crypto/bip39.ts` and `src/constants/crypto/bip32.ts`. The extension's wrappers are
 * async for historical reasons; nothing underneath them is, so these are synchronous.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/06.md — NIP-06
 */
import { HDKey } from '@scure/bip32';
import {
  generateMnemonic as bip39Generate,
  mnemonicToSeedSync,
  validateMnemonic as bip39Validate,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const NIP06_PATH = "m/44'/1237'/0'/0/0";
export const NIP06_ACCOUNT_PREFIX = NIP06_PATH.slice(0, NIP06_PATH.lastIndexOf('/') + 1);

export const MAX_BIP32_INDEX = 0x7fffffff;
export const MAX_BIP32_DEPTH = 255;
export const MAX_BIP32_PATH_LENGTH = 2 + MAX_BIP32_DEPTH * 12;

/**
 * Newly generated accounts need 256-bit seeds.
 *
 * A 12-word phrase carries 128 bits, which becomes the limiting factor once post-quantum
 * keys are derived from the same seed: the seed, not the algorithm, would be the weakest
 * link. Existing 12-word accounts keep working; this is the default for new ones.
 */
export const GENERATED_MNEMONIC_STRENGTH_BITS = 256;

/** Canonical private BIP-32 path; apostrophe, h and H denote hardened children. */
export function normalizeDerivationPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_BIP32_PATH_LENGTH) return null;
  const parts = value.trim().split('/');
  if (parts.shift() !== 'm' || parts.length > MAX_BIP32_DEPTH) return null;
  const canonical: string[] = [];
  for (const part of parts) {
    const match = /^(\d+)(['hH]?)$/.exec(part);
    if (!match) return null;
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index > MAX_BIP32_INDEX) return null;
    canonical.push(String(index) + (match[2] ? "'" : ''));
  }
  return ['m', ...canonical].join('/');
}

/** Only the existing NIP-06 sequence has a numeric account index. */
export function standardDerivationIndex(path: string): number | null {
  const canonical = normalizeDerivationPath(path);
  if (!canonical?.startsWith(NIP06_ACCOUNT_PREFIX)) return null;
  const suffix = canonical.slice(NIP06_ACCOUNT_PREFIX.length);
  return /^\d+$/.test(suffix) ? Number(suffix) : null;
}

/** The NIP-06 path for account `index`: m/44'/1237'/{index}'/0/0. */
export function derivationPath(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > MAX_BIP32_INDEX) {
    throw new Error('Invalid derivation index');
  }
  return `m/44'/1237'/${index}'/0/0`;
}

export function validateMnemonic(mnemonic: string): boolean {
  return bip39Validate(mnemonic, wordlist);
}

/**
 * Generate a BIP-39 mnemonic, 24 words by default.
 *
 * The default is deliberately not BIP-39's 128-bit minimum — see
 * {@link GENERATED_MNEMONIC_STRENGTH_BITS}. A 128-bit default only ever meant the next
 * caller who forgot the argument would silently get the weaker key.
 */
export function generateMnemonic(strength: 128 | 256 = GENERATED_MNEMONIC_STRENGTH_BITS): string {
  return bip39Generate(wordlist, strength);
}

export function mnemonicToSeed(mnemonic: string, passphrase = ''): Uint8Array {
  return mnemonicToSeedSync(mnemonic, passphrase);
}

/** Derive the private key at an arbitrary BIP-32 path. The caller owns and zeroes it. */
export function derivePath(seed: Uint8Array, path: string): Uint8Array {
  const master = HDKey.fromMasterSeed(seed);
  try {
    const derived = master.derive(path);
    try {
      const key = derived.privateKey;
      if (!key) throw new Error('Derivation failed');
      return Uint8Array.from(key);
    } finally {
      derived.wipePrivateData();
    }
  } finally {
    master.wipePrivateData();
  }
}

/** The x-only (32-byte) public key, hex encoded, as Nostr uses it. */
export function publicKeyFromPrivate(privkey: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(privkey));
}

/**
 * Derive the NIP-06 identity at `index` from a mnemonic.
 *
 * `privkey` is live key material: the caller owns it and should zero it once used. The
 * seed is this function's own, so it is zeroed here.
 */
export function deriveFromMnemonic(
  mnemonic: string,
  index: number,
): { privkey: Uint8Array; pubkey: string; path: string } {
  const path = derivationPath(index);
  if (!validateMnemonic(mnemonic)) throw new Error('Invalid mnemonic');

  const seed = mnemonicToSeed(mnemonic);
  try {
    const privkey = derivePath(seed, path);
    return { privkey, pubkey: publicKeyFromPrivate(privkey), path };
  } finally {
    seed.fill(0);
  }
}
