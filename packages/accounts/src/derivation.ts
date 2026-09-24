/**
 * NIP-06 key derivation: BIP-39 seed, BIP-32 path, x-only secp256k1 public key.
 *
 * Ported from the extension's `src/domain/accounts/derivation.ts`, `src/lib/crypto/bip32.ts`,
 * `src/lib/crypto/bip39.ts` and `src/constants/crypto/bip32.ts`. The extension's wrappers are
 * async for historical reasons; nothing underneath them is, so these are synchronous.
 *
 * ## Sub-account convention
 *
 * Sub-account `n` lives at `m/44'/1237'/0'/0/{n}` — the **last** component varies, the account
 * component stays at `0'`. Some other signers vary the account component instead, deriving
 * `m/44'/1237'/{n}'/0/0`, which is the stricter reading of NIP-06.
 *
 * This package follows the extension, deliberately, because the extension has shipped. A user
 * who created sub-accounts there and then restores the same seed phrase in the mobile app must
 * get the same identities back. Deriving the other way would hand them a different set of keys
 * with no error at all, and the only reasonable conclusion they could draw is that their
 * accounts were lost. Protocol purity loses to not destroying identities that exist.
 *
 * Index 0 is `m/44'/1237'/0'/0/0` under either convention, so the published NIP-06 vector holds
 * regardless; the two only diverge from index 1 onward.
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
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
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

/**
 * The path for sub-account `index`: `m/44'/1237'/0'/0/{index}`.
 *
 * Built from {@link NIP06_ACCOUNT_PREFIX} rather than by formatting a template, so this and
 * {@link standardDerivationIndex} cannot drift apart: `standardDerivationIndex(derivationPath(n))`
 * is `n` for every valid `n`, which is what lets a stored path recover its account index.
 */
export function derivationPath(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > MAX_BIP32_INDEX) {
    throw new Error('Invalid derivation index');
  }
  return NIP06_ACCOUNT_PREFIX + index;
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
 * Is this a usable secp256k1 secret key: 32 bytes, and a scalar in `1 .. n-1`?
 *
 * Thirty-two bytes of the right length is not the same as a key. All-zero and anything at or
 * above the curve order are out of range, and every operation on them throws. Checking here
 * means a bad import is rejected where the user can still fix it, instead of surfacing as a
 * curve-internal error message somewhere downstream.
 */
export function isValidPrivateKey(privkey: Uint8Array): boolean {
  if (!(privkey instanceof Uint8Array) || privkey.length !== 32) return false;
  return secp256k1.utils.isValidSecretKey(privkey);
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
