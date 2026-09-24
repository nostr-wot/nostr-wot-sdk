/**
 * The stored permission tree and everything that reads or writes it.
 *
 * Storage model:
 *
 * ```json
 * { "origin": { "_default": { "signEvent:1": "allow" }, "acctId": { "*": "deny" } } }
 * ```
 *
 * Mode-based resolution, and the two modes are mutually exclusive:
 *
 * - `useGlobalDefaults = true` consults **only** `perms[origin]["_default"]`
 * - `useGlobalDefaults = false` consults **only** `perms[origin][accountId]`
 * - nothing found means `ask`
 *
 * Dormant data survives a mode switch: only the active mode's bucket is read or written,
 * so switching back finds what was there before.
 *
 * ## Divergence from the browser extension: no `_default` fallback in per-account mode
 *
 * The extension resolves its bucket as `accountId || '_default'` in both modes, so a call
 * that omits `accountId` while in per-account mode silently reads the bucket every account
 * shares. It gets away with it because it has one call site. This package is about to have
 * four transports feeding it, and an optional parameter that one call site forgets is
 * exactly how a cross-account leak ships.
 *
 * So this implementation fails closed, at both levels. The `accountId` is REQUIRED on every
 * read and write, so forgetting it is a compile error rather than a behaviour. And at
 * runtime, in per-account mode an empty `accountId` resolves to no bucket at all: reads see
 * an empty bucket and answer `ask`, and writes throw rather than land in `_default`. Global
 * mode keeps the fallback, where `_default` is the correct bucket by definition. The cost is
 * one extra approval prompt on a path that should not occur; the alternative cost is an
 * unauthorized signature.
 *
 * Nothing here decides how a request is *routed* — local signing versus a remote signer is
 * the signer's business, not the permission's. A permission answers one question: may this
 * caller do this.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/07.md NIP-07
 */
import type { KeyValueStore } from '@nostr-wot/storage';
import {
  DEFAULT_BUCKET,
  DM_SIGN_KINDS,
  GLOBAL_DEFAULTS_KEY,
  MIGRATION_VERSION,
  MIGRATION_VERSION_KEY,
  PERMISSIONS_STORAGE_KEY,
} from './constants.js';
import { permissionKey, resolveDetailed } from './key.js';
import { AsyncLock } from './lock.js';
import { originPermissionBucket, siteScopes, storageLabel } from './scope.js';
import type {
  OriginPermissions,
  PermissionBucket,
  PermissionDecision,
  PermissionLogger,
  PermissionMap,
} from './types.js';

/** Optional collaborators. Everything here is opt-in; a store alone is enough. */
export interface PermissionsOptions {
  /** Told about every denial. Omit it and denials are silent. */
  logger?: PermissionLogger;
}

/**
 * The DM-kind keys {@link Permissions.migrateDmKindsToSendMessages} folds away, derived
 * from {@link DM_SIGN_KINDS} rather than restated, so the two cannot drift apart.
 */
const DM_PERMISSION_KEYS = [...DM_SIGN_KINDS].map((kind) => `signEvent:${kind}`);

/**
 * Rejects the empty string where an origin or an account id is required.
 *
 * `''` type-checks everywhere a label is expected, means nothing, and quietly takes a path
 * nobody intended: it silently no-ops one method, stores a rule under a junk origin in
 * another, and in `clear` it used to mean "wipe every permission there is". A caller that
 * built a label from a variable and got an empty one deserves to hear about it.
 *
 * This guards the mutating methods only. Reads stay tolerant on purpose: an unknown origin
 * resolves to `ask`, which is both correct and the safest possible answer, and an
 * authorization check that throws into a signing path is worse than one that prompts.
 * `undefined` and `null` keep their documented meanings and never reach here.
 */
function requireLabel(value: string, what: string): string {
  if (value === '') {
    throw new Error(`${what} must not be empty: an empty label is a caller bug, not a wildcard`);
  }
  return value;
}

/**
 * A deep copy of a permission tree, or of one origin's buckets.
 *
 * The tree is plain JSON — string keys, string values, nothing else — so a JSON round trip is
 * an exact clone of it and needs nothing from the host. That is the whole reason to prefer it
 * over a structured clone: this package runs on runtimes that do not all start with the same
 * globals, and a clone of JSON data should not be the thing that decides where it runs.
 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * How restrictive each decision is. Used only when merging two rules into one, where the
 * conservative choice is the one the user is least likely to be surprised by: someone who
 * once denied a DM-related signature stays denied.
 */
