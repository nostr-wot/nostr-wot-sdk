/**
 * The two ports that used to be classes.
 *
 * `SignerCoreDeps.vault` was typed as the `Vault` CLASS and `permissions` as the
 * `Permissions` class. Both carry `#private` fields, and a `#private` field makes a class
 * type NOMINAL in TypeScript: the compiler adds the private brand to the structural check, so
 * no adapter, facade or structurally-identical object can ever satisfy it. A host adopting
 * this package behind its own vault facade got
 *
 *     error TS2740: Type '{ isLocked(): boolean; withPrivkey<T>(…): Promise<T>; now: …; }'
 *       is missing the following properties from type 'Vault': #private, exists, create,
 *       unlock, and 21 more.
 *
 * and signer-core became unreachable — not for want of adapter work, but because a
 * ports-and-adapters boundary whose port is a concrete class has no port. `#private` is the
 * loud version of the same defect: even without it, naming the class in the dependency type
 * demands every one of its twenty-odd members from a consumer that needs none of them.
 *
 * So the dependency is an interface describing exactly what the pipeline calls, and the
 * concrete classes satisfy it. Two consequences worth stating, because they are the point:
 *
 *   - **Adding a member here is a breaking change for every host.** The port is the contract,
 *     so it is deliberately the smallest set the pipeline actually uses. `Vault` has account
 *     mutation, creation, unlock, auto-lock, the guard and the listeners; the pipeline uses
 *     none of them and so neither does {@link VaultPort}.
 *   - **The port cannot enforce the class's memory discipline, and does not pretend to.**
 *     `Vault.withPrivkey` hands out a copy, zeroes it on every path and voids a result
 *     computed under a revoked session. An interface can only say that a callback receives
 *     bytes. What each member owes its caller is written on it below, and a host that
 *     implements one owes exactly that; the real `Vault` remains the reference implementation
 *     and `@nostr-wot/vault`'s own suite is what holds it to the guarantees.
 *
 * `test/handwritten.ts` is the proof the boundary is adaptable: objects written by hand
 * against these interfaces, accepted by `SignerCore` at compile time (`contracts.test-d.ts`)
 * and driven through a real signing request at runtime (`adaptability.test.ts`).
 */
import type { KindFor, KindForWrite, PermissionDecision } from '@nostr-wot/permissions';
import type { ImportedPqKeys } from '@nostr-wot/vault';

export type { ImportedPqKeys };

/**
 * The key material the pipeline needs, and nothing else.
 *
 * Satisfied by `@nostr-wot/vault`'s `Vault`, which is the reference implementation and the
 * only one that carries the zeroing, session-revocation and auto-lock guarantees the doc
 * comments below describe. A host with its own vault implements this.
 *
 * Every scoped accessor here follows one contract, the one `Vault.withPrivkey` documents:
 * **`fn` computes and returns, and must not externalize anything.** Sign, encrypt, derive,
 * hand the result back. A callback that also publishes has put the value on the wire before
 * any revocation can throw, and nothing can recall it.
 */
export interface VaultPort {
  /**
   * The clock the whole pipeline runs on: cooldowns, `created_at`, activity timestamps and
   * queue stamps all read it, so faking time is done here, once. The core has no `now` of
   * its own, deliberately — three independent defaults were one system on three clocks.
   */
  readonly now: () => number;

  /**
   * Is the key material unavailable? Synchronous, because the pipeline gates on it at points
   * where it cannot afford to await: a caller that has to `await` a lock check will check it
   * before the await and act after it.
   */
  isLocked(): boolean;

  /**
   * Does this account hold a seed phrase? `false` while locked, and it reveals nothing
   * secret. The pipeline asks before {@link withMnemonic} so it can name the refusal ("this
   * account has no seed phrase") rather than reporting a generic throw.
   */
  hasMnemonic(accountId: string): boolean;

  /** Does this account carry imported post-quantum keys? `false` while locked. Reveals nothing secret. */
  hasImportedPqKeys(accountId: string): boolean;

