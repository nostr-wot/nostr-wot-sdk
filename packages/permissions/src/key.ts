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
 * The kind argument, discriminated on the method literal.
 *
 * A `signEvent` READ needs an integer kind and nothing else may carry one: a `signEvent`
 * check that cannot name its kind reads only the method and wildcard levels, and
 * `{ '*': 'allow', 'signEvent:1': 'deny' }` then answers `allow` for a kind-1 event.
 * `undefined`, `null`, `NaN` and `1.5` all took that path. A method that is only known at
 * runtime as `string` has to be narrowed first. A rest tuple, so the argument can be left
 * off entirely where it is `undefined`.
 */
export type KindFor<M extends string> = M extends 'signEvent' ? [kind: number] : [kind?: undefined];

/**
 * The kind argument for a WRITE: as {@link KindFor}, except that `null` is legal for
 * `signEvent` and means the blanket key, `signEvent`, which is what "remember for every
 * kind" writes on purpose.
 */
export type KindForWrite<M extends string> = M extends 'signEvent' ? [kind: number | null] : [kind?: undefined];

/** An integer event kind, which is the only kind a read can be scoped by. */
function isKind(kind: unknown): kind is number {
  return typeof kind === 'number' && Number.isInteger(kind);
}

/**
 * Maps a wire method to the logical permission key that governs it.
 *
 * - `signEvent` is keyed per kind (`signEvent:1`), so a site allowed to publish notes is
 *   not thereby allowed to publish a contact list. A `null` kind names the blanket key
 *   (`signEvent`) for a write; any other non-integer kind is refused, because a write under
 *   `signEvent:NaN` is a rule nothing will ever consult.
 * - The DM kinds collapse into `sendMessages`, which is also what the encrypt methods use,
 *   so one approval covers the whole send-a-DM flow rather than prompting twice.
 * - Both NIP-04 and NIP-44 variants share a key: which cipher a site picks is not a
 *   decision the user was asked to make.
 * - WebLN methods pass through, already namespaced by their `webln_` prefix.
 * - Everything else is its own key.
 *
 * @param method - the wire method, for example `signEvent` or `nip04Encrypt`
 * @param kind - the event kind when the method is `signEvent`, or `null` for the blanket key
 */
export function permissionKey<M extends string>(method: M, ...[kind]: KindForWrite<M>): string {
  // WebLN methods are used as-is; they are already prefixed.
  if (method.startsWith('webln_')) return method;

  if (method === 'signEvent') {
    if (kind === undefined || kind === null) return method;
    if (!isKind(kind)) throw new Error('signEvent needs an integer event kind, or null for the blanket key');
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
 * duplicate when the first two coincide, as they do for `getPublicKey`. Exported because
 * the store uses it to report *which* level denied.
 *
 * A `signEvent` read whose kind is not an integer (JavaScript callers, casts) consults only
 * the method and the wildcard, and {@link resolve} then answers from their deny level alone.
 */
export function consultedKeys<M extends string>(method: M, ...[kind]: KindFor<M>): string[] {
  if (method === 'signEvent' && !isKind(kind)) return [method, '*'];
  const kindKey = permissionKey(method, ...([kind] as KindForWrite<M>));
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
export function resolve<M extends string>(
  bucket: PermissionBucket,
  method: M,
  ...kind: KindFor<M>
): PermissionDecision {
  return resolveDetailed(bucket, method, ...kind).decision;
}

/**
 * The key that decided, alongside the decision: the denying level when something denied,
 * the most specific defined level otherwise, and `undefined` when nothing was set.
 *
 * A `signEvent` read that cannot name an integer kind is answered from the deny levels
 * alone: `deny` when the method or the wildcard denies, `ask` otherwise. A wildcard `allow`
 * must not answer for a kind the caller failed to state, because the kind it failed to
 * state may be one the user denied.
 */
export function resolveDetailed<M extends string>(
  bucket: PermissionBucket,
  method: M,
  ...[kind]: KindFor<M>
): { decision: PermissionDecision; key?: string } {
  const consulted = consultedKeys(method, ...([kind] as KindFor<M>));

  for (const key of consulted) {
    if (bucket[key] === 'deny') return { decision: 'deny', key };
  }
  if (method === 'signEvent' && !isKind(kind)) return { decision: 'ask' };
  for (const key of consulted) {
    if (bucket[key]) return { decision: bucket[key], key };
  }
  return { decision: 'ask' };
}

/**
 * The key a "remember for every kind" decision is stored under: the bare method name.
 *
 * Named rather than spelled inline so the blanket read and {@link permissionKey}'s `null`
 * branch cannot drift apart. It is wire format — vaults in the field hold it — so it is not
 * renameable.
 */
export const BLANKET_SIGN_EVENT_KEY = 'signEvent';

/**
 * What the user stored for the BLANKET `signEvent` key, and only that.
 *
 * **This is not authorization.** It answers "did the user say yes to signing in general?",
 * which is a settings-screen question, not a gate: a bucket of
 * `{ signEvent: 'allow', 'signEvent:1': 'deny' }` answers `allow` here and `deny` from
 * {@link resolve} for a kind-1 event, and the second answer is the one a request obeys.
 * {@link resolve} exists so a broad allow can never answer for a kind the caller failed to
 * state; this exists so a decision the store was explicitly told can be read back.
 *
 * Why it is a separate function rather than a relaxation of the kind-less {@link resolve}
 * path: the two questions have different answers and only one of them is safe to sign on, so
 * they get different names. A consumer asking this one has said which it means.
 *
 * Deny still wins, across the blanket key and the wildcard, because a refusal in force is a
 * refusal however broadly the question is put. `ask` means neither level is set — a
 * kind-specific rule alone does not answer the blanket question.
 */
export function resolveBlanketSignEvent(bucket: PermissionBucket): {
  decision: PermissionDecision;
  key?: string;
} {
  const consulted = [BLANKET_SIGN_EVENT_KEY, '*'];
  for (const key of consulted) {
    if (bucket[key] === 'deny') return { decision: 'deny', key };
  }
  for (const key of consulted) {
    if (bucket[key]) return { decision: bucket[key], key };
  }
  return { decision: 'ask' };
}