const RESTRICTIVENESS: Record<string, number> = { allow: 1, ask: 2, deny: 3 };

/** Retired decision value, from when NIP-46 accounts auto-forwarded to a remote signer. */
const RETIRED_FORWARD = 'forward' as PermissionDecision;

/**
 * Blanket keys the per-kind model retired as GRANTS. A blanket `allow` is dropped by
 * {@link Permissions.migrateToPerKind}; a blanket `deny` under any of these keys is kept,
 * because the cascade still consults the bare method and the wildcard, so it is a refusal
 * in force, and one a remembered "deny, every kind" writes today.
 */
const BLANKET_KEYS = [
  'signEvent',
  'nip04Encrypt',
  'nip04Decrypt',
  'nip44Encrypt',
  'nip44Decrypt',
  '*',
];

/**
 * Decides whether a caller may sign, encrypt or decrypt, over an injected store.
 *
 * One instance per store. It keeps an in-memory cache of the tree and of the mode flag,
 * invalidated on every write and, when the store can report changes, on every write from
 * anywhere else — a second extension context, another process, another instance.
 */
export class Permissions {
  readonly #store: KeyValueStore;
  readonly #logger: PermissionLogger | undefined;
  readonly #lock = new AsyncLock();

  #cachedPerms: PermissionMap | null = null;
  #cachedUseGlobalDefaults: boolean | null = null;
  #unsubscribe: (() => void) | undefined;

