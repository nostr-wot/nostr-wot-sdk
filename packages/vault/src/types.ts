/**
 * The vault record format, version 1, and the in-memory projection of it.
 *
 * Ported from the browser extension's `src/domain/vault/types.ts` and the record the extension's
 * `create()` writes into `browser.storage.local`. These shapes are on-disk format: vaults in the
 * field already have exactly these fields, so a change here is a format version and a migration.
 */
import type { Account } from '@nostr-wot/accounts';

/**
 * The encrypted envelope, exactly as it sits in storage.
 *
 * `salt`, `iv` and `ciphertext` are standard base64 with padding, because the extension encodes
 * them with `btoa`. `ciphertext` carries the 16-byte AES-GCM tag appended, which is the layout
 * WebCrypto produces.
 */
export interface VaultRecord {
  /** Format version. 1 is the only version that has ever shipped. */
  version: number;
  /** Base64, {@link VAULT_SALT_BYTES} bytes when this package wrote it. */
  salt: string;
  /** Base64, 12 bytes. */
  iv: string;
  /** Base64, plaintext length plus the 16-byte GCM tag. */
  ciphertext: string;
  /**
   * PBKDF2 work factor the record was written with.
   *
   * Optional, and that is not an oversight. Records written before the work factor was raised
   * carry no such field, and were every one of them written at
   * {@link LEGACY_VAULT_PBKDF2_ITERATIONS}. A reader that required the field would refuse to
   * open exactly the oldest vaults in the field.
   */
  iterations?: number;
}

/** The decrypted contents of a {@link VaultRecord}. */
export interface VaultPayload {
  /** Random private-cache key, base64, protected by the vault encryption. */
  cacheKey?: string;
  accounts: Account[];
  activeAccountId: string | null;
}

/**
 * An account while the vault is unlocked.
 *
 * Every secret is a `Uint8Array` rather than a string so that `lock()` can zero it. A
 * JavaScript string cannot be overwritten: it stays readable in the heap until the collector
 * happens to reclaim it, which is not a guarantee anyone can make about an nsec.
 *
 * `pqPublic` is optional here where the extension's copy is not, so that an account stored
 * without a `pqKeys` field round trips back to one without it, rather than gaining an explicit
 * `pqKeys: null`. The two are indistinguishable to every reader, but a lossless round trip is
 * worth more than a byte-identical type.
 */
export interface MemoryAccount extends Omit<Account, 'privkey' | 'mnemonic' | 'pqKeys'> {
  /** Zeroed on lock. */
  privkeyBytes: Uint8Array | null;
  /** Zeroed on lock. */
  mnemonicBytes: Uint8Array | null;
  /** Public halves stay strings, because they are public; the secrets are zeroable bytes. */
  pqPublic?: { profile: string; kem: string; dsa: string; importedAt: number } | null;
  /** Zeroed on lock. */
  pqKemSecretBytes: Uint8Array | null;
  /** Zeroed on lock. */
  pqDsaSecretBytes: Uint8Array | null;
}

/** The decrypted vault while it is unlocked, with every secret held as zeroable bytes. */
export interface MemoryVaultPayload {
  cacheKeyBytes?: Uint8Array;
  accounts: MemoryAccount[];
  activeAccountId: string | null;
}
