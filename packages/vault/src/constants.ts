/**
 * The fixed parameters of vault format version 1.
 *
 * These are not tunables. The shipping browser extension already wrote vaults with exactly
 * these numbers through WebCrypto, and this package has to read those bytes back. Changing
 * any of them means a new format version and a migration, never an edit here.
 */

/** Vault format version these parameters describe. */
export const VAULT_VERSION = 1;

/** PBKDF2-HMAC-SHA-256 iterations for a vault protected by a real password. */
export const VAULT_PBKDF2_ITERATIONS = 600_000;

/**
 * PBKDF2-HMAC-SHA-256 iterations for a vault stored under the empty password.
 *
 * This lower work factor is deliberate, not a leftover. A "never lock" vault is stored under
 * a password the source code supplies in public: anyone holding the encrypted blob also holds
 * the password, so no amount of stretching makes it harder to open. The work factor buys
 * nothing there, and it costs real latency on a path that runs at every cold start. A vault
 * with an actual password gets the full {@link VAULT_PBKDF2_ITERATIONS}, where stretching is
 * the whole defence.
 */
export const LEGACY_VAULT_PBKDF2_ITERATIONS = 210_000;

/** Shortest password a user may choose when they do protect the vault. */
export const MIN_PASSWORD_LENGTH = 8;

/** Salt length in bytes, drawn fresh per vault. */
export const VAULT_SALT_BYTES = 16;

/** AES-GCM IV length in bytes, drawn fresh per encryption. */
export const VAULT_IV_BYTES = 12;

/** Derived key length in bytes — AES-256. */
export const VAULT_KEY_BYTES = 32;
