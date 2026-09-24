/**
 * Which stored labels a caller's rules may come from.
 *
 * Permissions were originally keyed by hostname and are now keyed by exact origin. Both
 * shapes exist in stores in the field, so a read has to look at both while a write only
 * ever produces the exact one. Nothing here creates a grant: an origin that has no stored
 * rule under either label still resolves to `ask`.
 */
import type { PermissionBucket, PermissionDecision, PermissionMap } from './types.js';

/**
 * The labels to read for a caller, most specific first.
 *
 * An `http(s)` origin also answers to its bare hostname, because that is what older
 * versions stored. Anything else — an Android package name, a NIP-46 public key, an
 * internal label — is only ever itself; there is no hostname to fall back to, and a
 * caller label is never parsed into one.
 */
export function siteScopes(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (['http:', 'https:'].includes(url.protocol) && url.origin === origin) {
      return [origin, url.hostname];
    }
  } catch {
    /* Legacy and internal labels are already their own scope. */
  }
  return [origin];
}

/** Whether any of `origin`'s scopes appears in a stored list of labels. */
export function hasSiteScope(stored: readonly string[], origin: string): boolean {
  return siteScopes(origin).some((scope) => stored.includes(scope));
}

/**
 * The effective bucket for one origin: the legacy hostname rules, then the exact-origin
 * rules layered on top, so an exact-origin edit overrides the same legacy key while
 * unrelated legacy rules survive.
 */
export function originPermissionBucket(
  stored: PermissionMap,
  origin: string,
  bucket: string,
): PermissionBucket {
  const result: PermissionBucket = {};
  for (const scope of siteScopes(origin).reverse()) {
    for (const [key, value] of Object.entries(stored[scope]?.[bucket] ?? {})) {
      result[key] = value as PermissionDecision;
    }
  }
  return result;
}
