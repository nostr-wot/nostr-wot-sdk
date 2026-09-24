/**
 * The stored names, verbatim.
 *
 * These are wire format. A browser extension in the field has written
 * `signerPermissions` and `signerUseGlobalDefaults` into its local storage, so renaming
 * either one silently resets every decision the user ever made, which reads to them as the
 * signer forgetting that a site was allowed. Do not rename them; migrate instead.
 */

/** Where the whole permission tree lives in the injected store. */
export const PERMISSIONS_STORAGE_KEY = 'signerPermissions';

/** Where the global-versus-per-account mode flag lives. */
export const GLOBAL_DEFAULTS_KEY = 'signerUseGlobalDefaults';

/** Which one-time migrations have already run. */
export const MIGRATION_VERSION_KEY = '_permMigrationVersion';

/** The migration level {@link Permissions.migrate} brings a store up to. */
export const MIGRATION_VERSION = 4;

/** The bucket every account shares while global defaults are on. */
export const DEFAULT_BUCKET = '_default';

/**
 * Event kinds that are part of the "send a DM" flow. `signEvent` for any of these
 * collapses into the `sendMessages` permission so a single approval covers both the
 * encrypt step and the matching `signEvent`.
 *
 * | Kind | What it is |
 * | --- | --- |
 * | 4 | NIP-04 legacy DM |
 * | 13 | NIP-59 seal (wraps an encrypted DM) |
 * | 14 | NIP-17 chat rumor |
 * | 1059 | NIP-59 gift wrap |
 *
 * The consequence is deliberate: denying sign-of-DM-kind without also denying encrypt is
 * not expressible, because it is one decision.
 */
export const DM_SIGN_KINDS: ReadonlySet<number> = new Set<number>([4, 13, 14, 1059]);

/** The three answers, for UIs that render a chip per decision. */
export const DECISIONS = ['allow', 'deny', 'ask'] as const;

/** Permission keys a read-only or remote-signer account can meaningfully hold. */
export const READ_ONLY_KEYS = ['getPublicKey'];

/** The keys worth offering in a permissions screen, in display order. */
export const COMMON_PERM_KEYS = [
  'getPublicKey',
  'signEvent:0',
  'signEvent:1',
  'signEvent:3',
  'signEvent:5',
  'signEvent:6',
  'signEvent:7',
  'signEvent:1111',
  'signEvent:9734',
  'signEvent:24242',
  'signEvent:27235',
  'signEvent:30023',
  'readMessages',
  'sendMessages',
];
