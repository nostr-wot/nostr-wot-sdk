/**
 * The cascade, as pure functions.
 *
 * This is the security critical part of the package, and it is deliberately separated from
 * storage so it can be tested exhaustively without one. Everything here is synchronous and
 * total: given a bucket, a method and a kind there is exactly one answer, and the answer
 * does not depend on anything outside the arguments.
 */
import { DM_SIGN_KINDS } from './constants.js';
import type { PermissionBucket, PermissionDecision } from './types.js';

/**
 * Maps a wire method to the logical permission key that governs it.
 *
 * - `signEvent` is keyed per kind (`signEvent:1`), so a site allowed to publish notes is
 *   not thereby allowed to publish a contact list.
 * - The DM kinds collapse into `sendMessages`, which is also what the encrypt methods use,
 *   so one approval covers the whole send-a-DM flow rather than prompting twice.
 * - Both NIP-04 and NIP-44 variants share a key: which cipher a site picks is not a
 *   decision the user was asked to make.
 * - WebLN methods pass through, already namespaced by their `webln_` prefix.
 * - Everything else is its own key.
 *
 * @param method - the wire method, for example `signEvent` or `nip04Encrypt`
 * @param kind - the event kind, when the method is `signEvent`
 */
export function permissionKey(method: string, kind?: number | null): string {
  // WebLN methods are used as-is; they are already prefixed.
  if (method.startsWith('webln_')) return method;

  if (method === 'signEvent' && kind !== undefined && kind !== null) {
    if (DM_SIGN_KINDS.has(kind)) return 'sendMessages';
    return `signEvent:${kind}`;
  }
  if (method === 'nip04Encrypt' || method === 'nip44Encrypt') return 'sendMessages';
  if (method === 'nip04Decrypt' || method === 'nip44Decrypt') return 'readMessages';
  return method;
}

/**
 * The keys {@link resolve} looks at, most specific first.
 *
 * Always the logical key, then the bare method name, then the wildcard — minus the
 * duplicate when the first two coincide, as they do for `getPublicKey` or a kindless
 * `signEvent`. Exported because the store uses it to report *which* level denied.
 */
export function consultedKeys(method: string, kind?: number | null): string[] {
  const kindKey = permissionKey(method, kind);
  return kindKey !== method ? [kindKey, method, '*'] : [method, '*'];
}

/**
 * Resolves one request against one bucket of stored decisions.
 *
 * Deny wins. If any consulted level holds `deny` the answer is `deny`, so a kind-specific
 * `allow` cannot override a method-level or wildcard `deny`, and a broad `*` allow cannot
 * bypass a narrower deny. That asymmetry is the point: a user who denied something broadly
 * has said no, and no narrower yes reopens it. Only when nothing denies does specificity
 * decide, in the order kind > method > wildcard. An unset key is not an answer, so a
 * bucket that says nothing about this request returns `ask`.
 *
 * @param bucket - the active bucket for this origin and account
 * @param method - the wire method
 * @param kind - the event kind, when the method is `signEvent`
 */
export function resolve(
  bucket: PermissionBucket,
  method: string,
  kind?: number | null,
): PermissionDecision {
  const consulted = consultedKeys(method, kind);

  for (const key of consulted) {
    if (bucket[key] === 'deny') return 'deny';
  }
  for (const key of consulted) {
    if (bucket[key]) return bucket[key];
  }
  return 'ask';
}

/**
 * The key that decided, alongside the decision: the denying level when something denied,
 * the most specific defined level otherwise, and `undefined` when nothing was set.
 */
export function resolveDetailed(
  bucket: PermissionBucket,
  method: string,
  kind?: number | null,
): { decision: PermissionDecision; key?: string } {
  const consulted = consultedKeys(method, kind);

  for (const key of consulted) {
    if (bucket[key] === 'deny') return { decision: 'deny', key };
  }
  for (const key of consulted) {
    if (bucket[key]) return { decision: bucket[key], key };
  }
  return { decision: 'ask' };
}