  constructor(store: KeyValueStore, options: PermissionsOptions = {}) {
    this.#store = store;
    this.#logger = options.logger;

    // A store that cannot report changes simply does not get us this; our own writes
    // invalidate the cache directly, so only out-of-band edits are missed.
    this.#unsubscribe = store.subscribe?.((key: string) => {
      if (key === PERMISSIONS_STORAGE_KEY || key === GLOBAL_DEFAULTS_KEY) this.invalidateCache();
    });
  }

  /** Drops the cached tree and mode flag. Safe at any time; the next read reloads. */
  invalidateCache(): void {
    this.#cachedPerms = null;
    this.#cachedUseGlobalDefaults = null;
  }

  /** Stops listening to the store. The instance still works, it just caches blindly. */
  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  // ── Reading ──

  /**
   * Whether `origin` may perform `method`.
   *
   * @param origin - the caller: a web origin, an Android package name, a remote signer key
   * @param method - the wire method, for example `signEvent` or `nip44Decrypt`
   * @param kind - the event kind, when the method is `signEvent`; `undefined` otherwise
   * @param accountId - the account the request is for. Required at the type level: a caller
   *   that forgets it compiles fine, works in global mode, and in per-account mode prompts
   *   forever while every remembered approval reads as an internal error. Ignored while
   *   global defaults are on, which is exactly why forgetting it goes unnoticed.
   */
  async check(
    origin: string,
    method: string,
    kind: number | undefined,
    accountId: string,
  ): Promise<PermissionDecision> {
    const bucket = await this.getForOrigin(origin, accountId);
    const { decision, key } = resolveDetailed(bucket, method, kind);

    if (decision === 'deny') {
      this.#logger?.warn('permission denied', { origin, key, method, kind });
    }
    return decision;
  }

  /** Every origin's rules in the active bucket: `{ origin: { permissionKey: decision } }`. */
  async getAll(accountId: string): Promise<Record<string, PermissionBucket>> {
    const bucket = await this.#activeBucket(accountId);
    if (bucket === null) return {};
    const perms = await this.#load();
    const result: Record<string, PermissionBucket> = {};
    for (const origin of Object.keys(perms)) {
      const data = perms[origin][bucket];
      if (data && Object.keys(data).length > 0) result[origin] = { ...data };
    }
    return result;
  }

  /** One origin's effective rules in the active bucket, legacy scopes folded in. */
  async getForOrigin(origin: string, accountId: string): Promise<PermissionBucket> {
    const bucket = await this.#activeBucket(accountId);
    if (bucket === null) return {};
    return originPermissionBucket(await this.#load(), origin, bucket);
  }

  /** The whole stored tree, every bucket, as a copy. For settings screens and diffs. */
  async getAllRaw(): Promise<PermissionMap> {
    return cloneJson(await this.#load());
  }

  /** One origin's buckets, all of them, as a copy. Read under the label a write would use. */
  async getForOriginRaw(origin: string): Promise<OriginPermissions> {
    const perms = await this.#load();
    return cloneJson(perms[storageLabel(origin)] ?? {});
  }

  /**
   * Whether global defaults are on, meaning every account shares `_default`.
   *
   * Unset means on, because that is what stores written before the flag existed imply.
   */
  async getUseGlobalDefaults(): Promise<boolean> {
    if (this.#cachedUseGlobalDefaults !== null) return this.#cachedUseGlobalDefaults;
    const stored = await this.#store.get<boolean>(GLOBAL_DEFAULTS_KEY);
    this.#cachedUseGlobalDefaults = stored !== false;
    return this.#cachedUseGlobalDefaults;
  }

  // ── Writing ──

  /** Turns global defaults on or off. The dormant buckets are left exactly as they are. */
  async setUseGlobalDefaults(enabled: boolean): Promise<void> {
    try {
      await this.#store.set(GLOBAL_DEFAULTS_KEY, !!enabled);
    } finally {
      this.invalidateCache();
    }
  }

  /**
   * Records a decision for a method, mapped through {@link permissionKey} — so approving
   * `signEvent` of a DM kind records `sendMessages`, covering the encrypt step too.
   */
  async save(
    origin: string,
    method: string,
    kind: number | null,
    decision: PermissionDecision,
    accountId: string,
  ): Promise<void> {
    await this.saveDirect(origin, permissionKey(method, kind), decision, accountId);
  }

  /**
   * Records a decision under a key verbatim, for a UI that edits keys directly.
   *
   * A DM-kind key (`signEvent:4`, `:13`, `:14`, `:1059`) is rejected, because nothing ever
   * consults one: {@link permissionKey} maps those kinds to `sendMessages`, so a rule
   * written under the raw key is dead on arrival. Accepting one silently is how a UI ships
   * a `deny` the user believes is in force and that never fires. Write `sendMessages`.
   */
  async saveDirect(
    origin: string,
    key: string,
    decision: PermissionDecision,
    accountId: string,
  ): Promise<void> {
    requireLabel(origin, 'origin');
    requireLabel(key, 'permission key');
    if (DM_PERMISSION_KEYS.includes(key)) {
      throw new Error(
        `${key} is never consulted: DM sign kinds resolve to "sendMessages". Write that key instead.`,
      );
    }
    // Written under the canonical spelling, so the label a read consults is the one a write
    // produced whatever the caller's casing or port: see `canonicalHttpOrigin`.
    const label = storageLabel(origin);
    await this.#lock.run(async () => {
      const bucket = await this.#writeBucket(accountId);
      const perms = await this.#draft();
      if (!perms[label]) perms[label] = {};
      if (!perms[label][bucket]) perms[label][bucket] = {};
      perms[label][bucket][key] = decision;
      await this.#commit(perms);
    });
  }

  /**
   * Clears one origin's rules in the active bucket, or, with no origin, every rule there is.
   *
   * Omitting `origin` is the documented way to say "everything". An empty string is not,
   * and throws: a caller that built an origin from a variable that came back empty meant to
   * clear one site, not to wipe every permission the user has.
   *
   * Both paths take the lock. A revocation that raced a concurrent save used to be
   * reversible: the save had already loaded the tree, so writing it back resurrected every
   * grant the user had just revoked.
   */
  async clear(origin: string | undefined, accountId: string): Promise<void> {
    if (origin !== undefined) requireLabel(origin, 'origin');
    if (!origin) {
      await this.#lock.run(async () => {
        try {
          await this.#store.remove(PERMISSIONS_STORAGE_KEY);
        } finally {
          this.invalidateCache();
        }
      });
      return;
    }
    await this.#lock.run(async () => {
      const bucket = await this.#writeBucket(accountId);
      const perms = await this.#draft();
      for (const scope of siteScopes(origin)) {
        if (!perms[scope]) continue;
        delete perms[scope][bucket];
        if (Object.keys(perms[scope]).length === 0) delete perms[scope];
      }
      await this.#commit(perms);
    });
  }

  /**
   * Removes every stored rule for an origin, across every account bucket and every scope.
   *
   * Disconnecting a site is a full revocation. {@link clear} touches only the active
   * mode's bucket, which would leave another account's rules behind for a site the user
   * just disconnected, and stale rules for a disconnected site are exactly what used to
   * resurrect it.
   */
  async clearAllForOrigin(origin: string): Promise<void> {
    requireLabel(origin, 'origin');
    await this.#lock.run(async () => {
      const perms = await this.#draft();
      for (const scope of siteScopes(origin)) delete perms[scope];
      await this.#commit(perms);
    });
  }

  /**
   * Removes one account's overrides everywhere. Called when an account is deleted.
   *
   * An empty id throws. Passing {@link DEFAULT_BUCKET} is refused quietly instead, which is
   * a deliberate safety rule rather than a swallowed caller bug: the shared bucket is not
   * one account's overrides, and deleting an account must never wipe every account's rules.
   */
  async clearForAccount(accountId: string): Promise<void> {
    requireLabel(accountId, 'account id');
    // Refusing _default is deliberate, not a swallowed bug: the shared bucket is not one
    // account's overrides, and deleting an account must never wipe every account's rules.
    if (accountId === DEFAULT_BUCKET) return;
    await this.#lock.run(async () => {
      const perms = await this.#draft();
      let changed = false;
      for (const origin of Object.keys(perms)) {
        if (perms[origin][accountId]) {
          delete perms[origin][accountId];
          changed = true;
          if (Object.keys(perms[origin]).length === 0) delete perms[origin];
        }
      }
      if (changed) await this.#commit(perms);
    });
  }

  /**
   * Copies every origin's rules from one bucket into another.
   *
   * `null` is the documented way to say "the default bucket". An empty string is not: it
   * type-checks, so a caller that builds an id from a variable and gets an empty one would
   * otherwise silently copy the dormant `_default` bucket into a fresh account — handing it
   * the shared grants that per-account mode exists to withhold. That is a caller bug, and
   * it throws, the same way a per-account write with no `accountId` does.
   *
   * @param fromAccountId - the source account, or null for {@link DEFAULT_BUCKET}
   * @param toAccountId - the target account
   */
  async copyPermissions(fromAccountId: string | null, toAccountId: string): Promise<void> {
    if (fromAccountId === '') {
      throw new Error(
        'copyPermissions needs a source account id or null: refusing to read the shared _default bucket for an empty id',
      );
    }
    requireLabel(toAccountId, 'target account id');
    await this.#lock.run(async () => {
      const from = fromAccountId ?? DEFAULT_BUCKET;
      const perms = await this.#draft();
      let changed = false;
      for (const origin of Object.keys(perms)) {
        const source = perms[origin][from];
        if (source && Object.keys(source).length > 0) {
          perms[origin][toAccountId] = { ...source };
          changed = true;
        }
      }
      if (changed) await this.#commit(perms);
    });
  }

  /**
   * Sets up a freshly created account so a wizard's "start fresh" or "copy from" choice is
   * actually honored.
   *
   * In global mode every account shares `_default`, so a new account would otherwise
   * inherit whatever the existing ones had. The order matters and is the reason this
   * method exists: each existing account's effective permissions are copied into its OWN
   * bucket **first**, and only then is the mode switched to per-account. Do it the other
   * way round and every existing account starts re-asking for sites it was already
   * allowed on. With the mode switched, the new account is isolated, and either inherits a
   * chosen account's rules or starts empty.
   *
   * An empty `newAccountId` throws rather than doing nothing, because a wizard whose
   * "start fresh" or "copy from" choice silently did not happen is worse than one that fails.
   *
   * @param newAccountId - the account just created
   * @param existingAccountIds - every other account id, to preserve across the mode switch
   * @param copyFromAccountId - a source to copy into the new account, or null for fresh
   */
  async setupNewAccountPermissions(
    newAccountId: string,
    existingAccountIds: string[],
    copyFromAccountId: string | null,
  ): Promise<void> {
    requireLabel(newAccountId, 'new account id');

    if (await this.getUseGlobalDefaults()) {
      // Preserve each existing account's currently-shared rules in its own bucket BEFORE
      // switching modes, so none of them starts re-asking after the switch.
      for (const id of existingAccountIds) {
        if (id && id !== newAccountId) await this.copyPermissions(DEFAULT_BUCKET, id);
      }
      await this.setUseGlobalDefaults(false);
    }

    if (copyFromAccountId) {
      await this.copyPermissions(copyFromAccountId, newAccountId);
    } else {
      // Fresh: make sure the new account's bucket is empty.
      await this.clearForAccount(newAccountId);
    }
  }

  // ── Migrations ──

  /**
   * Runs every migration, in order, once per store.
   *
   * The order is not interchangeable: blanket keys go before bucketing, bucketing before
   * the value rewrite, and the DM fold last, once everything it looks at is bucketed.
   */
  async migrate(): Promise<void> {
    const version = await this.#store.get<number>(MIGRATION_VERSION_KEY);
    if (version === MIGRATION_VERSION) return;

    await this.migrateToPerKind();
    await this.migrateToPerAccount();
    await this.migrateForwardToAsk();
    await this.migrateDmKindsToSendMessages();
    await this.#store.set(MIGRATION_VERSION_KEY, MIGRATION_VERSION);
  }

  /**
   * Drops the blanket grants the per-kind model retired, and only the grants.
   *
   * A stored `signEvent: allow` used to mean "any event", which is a far broader grant
   * than anything the current UI can express, so it is removed rather than reinterpreted.
   * A stored `signEvent: deny` (or `*: deny`, or a bare method deny) is not a grant: the
   * cascade still consults those levels and honours the refusal, and a remembered "deny,
   * every kind" writes exactly that key. {@link migrate} re-runs every migration whenever
   * the stored version differs, so deleting it here would wipe every remembered refusal on
   * the next version bump. The logical group keys (`sendMessages`, `readMessages`) are not
   * blanket keys and stay.
   *
   * This diverges from the browser extension, whose migration drops the deny too; the
   * divergence is in the restrictive direction, and it is raised against the extension.
   */
  async migrateToPerKind(): Promise<void> {
    await this.#lock.run(async () => {
      const perms = await this.#draft();
      let changed = false;
      for (const origin of Object.keys(perms)) {
        const target = perms[origin];
        if (target[DEFAULT_BUCKET]) {
          for (const bucket of Object.keys(target)) {
            if (typeof target[bucket] !== 'object') continue;
            for (const key of BLANKET_KEYS) {
              if (target[bucket][key] && target[bucket][key] !== 'deny') {
                delete target[bucket][key];
                changed = true;
              }
            }
            if (Object.keys(target[bucket]).length === 0) delete target[bucket];
          }
        } else {
          // Still flat: the keys sit directly on the origin.
          const flat = target as unknown as Record<string, unknown>;
          for (const key of BLANKET_KEYS) {
            if (flat[key] && flat[key] !== 'deny') {
              delete flat[key];
              changed = true;
            }
          }
        }
        if (Object.keys(perms[origin]).length === 0) delete perms[origin];
      }
      if (changed) await this.#commit(perms);
    });
  }

  /**
   * Wraps flat per-origin rules under `_default`. Idempotent: an origin that already has
   * buckets is skipped.
   */
  async migrateToPerAccount(): Promise<void> {
    await this.#lock.run(async () => {
      const perms = await this.#draft();
      let changed = false;
      for (const origin of Object.keys(perms)) {
        const originData = perms[origin];
        if (originData[DEFAULT_BUCKET]) continue;
        // A string value means the key sits directly on the origin, pre-bucketing.
        const hasFlat = Object.values(originData).some((value) => typeof value === 'string');
        if (!hasFlat) continue;

        const flat: PermissionBucket = {};
        for (const [key, value] of Object.entries(originData)) {
          if (typeof value === 'string') {
            flat[key] = value as unknown as PermissionDecision;
            delete (originData as unknown as Record<string, unknown>)[key];
          }
        }
        originData[DEFAULT_BUCKET] = flat;
        changed = true;
      }
      if (changed) await this.#commit(perms);
    });
  }

  /**
   * Rewrites the retired `forward` value to `ask`.
   *
   * NIP-46 accounts once used `forward` to send a request straight to the remote signer
   * without prompting. Permissions are account-type-agnostic now, and `ask` is the
   * conservative reading of a value that no longer means anything.
   */
  async migrateForwardToAsk(): Promise<void> {
    await this.#lock.run(async () => {
      const perms = await this.#draft();
      let changed = false;
      for (const origin of Object.keys(perms)) {
        for (const bucket of Object.keys(perms[origin])) {
          if (typeof perms[origin][bucket] !== 'object') continue;
          for (const key of Object.keys(perms[origin][bucket])) {
            if (perms[origin][bucket][key] === RETIRED_FORWARD) {
              perms[origin][bucket][key] = 'ask';
              changed = true;
            }
          }
        }
      }
      if (changed) await this.#commit(perms);
    });
  }

  /**
   * Folds stored `signEvent:4`, `:13`, `:14` and `:1059` entries into `sendMessages`.
   *
   * Those kinds now share one logical permission with the matching encrypt step, so one
   * approval covers the whole DM flow. When both a DM-kind entry and `sendMessages` exist,
   * the most restrictive value wins — deny over ask over allow — because a user who had
   * denied any part of the flow should not find it allowed after an upgrade.
   */
  async migrateDmKindsToSendMessages(): Promise<void> {
    await this.#lock.run(async () => {
      const perms = await this.#draft();
      let changed = false;
      for (const origin of Object.keys(perms)) {
        const target = perms[origin];
        for (const bucket of Object.keys(target)) {
          const data = target[bucket];
          if (typeof data !== 'object') continue;

          let chosen: PermissionDecision | undefined = data['sendMessages'];
          for (const key of DM_PERMISSION_KEYS) {
            const incoming = data[key];
            if (incoming) {
              if (!chosen || (RESTRICTIVENESS[incoming] || 0) > (RESTRICTIVENESS[chosen] || 0)) {
                chosen = incoming;
              }
              delete data[key];
              changed = true;
            }
          }
          if (chosen && data['sendMessages'] !== chosen) {
            data['sendMessages'] = chosen;
            changed = true;
          }
        }
      }
      if (changed) await this.#commit(perms);
    });
  }

  // ── Internals ──

  /**
   * Which bucket the current mode reads and writes, or `null` when there is none.
   *
   * In global mode that is always `_default`. In per-account mode it is the account's own
   * bucket, and an empty `accountId` yields `null` rather than falling back to `_default` —
   * see the divergence note in the module doc. `null` reads as an empty bucket, so the
   * answer is `ask`, and it refuses a write outright. The type makes the id required; this
   * is the runtime half, for a caller that built an empty one from a variable.
   */
  async #activeBucket(accountId: string): Promise<string | null> {
    if (await this.getUseGlobalDefaults()) return DEFAULT_BUCKET;
    return accountId || null;
  }

  /** The bucket to write into, or an error: a write with nowhere to go is a caller bug. */
  async #writeBucket(accountId: string): Promise<string> {
    const bucket = await this.#activeBucket(accountId);
    if (bucket === null) {
      throw new Error(
        'per-account permissions mode needs an accountId: refusing to write to the shared _default bucket',
      );
    }
    return bucket;
  }

  async #load(): Promise<PermissionMap> {
    if (this.#cachedPerms !== null) return this.#cachedPerms;
    this.#cachedPerms = (await this.#store.get<PermissionMap>(PERMISSIONS_STORAGE_KEY)) ?? {};
    return this.#cachedPerms;
  }

  /**
   * A private copy of the tree for a mutator to edit.
   *
   * Every write works on one of these, so the cache is never the thing being edited. Reads
   * are not serialized against writes — a `check` can land at any moment — and if a mutator
   * edited the cache directly, a `check` arriving while the store write was still in flight
   * would answer from a decision that had not been persisted yet. For an authorization
   * cache that window is the whole problem: it is briefly more permissive than the disk
   * behind it. Editing a copy closes it, because the cache only ever changes when
   * {@link #commit} drops it, after the write has actually landed.
   */
  async #draft(): Promise<PermissionMap> {
    return cloneJson(await this.#load());
  }

  /**
   * Writes a draft back and drops the cache, so the next read reloads from the store.
   *
   * The drop is in a `finally` as belt and braces. The draft is not the cached object, so a
   * rejected write already leaves the cache untouched and correct; invalidating anyway
   * means a partially-applied write from a store that fails in some less tidy way still
   * cannot leave a stale answer behind.
   */
  async #commit(perms: PermissionMap): Promise<void> {
    try {
      await this.#store.set(PERMISSIONS_STORAGE_KEY, perms);
    } finally {
      this.invalidateCache();
    }
  }
}
