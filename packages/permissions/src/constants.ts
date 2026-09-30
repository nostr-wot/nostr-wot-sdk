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

/**
 * Where the destination-scoped authentication grants live in the injected store.
 *
 * Wire format, like every other key in this file: the browser extension has already written
 * `authenticationGrants` into its local storage, so a host migrating onto this package keeps
 * the consents its users gave. Do not rename it.
 */
export const AUTHENTICATION_GRANTS_KEY = 'authenticationGrants';

/** NIP-42 relay authentication. */
export const NIP42_KIND = 22242;

/** NIP-98 HTTP authentication. */
export const NIP98_KIND = 27235;

/**
 * Event kinds that are an AUTHENTICATION event rather than a publication.
 *
 * These two are different in kind from everything else a site asks to have signed: the event
 * names a DESTINATION it will be presented to, and the signature is a credential for that
 * destination. A permission keyed by method and event kind cannot express a destination, so a
 * remembered `signEvent:22242 = allow` is a credential for every relay any caller names, and
 * `signEvent:27235 = allow` one for every HTTP service. That is GHSA-vx4h-56qj-wcp7.
 *
 * `authentication.ts` holds the destination model that answers these properly. Everything in
 * this package that could otherwise hand out an unbounded credential consults this set.
 *
 * From the extension, which has no such set: it spells the two kinds inline wherever the
 * question comes up. `src/domain/signing/requestOrigin.ts` treats
 * `kind === 27235 || kind === 22242` on a `nip07_signEvent` as an authentication request,
 * `parseAuthentication` in `src/domain/signing/authentication.ts` returns `undefined` for
 * anything else, and `src/screens/Settings/GlobalRules.tsx` keeps `signEvent:22242` and
 * `signEvent:27235` out of the keys a rule can be added for. Naming the set is this
 * package's change, so a reader will not find the constant upstream.
 */
export const AUTHENTICATION_SIGN_KINDS: ReadonlySet<number> = new Set<number>([NIP42_KIND, NIP98_KIND]);

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
