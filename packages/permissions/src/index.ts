/**
 * `@nostr-wot/permissions` — the authorization layer every `@nostr-wot` signer funnels
 * through.
 *
 * One question, asked the same way by every transport: may this caller sign this, encrypt
 * this, decrypt this. NIP-07 in a browser extension, NIP-55 from an Android app, NIP-46
 * from a remote signer — they differ in how the request arrives, not in who is allowed to
 * make it, so the decision lives here rather than three times over.
 *
 * Two halves. {@link resolve} and {@link permissionKey} are pure and touch nothing: given
 * a bucket of stored decisions they produce an answer, and the cascade's one guarantee is
 * that **deny wins** — an explicit deny at any consulted level ends the matter, and no
 * narrower allow reopens it. {@link Permissions} adds storage: buckets per origin and
 * account, an in-memory cache, a lock around every read-modify-write, and the migrations
 * that let a browser extension's existing `signerPermissions` blob be read as-is.
 *
 * Nothing here touches a platform global. The host injects a `KeyValueStore` and, if it
 * wants denials recorded, a logger.
 */
export type {
  PermissionDecision,
  PermissionBucket,
  OriginPermissions,
  PermissionMap,
  PermissionLogger,
} from './types.js';

export {
  PERMISSIONS_STORAGE_KEY,
  GLOBAL_DEFAULTS_KEY,
  MIGRATION_VERSION_KEY,
  MIGRATION_VERSION,
  DEFAULT_BUCKET,
  DM_SIGN_KINDS,
  DECISIONS,
  READ_ONLY_KEYS,
  COMMON_PERM_KEYS,
} from './constants.js';

export { permissionKey, consultedKeys, resolve, resolveDetailed } from './key.js';

export { canonicalHostname, canonicalHttpOrigin, siteScopes, hasSiteScope, originPermissionBucket, storageLabel } from './scope.js';

export { Permissions, type PermissionsOptions } from './store.js';
