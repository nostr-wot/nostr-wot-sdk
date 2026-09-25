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

// ── The envelope ──
//
// `id`, `origin.identifier`, `origin.displayName` and `origin.icon` are written verbatim into
// every persisted activity entry, denied requests included, so an unbounded one is a
// storage-filling primitive for any connected page. These bite before anything is copied.

/** Request id, in characters. A NIP-46 id is client chosen; the extension's is a counter. */
export const MAX_REQUEST_ID_LENGTH = 256;

/** `origin.identifier`, in characters. A hostname is at most 253; an origin a little more. */
export const MAX_ORIGIN_IDENTIFIER_LENGTH = 512;

/** `origin.displayName`, in characters. Rendered on the approval screen, so also a UI bound. */
export const MAX_ORIGIN_DISPLAY_NAME_LENGTH = 128;

/** `origin.icon`, in characters: a URL, not an image. */
export const MAX_ORIGIN_ICON_LENGTH = 2048;

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

// ── Batches ──
//
// A batch is one request carrying many items, approved once. On iOS every signature costs a
// user gesture that nothing can suppress, so a burst of ten reactions and two zaps is twelve
// prompts, roughly a minute of the user's attention; one batch is one prompt. These two
// numbers keep a batch from becoming the way around the per-event limits above.

/** Items in one batch. A burst is a dozen; this leaves room without inviting a dump. */
export const MAX_BATCH_ITEMS = 64;

/**
 * The whole batch, in UTF-8 bytes: every event as JSON, every plaintext, every ciphertext.
 *
 * Equal to {@link MAX_EVENT_BYTES} on purpose. A batch is one queued request, and it is
 * bounded like one: whatever the pipeline may hold in flight for N single requests, N batches
 * hold no more. A batch of one can still carry a full-size contact list; a batch of many
 * carries the small events bursts are made of.
 */
export const MAX_BATCH_BYTES = MAX_EVENT_BYTES;

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
