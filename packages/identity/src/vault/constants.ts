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

/**
 * Salt length in bytes, drawn fresh per vault.
 *
 * 32, not 16. The shipping extension draws `crypto.getRandomValues(new Uint8Array(32))` in
 * `create()`, so this is the number a vault this package writes has to match for the envelope
 * to look like the ones already in the field. Nothing in this package enforces it — PBKDF2
 * accepts a salt of any length, and reading an existing record takes whatever salt the record
 * carries, which is what lets any older length still open. The guard that does exist is on the
 * derived key length, not on this.
 */
export const VAULT_SALT_BYTES = 32;

/** AES-GCM IV length in bytes, drawn fresh per encryption. */
export const VAULT_IV_BYTES = 12;

/** Derived key length in bytes — AES-256. */
export const VAULT_KEY_BYTES = 32;

// ── Storage keys ────────────────────────────────────────────────────────────────────────
//
// These are the browser extension's key names, spelled exactly as it spells them. A host
// migrating from the extension points this package at the same storage and has to find its
// own vault there; a tidier name here would silently present every existing user with an
// empty vault and a "create one" screen, with their keys still sitting in storage under the
// old name. They are format, like the fields inside the record.

/** Where the encrypted {@link VaultRecord} lives. */
export const VAULT_STORAGE_KEY = 'keyVault';

/**
 * A marker bumped whenever the lock state changes, in EITHER direction.
 *
 * The value is a timestamp that is never read for its meaning — only for the fact that it
 * changed. It exists so another context (a popup, a second window, anything watching the
 * store) can observe a transition it did not perform, through the store's optional
 * `subscribe`. Locking was the obvious half; unlocking matters just as much, because a
 * "never lock" vault re-opens itself on a cold start and a surface that asked during that
 * window was told "locked" with no way to ever hear the correction.
 */
export const LOCK_STATE_KEY = 'vaultLockStateAt';

/** Where the persisted brute-force guard state lives. */
export const UNLOCK_GUARD_KEY = 'vaultUnlockGuard';

/** Where the chosen auto-lock interval lives. */
export const AUTO_LOCK_STORAGE_KEY = 'autoLockMs';

// ── Auto-lock ───────────────────────────────────────────────────────────────────────────

/** Auto-lock interval used when the host has never chosen one: 15 minutes. */
export const DEFAULT_AUTO_LOCK_MS = 900_000;
