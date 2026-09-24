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
 * Nothing here decides how a request is *routed* — local signing versus a remote signer is
 * the signer's business, not the permission's. A permission answers one question: may this
 * caller do this.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/07.md NIP-07
 */
import type { KeyValueStore } from '@nostr-wot/storage';
import {
  DEFAULT_BUCKET,
  GLOBAL_DEFAULTS_KEY,
  MIGRATION_VERSION,
  MIGRATION_VERSION_KEY,
  PERMISSIONS_STORAGE_KEY,
} from './constants.js';
import { permissionKey, resolveDetailed } from './key.js';
import { AsyncLock } from './lock.js';
import { originPermissionBucket, siteScopes } from './scope.js';
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

/** The DM-kind keys {@link Permissions.migrateDmKindsToSendMessages} folds away. */
const DM_PERMISSION_KEYS = ['signEvent:4', 'signEvent:13', 'signEvent:14', 'signEvent:1059'];

/**
 * How restrictive each decision is. Used only when merging two rules into one, where the
 * conservative choice is the one the user is least likely to be surprised by: someone who
 * once denied a DM-related signature stays denied.
 */
const RESTRICTIVENESS: Record<string, number> = { allow: 1, ask: 2, deny: 3 };

/** Retired decision value, from when NIP-46 accounts auto-forwarded to a remote signer. */
const RETIRED_FORWARD = 'forward' as PermissionDecision;

/** Blanket keys the per-kind model made meaningless. */
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
   * @param kind - the event kind, when the method is `signEvent`
   * @param accountId - the active account; ignored while global defaults are on
   */
  async check(
    origin: string,
    method: string,
    kind?: number,
    accountId?: string,
  ): Promise<PermissionDecision> {
    const bucket = await this.getForOrigin(origin, accountId);
    const { decision, key } = resolveDetailed(bucket, method, kind);

    if (decision === 'deny') {
      this.#logger?.warn('permission denied', { origin, key, method, kind });
    }
    return decision;
  }

  /** Every origin's rules in the active bucket: `{ origin: { permissionKey: decision } }`. */
  async getAll(accountId?: string): Promise<Record<string, PermissionBucket>> {
    const perms = await this.#load();
    const bucket = await this.#activeBucket(accountId);
    const result: Record<string, PermissionBucket> = {};
    for (const origin of Object.keys(perms)) {
      const data = perms[origin][bucket];
      if (data && Object.keys(data).length > 0) result[origin] = { ...data };
    }
    return result;
  }

  /** One origin's effective rules in the active bucket, legacy scopes folded in. */
  async getForOrigin(origin: string, accountId?: string): Promise<PermissionBucket> {
    const perms = await this.#load();
    return originPermissionBucket(perms, origin, await this.#activeBucket(accountId));
  }

  /** The whole stored tree, every bucket, as a copy. For settings screens and diffs. */
  async getAllRaw(): Promise<PermissionMap> {
    return structuredClone(await this.#load());
  }

  /** One origin's buckets, all of them, as a copy. */
  async getForOriginRaw(origin: string): Promise<OriginPermissions> {
    const perms = await this.#load();
    return structuredClone(perms[origin] ?? {});
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
    await this.#store.set(GLOBAL_DEFAULTS_KEY, !!enabled);
    this.invalidateCache();
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
    accountId?: string,
  ): Promise<void> {
    await this.saveDirect(origin, permissionKey(method, kind), decision, accountId);
  }

  /**
   * Records a decision under a key verbatim, for a UI that edits keys directly and for
   * seeding a store with pre-migration data.
   */
  async saveDirect(
    origin: string,
    key: string,
    decision: PermissionDecision,
    accountId?: string,
  ): Promise<void> {
    await this.#lock.run(async () => {
      const perms = await this.#load();
      const bucket = await this.#activeBucket(accountId);
      if (!perms[origin]) perms[origin] = {};
      if (!perms[origin][bucket]) perms[origin][bucket] = {};
      perms[origin][bucket][key] = decision;
      await this.#commit(perms);
    });
  }

  /**
   * Clears one origin's rules in the active bucket, or, with no origin, every rule there is.
   */
  async clear(origin?: string, accountId?: string): Promise<void> {
    if (!origin) {
      await this.#store.remove(PERMISSIONS_STORAGE_KEY);
      this.invalidateCache();
      return;
    }
    await this.#lock.run(async () => {
      const perms = await this.#load();
      const bucket = await this.#activeBucket(accountId);
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
    if (!origin) return;
    await this.#lock.run(async () => {
      const perms = await this.#load();
      for (const scope of siteScopes(origin)) delete perms[scope];
      await this.#commit(perms);
    });
  }

  /** Removes one account's overrides everywhere. Called when an account is deleted. */
  async clearForAccount(accountId: string): Promise<void> {
    if (!accountId || accountId === DEFAULT_BUCKET) return;
    await this.#lock.run(async () => {
      const perms = await this.#load();
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
   * @param fromAccountId - the source account, or null for {@link DEFAULT_BUCKET}
   * @param toAccountId - the target account
   */
  async copyPermissions(fromAccountId: string | null, toAccountId: string): Promise<void> {
    if (!toAccountId) return;
    await this.#lock.run(async () => {
      const from = fromAccountId || DEFAULT_BUCKET;
      const perms = await this.#load();
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
   * @param newAccountId - the account just created
   * @param existingAccountIds - every other account id, to preserve across the mode switch
   * @param copyFromAccountId - a source to copy into the new account, or null for fresh
   */
  async setupNewAccountPermissions(
    newAccountId: string,
    existingAccountIds: string[],
    copyFromAccountId: string | null,
  ): Promise<void> {
    if (!newAccountId) return;

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
   * Drops the blanket keys the per-kind model retired.
   *
   * A stored `signEvent: allow` used to mean "any event", which is a far broader grant
   * than anything the current UI can express, so it is removed rather than reinterpreted.
   * The logical group keys (`sendMessages`, `readMessages`) are not blanket keys and stay.
   */
  async migrateToPerKind(): Promise<void> {
    await this.#lock.run(async () => {
      const perms = await this.#load();
      let changed = false;
      for (const origin of Object.keys(perms)) {
        const target = perms[origin];
        if (target[DEFAULT_BUCKET]) {
          for (const bucket of Object.keys(target)) {
            if (typeof target[bucket] !== 'object') continue;
            for (const key of BLANKET_KEYS) {
              if (target[bucket][key]) {
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
            if (flat[key]) {
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
      const perms = await this.#load();
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
      const perms = await this.#load();
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
      const perms = await this.#load();
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

  /** Which bucket the current mode reads and writes. */
  async #activeBucket(accountId?: string): Promise<string> {
    return (await this.getUseGlobalDefaults()) ? DEFAULT_BUCKET : accountId || DEFAULT_BUCKET;
  }

  async #load(): Promise<PermissionMap> {
    if (this.#cachedPerms !== null) return this.#cachedPerms;
    this.#cachedPerms = (await this.#store.get<PermissionMap>(PERMISSIONS_STORAGE_KEY)) ?? {};
    return this.#cachedPerms;
  }

  /** Writes the tree back and drops the cache, so the next read sees what was stored. */
  async #commit(perms: PermissionMap): Promise<void> {
    await this.#store.set(PERMISSIONS_STORAGE_KEY, perms);
    this.invalidateCache();
  }
}
