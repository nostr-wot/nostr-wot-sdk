/**
 * The fixed numbers of the pipeline.
 *
 * Every value here is the extension's, spelled the same, because the extension's
 * behaviour is the acceptance gate for this extraction: a request that the extension caps,
 * times out or refuses for size is one this package caps, times out or refuses for size.
 */

/**
 * How many actionable prompts one origin may have open at once.
 *
 * Blunts prompt spam from a connected caller: once an origin has this many unresolved
 * prompts, further requests from it are rejected immediately rather than queued. Unlock
 * markers and in-flight remote entries need no user action and do not count.
 */
export const MAX_PENDING_PER_ORIGIN = 5;

/** How long a request may wait on the user, or on an unlock, before it is rejected. */
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * After the user approves sharing the pubkey with an origin, further `getPublicKey` calls
 * from that origin are answered without a prompt for this long.
 *
 * Suppresses the "site calls getPublicKey twice on init" double prompt without weakening the
 * per-request consent model for any other method. In memory only, per origin, tied to the
 * account it was earned for, and cleared whenever the active account changes.
 */
export const GET_PUBLIC_KEY_COOLDOWN_MS = 60_000;

/** Every pending entry of every kind, per origin: approvals, unlock markers, remote work. */
export const MAX_IN_FLIGHT_PER_ORIGIN = 64;

/** Every pending entry of every kind, across every origin. */
export const MAX_IN_FLIGHT_GLOBAL = 256;

/** The whole event as JSON, in UTF-8 bytes, tags included; accommodates large contact lists. */
export const MAX_EVENT_BYTES = 1024 * 1024;

/** Tags per event. */
export const MAX_EVENT_TAGS = 10_000;

/** Values in one tag. */
export const MAX_TAG_VALUES = 1024;

/** Plaintext handed to an encrypt method, in UTF-8 bytes. */
export const MAX_CRYPTO_PLAINTEXT_BYTES = 65535;

/** Ciphertext handed to a decrypt method, in characters. */
export const MAX_CRYPTO_CIPHERTEXT_LENGTH = 131072;

/** The wire methods, as a runtime set for the boundary check. */
export const SIGNER_METHODS = [
  'getPublicKey',
  'signEvent',
  'getRelays',
  'nip04Encrypt',
  'nip04Decrypt',
  'nip44Encrypt',
  'nip44Decrypt',
] as const;

/** Where a request can come from, as a runtime set for the boundary check. */
export const ORIGIN_KINDS = ['web', 'nip46', 'nip55', 'lan', 'local'] as const;

/** The methods that need the account's private key. `getPublicKey` and `getRelays` do not. */
export const KEY_METHODS: ReadonlySet<string> = new Set([
  'signEvent',
  'nip04Encrypt',
  'nip04Decrypt',
  'nip44Encrypt',
  'nip44Decrypt',
]);
