/**
 * The vocabulary of the permission store.
 *
 * The first dimension is called `origin` rather than `domain`: a NIP-07 caller is a web
 * origin, a NIP-55 caller is an Android package name and a NIP-46 caller is a public key.
 * None of the three is reliably a domain, and treating them as one is how a caller label
 * ends up being parsed when it should have been compared. The stored shape is unchanged
 * from the browser extension's, so an existing `signerPermissions` blob keeps working.
 */

/** The three answers a permission rule can hold. */
export type PermissionDecision = 'allow' | 'deny' | 'ask';

/** One origin's rules for one account: permission key to decision. */
export type PermissionBucket = Record<string, PermissionDecision>;

/** Every bucket stored for one origin, keyed by account id or {@link DEFAULT_BUCKET}. */
export type OriginPermissions = Record<string, PermissionBucket>;

/**
 * The whole stored tree: `{ origin: { bucket: { permissionKey: decision } } }`.
 *
 * ```json
 * { "example.com": { "_default": { "signEvent:1": "allow" }, "acct_abc": { "*": "deny" } } }
 * ```
 */
export type PermissionMap = Record<string, OriginPermissions>;

/**
 * Where a denial goes, when the host wants to hear about it.
 *
 * A library cannot assume a console: React Native has one that costs a bridge hop, a
 * service worker's is invisible, and a test wants the record rather than the noise. So the
 * host injects this or does not, and nothing is written when it does not.
 */
export interface PermissionLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/**
 * A permission key the current model retired: the DM sign kinds `permissionKey` folds into
 * `sendMessages`, so nothing ever consults one.
 *
 * A closed union rather than `string`, because that is the whole safety argument for having a
 * write path for these at all. Every member is a key the cascade provably ignores, so writing
 * one cannot grant anything; a `string` parameter would let the same method write
 * `signEvent:1`, which very much can.
 *
 * Derived from `DM_SIGN_KINDS` by hand and pinned to it by a test, because a template literal
 * over a `ReadonlySet` is not something the type system can compute.
 */
export type RetiredPermissionKey = 'signEvent:4' | 'signEvent:13' | 'signEvent:14' | 'signEvent:1059';