  /**
   * Run `fn` with the account's secp256k1 private key.
   *
   * `accountId` is required and names the account: "whatever is active now" is the exact
   * substitution this pipeline exists to prevent, since a request resolved and shown for one
   * account must be signed by that account's key.
   *
   * An implementation owes: a copy the callback cannot use to corrupt its own state, zeroed
   * on every path out, and a throw rather than a return if the session was revoked while
   * `fn` ran.
   *
   * @throws when the vault is locked, the account has no private key, or the session moved
   */
  withPrivkey<T>(accountId: string, fn: (key: Uint8Array) => Promise<T>): Promise<T>;

  /**
   * Run `fn` with the account's seed phrase as UTF-8 bytes, under the same contract as
   * {@link withPrivkey}. Bytes rather than a string because a string cannot be overwritten.
   *
   * @throws when the vault is locked, the account has no phrase, or the session moved
   */
  withMnemonic<T>(accountId: string, fn: (phrase: Uint8Array) => Promise<T>): Promise<T>;

  /**
   * Run `fn` with the account's imported ML-KEM and ML-DSA secrets, under the same contract
   * as {@link withPrivkey}. Throws rather than answering null for an account with none, which
   * is what {@link hasImportedPqKeys} is asked first for.
   *
   * @throws when the vault is locked, the account has no imported keys, or the session moved
   */
  withImportedPqKeys<T>(accountId: string, fn: (keys: ImportedPqKeys) => Promise<T>): Promise<T>;

  /**
   * Run `fn` with secret bytes the CALLER derived registered as live key material for the
   * duration, so a lock reaches them where they are rather than when the callback happens to
   * finish. The arrays are taken over, not copied: the implementation will fill them with
   * zeroes, so pass buffers you own.
   *
   * This is what makes the per-request post-quantum derivation honest. Zeroing in the
   * deriver's own `finally` covers a return and a throw and misses the case that matters —
   * `lock()` is the user saying "let go of my keys now", and a derived secret the vault has
   * never heard of goes on living.
   *
   * @throws when the vault is locked, or the session moved while `fn` ran
   */
  withDerivedSecrets<T>(secrets: readonly Uint8Array[], fn: () => Promise<T>): Promise<T>;
}

/**
 * The authorization questions the pipeline asks, and nothing else.
 *
 * Satisfied by `@nostr-wot/permissions`'s `Permissions`. Two members: the gate in front of
 * every request, and the write a remembered approval makes. The migrations, the raw tree
 * reads, the mode switch and the per-account bookkeeping are a settings screen's business,
 * not this pipeline's, so they are not in the contract a host has to implement.
 *
 * The generics are not decoration. `KindFor<M>` makes an event kind REQUIRED on a `signEvent`
 * read and forbidden elsewhere, because a `signEvent` check that cannot name its kind reads
 * only the method and wildcard levels — so `{ '*': 'allow', 'signEvent:1': 'deny' }` would
 * answer `allow` for a kind-1 event. `KindForWrite<M>` additionally allows `null`, which
 * names the blanket `signEvent` key that "remember for every kind" writes on purpose.
 *
 * **`origin` is read as given.** The pipeline canonicalises every identifier at its boundary
 * (`permissionOrigin`) before anything reaches here, so a read and a write cannot disagree
 * about spelling inside it.
 */
export interface PermissionsPort {
  /**
   * May `origin` perform `method` as `accountId`? `ask` means nothing is stored, which is
   * what an implementation answers for an origin it has never heard of; an implementation
   * must not throw on a read, because an authorization check that throws into a signing path
   * is worse than one that prompts.
   */
  check<M extends string>(
    origin: string,
    method: M,
    kind: KindFor<M>[0],
    accountId: string,
  ): Promise<PermissionDecision>;

  /** Record a remembered decision. `kind: null` on a `signEvent` names the blanket key. */
  save<M extends string>(
    origin: string,
    method: M,
    kind: KindForWrite<M>[0],
    decision: PermissionDecision,
    accountId: string,
  ): Promise<void>;
}
