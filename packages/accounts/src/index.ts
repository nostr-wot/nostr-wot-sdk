/**
 * `@nostr-wot/accounts` — the Nostr account primitives every `@nostr-wot` host shares.
 *
 * NIP-06 derivation, import classification and NIP-49 encrypted keys, in pure JavaScript.
 * Nothing here touches `crypto.subtle`, a DOM global or a UI framework, so the same code
 * runs in a browser extension, in a React Native app and in a Node test.
 */
export type { Account, AccountType, Nip46Config, PqImportedKeys, SafeAccount } from './types.js';
export { toSafeAccount } from './types.js';

export {
  GENERATED_MNEMONIC_STRENGTH_BITS,
  MAX_BIP32_DEPTH,
  MAX_BIP32_INDEX,
  MAX_BIP32_PATH_LENGTH,
  NIP06_ACCOUNT_PREFIX,
  NIP06_PATH,
  derivationPath,
  deriveFromMnemonic,
  derivePath,
  generateMnemonic,
  mnemonicToSeed,
  normalizeDerivationPath,
  publicKeyFromPrivate,
  standardDerivationIndex,
  validateMnemonic,
} from './derivation.js';

export type { ImportInput } from './import.js';
export {
  BUNKER_PREFIX,
  ENCRYPTED_PRIVATE_KEY_PREFIX,
  IMPORT_MNEMONIC_WORD_COUNTS,
  PRIVATE_KEY_HEX_PATTERN,
  PRIVATE_KEY_PREFIX,
  PUBLIC_KEY_PREFIX,
  parseImportInput,
} from './import.js';

export {
  DEFAULT_LOG_N,
  KEY_SECURITY_UNKNOWN,
  LEGACY_PBKDF2_ITERATIONS,
  MAX_LOG_N,
  SCRYPT_P,
  SCRYPT_R,
  V2_PAYLOAD_LENGTH,
  VERSION_LEGACY,
  VERSION_V2,
  decryptNcryptsec,
  encryptNcryptsec,
} from './nip49.js';

export { npubDecode, npubEncode, nsecDecode, nsecEncode } from './bech32.js';
export { shortNpub } from './display.js';
