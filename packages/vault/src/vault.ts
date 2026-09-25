/**
 * The vault lifecycle: create, unlock, lock, scoped key access, auto-lock and the guard.
 *
 * Ported from the browser extension's `src/services/vault/vault.ts` and the account access it
 * delegates to in `src/services/vault/accountAccess.ts`, with three substitutions and nothing
 * else moved: `browser.storage.local` becomes the injected {@link KeyValueStore}, WebCrypto
 * becomes the injected {@link Pbkdf2Port} plus this package's own AES-GCM, and the extension's
 * module-level singleton becomes an instance. Everything that only makes sense inside a
 * service worker — the keep-alive alarm, the startup auto-unlock gate, the session-revision
 * revocation — stays with the host.
 *
 * This is the component that holds users' private keys in memory and decides when to let go of
 * them, so the memory rules are not incidental:
 *
 *   - every secret is a `Uint8Array`, never a string, because a string cannot be overwritten;
 *   - {@link Vault.lock} zeroes those arrays rather than dropping the references;
 *   - {@link Vault.withPrivkey} hands out a copy and zeroes it in a `finally`, so a caller
 *     cannot forget to and cannot reach the vault's own buffer;
 *   - {@link Vault.listAccounts} and every other public projection go through `toSafeAccount`,
 *     which copies an allowlist rather than deleting known secrets, so a field added to
 *     `Account` later is private until someone says otherwise.
 *
 * There are exactly TWO members that hand out secrets outside a scoped callback, and they are
 * named here so the list above cannot be read as covering them: {@link Vault.getDecryptedPayload}
 * and {@link Vault.getAccountForRemoteSigning}. Each carries, where it is defined, what it costs
 * and the narrow reason it exists. Every other accessor either projects public metadata or takes
 * a callback.
 *
 * The one secret held as anything other than a zeroable array is the derived vault key, which
 * is a `Uint8Array` too — the extension holds a non-extractable `CryptoKey`, which is strictly
 * better and is not available on every host this package targets. It is zeroed on lock with
 * everything else. The password itself is never retained.
 */
import { randomBytes } from '@noble/ciphers/utils.js';
import type { Account, Nip46Config, SafeAccount } from '@nostr-wot/accounts';
import { toSafeAccount } from '@nostr-wot/accounts';
import type { KeyValueStore } from '@nostr-wot/storage';
import { shouldAutoLock } from './autolock.js';
import {
  AUTO_LOCK_STORAGE_KEY,
  DEFAULT_AUTO_LOCK_MS,
  LEGACY_VAULT_PBKDF2_ITERATIONS,
  LOCK_STATE_KEY,
  MIN_PASSWORD_LENGTH,
  UNLOCK_GUARD_KEY,
  VAULT_KEY_BYTES,
  VAULT_STORAGE_KEY,
  VAULT_VERSION,
} from './constants.js';
import { encrypt, iterationsFor, noblePbkdf2, type Pbkdf2Port } from './crypto.js';
import {
  emptyGuardState,
  guardLockoutRemaining,
  nextGuardState,
  type UnlockGuardState,
} from './guard.js';
import { openRecord, sealPayload } from './record.js';
import {
  bytesToBase64,
  bytesToHexBytes,
  hexBytesToBytes,
  toMemoryAccount,
  toMemoryPayload,
  toStorageAccount,
  toStoragePayload,
  zeroMemoryAccount,
  zeroMemoryPayload,
} from './serialization.js';
import type {
  MemoryAccount,
  MemoryVaultPayload,
  OpaqueWalletConfig,
  VaultPayload,
  VaultRecord,
} from './types.js';

/** What a {@link Vault} needs from its host. */
export interface VaultOptions {
  /** Where the record, the lock marker, the guard and the interval live. */
  store: KeyValueStore;
  /** Password stretching. Defaults to {@link noblePbkdf2}, which needs nothing native. */
  kdf?: Pbkdf2Port;
  /**
   * The clock. Injectable so the guard and the auto-lock can be tested without waiting, and
   * the ONE clock of the system: `@nostr-wot/signer-core` reads it back from the vault for
   * its cooldowns, timestamps and queue, so faking time is done here, once. Defaults to
   * `Date.now`, and this is the only default clock anywhere in the shared packages.
   */
  now?: () => number;
}

/** The derived key the vault keeps so it can re-seal without asking for the password again. */
interface HeldKey {
  key: Uint8Array;
  salt: Uint8Array;
  iterations: number;
}

/**
 * Public account metadata plus, for a remote-signer account, the public half of its NIP-46
 * configuration: enough to say "connected to bunker X over relay Y", never the credentials.
 * The credentials go through {@link Vault.withRemoteSignerCredentials}.
 */
export type VaultAccount = SafeAccount & {
  nip46?: { bunkerPubkey: string | null; relay: string | null; localPubkey?: string };
};

/**
 * {@link VaultAccount} plus the host-owned wallet configuration the record carried.
 *
 * `walletConfig` is {@link OpaqueWalletConfig}: JSON this package stores, round trips and does
 * not interpret. See that type for why it is not modelled here.
 */
export type VaultAccountWithWallet = SafeAccount & { walletConfig?: OpaqueWalletConfig };

/**
 * What {@link Vault.getAccountForRemoteSigning} hands back: public metadata plus a NIP-46
 * account's full configuration, credentials included, as strings.
 *
 * One of the two members that hand out secrets outside a scoped callback. See that method for
 * why, and for what it costs.
 */
export type RemoteSignerAccount = SafeAccount & { nip46Config: Nip46Config };

/** What {@link Vault.withRemoteSignerCredentials} hands its callback. Every byte array is zeroed on return. */
export interface RemoteSignerCredentials {
  bunkerUrl: string;
  relay: string | null;
  localPubkey?: string;
  /** The stored local keypair's 32-byte private key, or null when none has been stored yet. */
  localPrivkey: Uint8Array | null;
  /** The connect token as UTF-8, or null when the bunker needs none. */
  secret: Uint8Array | null;
}

/** An externally generated ML-KEM / ML-DSA pair, as {@link Vault.setImportedPqKeys} takes it. */
export interface PqKeyPair {
  kem: { publicKey: Uint8Array; secretKey: Uint8Array };
  dsa: { publicKey: Uint8Array; secretKey: Uint8Array };
}

/** What {@link Vault.withImportedPqKeys} hands its callback. The two secrets are zeroed on return. */
export interface ImportedPqKeys {
  profile: string;
  /** Base64, as stored. */
  kemPublic: string;
  /** Base64, as stored. */
  dsaPublic: string;
  kemSecret: Uint8Array;
  dsaSecret: Uint8Array;
}

/** A change to the open payload: applied in memory, persisted, undone if the write fails. */
interface Mutation {
  /** Reverts the in-memory change. Runs only when the store refused the write AND the session is still alive. */
  undo: () => void;
  /** Runs once the write has landed; where outgoing secrets get zeroed. */
  commit?: () => void;
  /**
   * Runs when the store refused the write and the session died meanwhile. Zeroes every
   * secret the mutation detached or created: there is no payload left to restore into, only
   * a dead one no lock will ever visit again.
   */
  abandon: () => void;
}

const BUNKER_PUBKEY = /^bunker:\/\/([0-9a-fA-F]{64})(?:[/?#]|$)/;

/** Thrown by {@link Vault.unlock} while the brute-force guard is refusing attempts. */
export class VaultLockedOutError extends Error {
  constructor(readonly remainingMs: number) {
    super(`Too many failed attempts. Try again in ${Math.ceil(remainingMs / 1000)}s`);
    this.name = 'VaultLockedOutError';
  }
}

/**
 * A detached deep copy, through JSON.
 *
 * Everything cloned here — a payload, a NIP-46 config, a host's `walletConfig` — is JSON by
 * construction, because it came out of (or is going into) the sealed record, which is
 * `JSON.stringify`d. A JSON round trip is therefore an exact clone of it and needs nothing from
 * the host: `structuredClone` is a global this package cannot assume, and it is what the
 * extension used. Values the vault holds as `Uint8Array` never reach here; they go through the
 * scoped accessors instead.
 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertPassword(password: string, what: string): void {
  if (password.length > 0 && password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`${what} must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

export class Vault {
  readonly #store: KeyValueStore;
  readonly #kdf: Pbkdf2Port;
  readonly #now: () => number;
  /** The clock this vault was built with; what everything downstream of it reads. */
  readonly now: () => number;

  /** The decrypted vault, or null when locked. The only place key material lives. */
  #payload: MemoryVaultPayload | null = null;
  /** The key the payload was opened with, so a save need not re-derive. Zeroed on lock. */
  #held: HeldKey | null = null;
  #autoLockMs = DEFAULT_AUTO_LOCK_MS;
  #autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  #lastActivity = 0;
  /** One lane for every mutation, so two unlocks cannot interleave their writes. */
  #lane: Promise<unknown> = Promise.resolve();
  /**
   * Which session the vault is on. Ported from the extension's `sessionRevision`.
   *
   * The lane alone is not enough, and the difference is the whole reason this counter exists.
   * The lane decides the ORDER of two writes; it cannot express that one of them should no
   * longer happen at all. `lock()` and `destroy()` are synchronous by design — locking must
   * never queue behind a derivation it is trying to cancel — so an unlock that was already in
   * flight goes on to finish and repopulate a vault the user has just locked or destroyed. At
   * 600000 iterations that window is about a second wide, which is every lock-on-blur, every
   * panic lock and every auto-lock that happens to fire mid-unlock.
   *
   * So every operation that will install a session captures this number BEFORE it queues, and
   * refuses to install anything if it has moved by the time it gets there. A lock always wins.
   */
  #sessionRevision = 0;
  /**
   * The secret copies held by in-flight scoped callbacks: {@link withPrivkey}'s key and every
   * sibling's, {@link withDerivedSecrets}' included.
   *
   * Tracked so that a lock reaches them too: without it a callback that is already running
   * keeps signing with live key material for as long as it likes while `isLocked()` reports
   * true. These are copies, or buffers handed over for the purpose, so zeroing them cannot
   * corrupt the vault.
   */
  readonly #liveKeys = new Set<Uint8Array>();

  /**
   * The host's subscriptions. Ported from the extension's module-level sets, because a host's
   * private cache, wallet client and social-graph layer all have state that is only valid while
   * one vault session is, and polling `isLocked()` is not a substitute: the moment that matters
   * is the transition, and an auto-lock fires on a timer nobody is watching.
   *
   * `#lockListeners` and `#sessionListeners` are synchronous, because `lock()` is and must stay
   * so. `#unlockListeners` and `#destroyListeners` are awaited, because both have real work to
   * finish before the host proceeds — re-encrypting a cache under a key that only exists while
   * unlocked, and deleting derived data that must not outlive the vault.
   */
  readonly #lockListeners = new Set<() => void>();
  readonly #sessionListeners = new Set<() => void>();
  readonly #unlockListeners = new Set<() => Promise<void>>();
  readonly #destroyListeners = new Set<() => Promise<void>>();

  /** The in-flight startup auto-unlock, if any. See {@link beginStartupUnlock}. */
  #startupUnlock: Promise<void> | null = null;

  constructor(options: VaultOptions) {
    this.#store = options.store;
    this.#kdf = options.kdf ?? noblePbkdf2;
    this.#now = options.now ?? Date.now;
    this.now = this.#now;
  }

  // ── State ─────────────────────────────────────────────────────────────────────────────

  /** Is there a vault record in storage at all? */
  async exists(): Promise<boolean> {
    return (await this.#readRecord()) !== undefined;
  }

  /** Synchronous, like the extension's: a caller gating on it cannot afford to await. */
  isLocked(): boolean {
    return this.#payload === null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────────────

  /**
   * Create (or replace) the vault, leaving it unlocked.
   *
   * An empty password is intentional and is how "never lock" mode is stored: the record is
   * still AES-256-GCM encrypted, so what sits at rest is never plaintext, but the password is
   * one the host's own source supplies, so the encryption is defence in depth rather than a
   * secret. See `LEGACY_VAULT_PBKDF2_ITERATIONS` for why it is not stretched as hard.
   *
   * The first account becomes the active one. Calling this on an open vault — a password
   * change, a lock-mode switch — carries the existing cache key across, so nothing already
   * written to the private cache becomes unreadable, and zeroes the old buffers before
   * dropping them.
   */
  async create(password: string, accounts: Account[]): Promise<void> {
    assertPassword(password, 'Password');
    if (new Set(accounts.map((account) => account.id)).size !== accounts.length) {
      throw new Error('Account ids must be unique');
    }
    // This replaces whatever session was open, so anything already in flight against the old
    // one is cancelled here rather than allowed to land on top of the new vault.
    this.#invalidateSession();
    const revision = this.#sessionRevision;
    return this.#run(async () => {
      this.#assertRevision(revision);
      // Read before the old payload is zeroed, and as a string so nothing survives as a view
      // into a buffer that is about to be filled with zeroes.
      const cacheKey = this.#payload?.cacheKeyBytes
        ? bytesToBase64(this.#payload.cacheKeyBytes)
        : bytesToBase64(randomBytes(VAULT_KEY_BYTES));
      const stored: VaultPayload = {
        cacheKey,
        accounts,
        activeAccountId: accounts[0]?.id ?? null,
      };

      const capture = this.#capturingKdf();
      try {
        const record = await sealPayload(stored, password, capture.kdf);
        this.#assertRevision(revision);
        await this.#store.set(VAULT_STORAGE_KEY, record);
        // A new vault starts with a clean slate. Otherwise "I forgot my password, start over"
        // hands the user a brand-new vault they are still locked out of.
        await this.#store.remove(UNLOCK_GUARD_KEY);

        this.#assertRevision(revision);
        this.#adoptPayload(toMemoryPayload(stored));
        this.#adoptKey(capture.take());
        await this.#restoreAutoLockSetting();
        this.#noteLockStateChanged();
        await this.#notifyUnlocked();
      } finally {
        // Nothing below take() can throw, but everything above it can, and a derived vault key
        // dropped un-zeroed on an error path is exactly the leak this class exists to avoid.
        capture.discard();
      }
    });
  }

  /**
   * Open the vault with a password. `false` means the password was wrong.
   *
   * Throws instead when there is no vault to open, and when the brute-force guard is refusing
   * attempts — both are conditions a caller has to be able to tell apart from a typo.
   *
   * The guard is consulted BEFORE the derivation, which is the point of having it: a lockout
   * that still costs a second of PBKDF2 per attempt is a lockout an attacker can spend in
   * parallel.
   *
   * On success, and only on success, the previously decrypted buffers are zeroed and replaced.
   * A wrong password typed against an already open vault — the change-password flow does
   * exactly that — must not destroy the session it was checked against.
   *
   * Two repairs then run while the password is in hand, which is the only moment they can:
   * the record is re-sealed at the current work factor if it was written at a lower one, and
   * re-saved if the reader had to mint a cache key because the record predates that field. A
   * failed upgrade is not fatal (the vault is open and the old record is still valid); a
   * failed cache-key save is, because the in-memory key would no longer match the stored one.
   */
  async unlock(password: string): Promise<boolean> {
    // Captured before queueing, so a lock or a destroy taken while this waits for the lane —
    // or while it is inside the derivation — cancels it instead of being undone by it.
    const revision = this.#sessionRevision;
    return this.#run(async () => {
      if (revision !== this.#sessionRevision) return false;

      const guard = await this.#readGuard();
      const remaining = guardLockoutRemaining(guard, this.#now());
      if (remaining > 0) throw new VaultLockedOutError(remaining);

      const record = await this.#readRecord();
      if (!record) throw new Error('No vault found');

      const capture = this.#capturingKdf();
      try {
        let opened;
        try {
          opened = await openRecord(record, password, capture.kdf);
        } catch {
          // Wrong password, or a corrupt record. Either way nothing about the current session
          // changes except the counter.
          await this.#store.set(UNLOCK_GUARD_KEY, nextGuardState(guard, false, this.#now()));
          return false;
        }

        // The check that matters: the derivation is the second-long window, and this is the
        // first moment after it at which anything would be installed. Overtaken means false —
        // the password was right, so charging the guard would walk an ordinary lock-on-blur
        // towards a lockout.
        if (revision !== this.#sessionRevision) return false;

        this.#adoptPayload(toMemoryPayload(opened.payload));
        this.#adoptKey(capture.take());
        await this.#store.remove(UNLOCK_GUARD_KEY);
        await this.#restoreAutoLockSetting();
        if (revision !== this.#sessionRevision) return false;

        const storedIterations = record.iterations ?? LEGACY_VAULT_PBKDF2_ITERATIONS;
        if (storedIterations < iterationsFor(password)) {
          try {
            await this.#resealNow(password, revision);
          } catch {
            // An upgrade that fails must never cost the user their unlocked session: the vault
            // is open and the record that opened it is still perfectly valid.
          }
        }
        if (opened.cacheKeyMinted) {
          try {
            await this.#saveNow(revision);
          } catch (error) {
            // A session that moved under us is not a failed save; it is a lock winning, and
            // the lock has already zeroed everything.
            if (revision !== this.#sessionRevision) return false;
            // Ends the session like every other lock does, so an unlock queued against this
            // one is told it has been overtaken rather than marching on into the same failure.
            this.#invalidateSession();
            this.#lockNow();
            this.#noteLockStateChanged();
            throw error;
          }
        }
        if (revision !== this.#sessionRevision) return false;

        this.#noteLockStateChanged();
        await this.#notifyUnlocked();
        return true;
      } finally {
        capture.discard();
      }
    });
  }

  /**
   * Lock the vault, zeroing every byte of key material it holds.
   *
   * Synchronous and unconditional, like the extension's: locking is the one operation that
   * must not be able to fail, wait on a lane, or depend on a storage write succeeding. The
   * lock-state marker is written fire and forget for exactly that reason.
   */
  lock(): void {
    // Bump first: anything in flight has to see that it has been overtaken, whatever order the
    // lane hands it back in.
    this.#invalidateSession();
    this.#lockNow();
    this.#noteLockStateChanged();
    for (const listener of this.#lockListeners) {
      try {
        listener();
      } catch {
        /* One cleanup must not prevent another, and a lock cannot be allowed to fail. */
      }
    }
  }

  /**
   * Destroy the vault: locked, and the record removed from storage.
   *
   * Irreversible. Every account and key in it is gone unless the user has their seed phrase.
   * The guard goes with it — there is nothing left to brute force.
   */
  async destroy(): Promise<void> {
    this.lock();
    await this.#run(async () => {
      await this.#store.remove(VAULT_STORAGE_KEY);
      await this.#store.remove(UNLOCK_GUARD_KEY);
      // Before the lane releases, so a host's derived data is gone by the time this resolves.
      // Awaited rather than fired: a private cache that outlives the vault it was keyed to is
      // exactly what "irreversible" must not leave behind.
      for (const listener of this.#destroyListeners) {
        try {
          await listener();
        } catch {
          /* One host's cleanup failing must not leave the record in place. */
        }
      }
      // Belt and braces. The revision check makes an overtaken unlock refuse to install
      // anything, and this makes the outcome of a destroy independent of the lane order
      // regardless: when this returns, there is no session, full stop.
      this.#lockNow();
    });
  }

  /**
   * Re-seal the vault under a new password. `false` means `current` was wrong.
   *
   * The empty password is refused here even though it is legitimate elsewhere. It is how
   * "never lock" mode is stored, and arriving there through a *password change* would leave a
   * vault that still presents as password-protected while anyone can open it, with the user's
   * old password silently no longer working. The only route into that mode is a deliberate
   * {@link create} under the empty password, which a host asks about first.
   *
   * Verifying `current` goes through {@link unlock}, so a wrong one is charged to the guard.
   * The extension checks it against the vault directly and escapes the counter that way; a
   * password attempt is a password attempt, and this entry point should not be the cheap one.
   */
  async changePassword(current: string, next: string): Promise<boolean> {
    if (next.length === 0) throw new Error('New password is required');
    assertPassword(next, 'Password');
    if (!(await this.unlock(current))) return false;
    // The re-seal itself is {@link reEncrypt}, so there is one implementation of it and the
    // difference between the two entry points is only whether a password is verified first.
    // Throws rather than returning false if it fails: false means the current password was
    // wrong, and this was not that.
    await this.reEncrypt(next);
    return true;
  }

  /**
   * Re-seal the ALREADY OPEN vault under `next`, with a fresh salt and the current work factor.
   * No current password, because none is needed and asking for one would be worse.
   *
   * The distinction from {@link changePassword}, which is the whole reason both exist:
   * `changePassword` verifies `current` through {@link unlock}, so a wrong one is charged to the
   * brute-force guard — correct for a password-change form, where a wrong current password IS a
   * failed attempt. This path verifies nothing. The vault is open, the payload is in memory, and
   * the callers are a transparent work-factor upgrade, a lock-mode switch and a host's own
   * change-password handler that has already checked the user. Routing those through
   * `changePassword` would spend a second of PBKDF2 re-deriving a key already held and walk the
   * user towards a lockout for something they never typed.
   *
   * The session stays open across it: the payload is untouched, only the record and the held key
   * change. The empty password is refused here for the reason {@link changePassword} refuses it —
   * it is how "never lock" mode is stored, and arriving there through a *password change* leaves
   * a vault that still presents as protected while anyone can open it. The only route into that
   * mode is a deliberate {@link create} under the empty password.
   *
   * @throws if the vault is locked, `next` is empty or shorter than the minimum, or a lock landed
   *         while the derivation ran — in which case the record is still valid and only this
   *         session is over
   */
  async reEncrypt(next: string): Promise<void> {
    if (next.length === 0) throw new Error('New password is required');
    assertPassword(next, 'Password');
    // Refused before the lane, so a locked vault is told so rather than queueing behind work
    // that will refuse it anyway.
    this.#requireOpen();
    // Captured before the re-seal queues, so a lock landing inside its own derivation — which
    // the auto-lock can do on its own, no adversary required — cancels it instead of installing
    // a live vault key into a vault the user has locked.
    const revision = this.#sessionRevision;
    await this.#run(() => this.#resealNow(next, revision));
  }

  // ── Auto-lock ─────────────────────────────────────────────────────────────────────────

  /** The configured idle interval in milliseconds; 0 is never. Persisted, so it survives. */
  async getAutoLockMs(): Promise<number> {
    const stored = await this.#store.get<number>(AUTO_LOCK_STORAGE_KEY);
    return typeof stored === 'number' ? stored : DEFAULT_AUTO_LOCK_MS;
  }

  /**
   * Choose the idle interval and re-arm the timer.
   *
   * Setting 0 ("never lock") records the preference and stops the timer; it does NOT
   * re-encrypt the vault under the empty password, and a vault that still has a real password
   * will simply stay open until the process ends. Crossing into or out of never-lock mode is
   * a {@link create} under the other password, which is a decision for the host to put to the
   * user rather than a side effect of a settings toggle.
   */
  async setAutoLockMs(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('Auto-lock interval must be >= 0');
    await this.#store.set(AUTO_LOCK_STORAGE_KEY, ms);
    this.#autoLockMs = ms;
    this.#armAutoLock();
  }

  /**
   * {@link setAutoLockMs}, synchronously: the timer is re-armed before this returns and the
   * preference is written fire and forget.
   *
   * Both shapes exist because both are right somewhere, and which one a caller wants is decided
   * by what it needs to be true when the call returns. A settings screen that shows a saved
   * state awaits {@link setAutoLockMs} and can report a failed write. A host tightening the
   * interval — a lock-on-blur, a policy change, a mode switch inside a larger synchronous
   * handler — needs the TIMER re-armed now and cannot await anything; making it wait on a
   * storage round trip leaves the vault on the old, longer interval for the duration of the
   * write, which is the wrong way round for a security control.
   *
   * So the ordering here is deliberate: the interval takes effect first, and the persistence
   * follows. A dropped write costs the user their preference on the next cold start, which is
   * recoverable; a delayed re-arm costs them the lock they just asked for.
   *
   * Validation is synchronous and throws, exactly as {@link setAutoLockMs} rejects.
   */
  setAutoLockTimeout(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('Auto-lock interval must be >= 0');
    this.#autoLockMs = ms;
    this.#armAutoLock();
    void Promise.resolve(this.#store.set(AUTO_LOCK_STORAGE_KEY, ms)).catch(() => {});
  }

  // ── Accounts ──────────────────────────────────────────────────────────────────────────

  /**
   * Run `fn` with the account's private key, and zero the copy afterwards on every path.
   *
   * This replaces a `getPrivkey()` that handed out bytes with a comment telling the caller to
   * zero them, which makes the guarantee only as good as the memory of each call site — and
   * at least one call site had already forgotten. Here an early return, a throw or a lock
   * mid-callback cannot skip the zeroing, and the buffer is a copy, so a callback that mangles
   * it cannot corrupt the vault.
   *
   * **`fn` must compute and return, and must not externalize anything.** Sign, encrypt, derive
   * — then hand the result back and let the caller decide what to do with it. A lock taken
   * while `fn` is running zeroes the copy and makes this call throw, so nothing computed under
   * a revoked session is returned; but throwing cannot unsend. A callback that signs AND
   * publishes — a relay publish, an HTTP POST, a DM send — has already put the event on the
   * wire by the time the throw happens, and no one can recall it. Every side effect belongs
   * outside `withPrivkey`, downstream of the value it returns.
   *
   * This voids a result; it does not interrupt a callback. A long-running `fn` keeps running
   * after a lock, it simply cannot return anything. Cancelling one needs an `AbortSignal` in
   * this contract, which belongs with whatever introduces long-lived signer handles.
   *
   * The same contract holds for every other scoped accessor on this class: {@link withMnemonic},
   * {@link withImportedPqKeys}, {@link withDerivedSecrets}, {@link withCacheKey} and
   * {@link withRemoteSignerCredentials}.
   *
   * `accountId` names the account and is required. The extension's copy takes `undefined` to
   * mean "whatever is active now", which is exactly the substitution the signing pipeline
   * exists to prevent: a request resolved and shown for one account must be signed by that
   * account's key, not by whichever one the user has since moved to. A caller that wants the
   * active account asks {@link getActiveAccountId} and passes the answer, so the choice is
   * visible at the call site.
   *
   * @throws if the vault is locked, the account has no private key, or the session was revoked
   *         while `fn` was running
   */
  async withPrivkey<T>(accountId: string, fn: (key: Uint8Array) => Promise<T>): Promise<T> {
    const account = this.#findAccount(this.#requireOpen(), accountId);
    if (!account?.privkeyBytes) throw new Error('No private key for this account');
    const key = new Uint8Array(account.privkeyBytes);
    return this.#scoped([key], () => fn(key));
  }

  /**
   * Run `fn` with the account's seed phrase as UTF-8 bytes; the copy is zeroed afterwards.
   *
   * For sub-account derivation and for showing the phrase. Same contract as
   * {@link withPrivkey}: compute and return, never externalize. A BIP-39 library that wants a
   * string gets one from the caller at the last moment, inside `fn`; the vault's own copy
   * stays zeroable.
   *
   * @throws if the vault is locked, the account has no mnemonic, or the session was revoked
   */
  async withMnemonic<T>(accountId: string, fn: (phrase: Uint8Array) => Promise<T>): Promise<T> {
    const account = this.#findAccount(this.#requireOpen(), accountId);
    if (!account?.mnemonicBytes) throw new Error('No seed phrase for this account');
    const phrase = new Uint8Array(account.mnemonicBytes);
    return this.#scoped([phrase], () => fn(phrase));
  }

  /**
   * Run `fn` with the account's imported post-quantum secret keys; both copies are zeroed
   * afterwards. Same contract as {@link withPrivkey}.
   *
   * Throws rather than returning null when the account has none: a caller that wants to fall
   * back to deriving from the seed asks {@link hasImportedPqKeys} first. A `T | null` return
   * would make an `fn` that legitimately returns null indistinguishable from "no keys".
   *
   * @throws if the vault is locked, the account has no imported keys, or the session was revoked
   */
  async withImportedPqKeys<T>(accountId: string, fn: (keys: ImportedPqKeys) => Promise<T>): Promise<T> {
    const account = this.#findAccount(this.#requireOpen(), accountId);
    if (!account?.pqPublic || !account.pqKemSecretBytes || !account.pqDsaSecretBytes) {
      throw new Error('No imported post-quantum keys for this account');
    }
    const kemSecret = new Uint8Array(account.pqKemSecretBytes);
    const dsaSecret = new Uint8Array(account.pqDsaSecretBytes);
    const { profile, kem: kemPublic, dsa: dsaPublic } = account.pqPublic;
    return this.#scoped([kemSecret, dsaSecret], () =>
      fn({ profile, kemPublic, dsaPublic, kemSecret, dsaSecret }),
    );
  }

  /**
   * Run `fn` with secret bytes the CALLER derived, under the same discipline every accessor
   * above runs under: the arrays are registered as live key material for the duration, so a
   * `lock()` taken while `fn` is running zeroes them where they are, and they are zeroed again
   * on the way out on every path. Same contract as {@link withPrivkey} otherwise — compute and
   * return, never externalize, and a result computed under a session that moved is void.
   *
   * For a secret the vault does not store and cannot hand out: the ML-KEM-1024 and ML-DSA-87
   * keys `@nostr-wot/signer-core` derives from an account's seed phrase per request, which are
   * a deterministic function of a mnemonic this vault does hold. Zeroing those in the deriver's
   * own `finally` covers a return and a throw, and misses the case that matters: `lock()` is
   * the user saying "let go of my keys now", and a derived secret the vault has never heard of
   * goes on living until the callback happens to finish. The vault is what promises that lock
   * reaches key material, so the register lives here rather than being re-implemented by every
   * caller that derives something.
   *
   * The arrays are taken over, not copied. Pass buffers you own and do not keep a second
   * reference: this method will fill them with zeroes.
   *
   * @throws if the vault is locked, or the session was revoked while `fn` was running
   */
  async withDerivedSecrets<T>(secrets: readonly Uint8Array[], fn: () => Promise<T>): Promise<T> {
    this.#requireOpen();
    return this.#scoped([...secrets], fn);
  }

  /**
   * Run `fn` with the 32-byte private-cache key; the copy is zeroed afterwards.
   *
   * The key that encrypts whatever the host caches on the user's behalf. Same contract as
   * {@link withPrivkey}. Every open vault has one: `unlock` mints a key for a record that
   * predates the field and re-seals, so there is no "no cache key" state to handle.
   */
  async withCacheKey<T>(fn: (key: Uint8Array) => Promise<T>): Promise<T> {
    const payload = this.#requireOpen();
    if (!payload.cacheKeyBytes) throw new Error('Vault is locked');
    const key = new Uint8Array(payload.cacheKeyBytes);
    return this.#scoped([key], () => fn(key));
  }

  /**
   * Run `fn` with a remote-signer account's NIP-46 configuration, secrets as bytes; every
   * byte array handed over is zeroed afterwards. Same contract as {@link withPrivkey}.
   *
   * The local private key comes decoded, 32 bytes, from the hex the record holds; the connect
   * token comes as UTF-8. Neither passes through a string on the way. `bunkerUrl` is a string
   * and is the address to connect to; it may carry the token in its query if the user pasted
   * one that did, so it is configuration, not something to show.
   *
   * @throws if the vault is locked, the account is not a NIP-46 account, or the session was
   *         revoked
   */
  async withRemoteSignerCredentials<T>(
    accountId: string,
    fn: (credentials: RemoteSignerCredentials) => Promise<T>,
  ): Promise<T> {
    const account = this.#findAccount(this.#requireOpen(), accountId);
    if (!account || account.type !== 'nip46' || !account.nip46) {
      throw new Error('This account is not a NIP-46 account');
    }
    const config = account.nip46;
    const localPrivkey = config.localPrivkeyBytes ? hexBytesToBytes(config.localPrivkeyBytes) : null;
    const secret = config.secretBytes ? new Uint8Array(config.secretBytes) : null;
    const copies = [localPrivkey, secret].filter((copy): copy is Uint8Array => copy !== null);
    return this.#scoped(copies, () =>
      fn({
        bunkerUrl: config.bunkerUrl,
        relay: config.relay,
        ...(config.localPubkey !== undefined ? { localPubkey: config.localPubkey } : {}),
        localPrivkey,
        secret,
      }),
    );
  }

  /**
   * Public account metadata, and only that. **Synchronous** — see the note below.
   *
   * Through `toSafeAccount`, which copies an explicit allowlist rather than deleting known
   * secrets: a field added to `Account` later is private until someone says otherwise, which
   * is the only default that fails safe. An account with no private key reports `readOnly`
   * whatever its stored flag says.
   *
   * ## Why this and its siblings are synchronous
   *
   * They were `async`, and that cost a consumer its migration. A shipping extension's account
   * accessors are synchronous and its suite calls them without `await` in 208 places; no adapter
   * can make an asynchronous method synchronous, so the package was unadoptable for a reason
   * that bought nothing — none of these methods ever awaited anything. They read `#payload`,
   * which is in memory by definition, because it exists only while the vault is unlocked.
   *
   * The rule that replaced the habit, and it is a rule rather than a case-by-case judgement:
   *
   *   - **reads over already-decrypted in-memory state are synchronous.** `isLocked`,
   *     `hasMnemonic`, `hasImportedPqKeys`, `getActiveAccountId`, `getActivePubkey`,
   *     `getActiveAccount`, `getActiveAccountWithWallet`, `getAccountById`, `listAccounts`,
   *     `getAccountForRemoteSigning`, `getDecryptedPayload`, `getSessionRevision`.
   *   - **anything that touches the injected `KeyValueStore` stays asynchronous**, because the
   *     store is a port and a host's may be a round trip: `exists`, `create`, `unlock`,
   *     `destroy`, `getAutoLockMs`, `setAutoLockMs`, every mutation, and every scoped accessor
   *     (which is async for its own reason — the callback is).
   *
   * So the async-ness is where it is load-bearing and nowhere else. `lock()` was already
   * synchronous and unconditional for the same family of reasons.
   */
  listAccounts(): SafeAccount[] {
    const payload = this.#payload;
    if (!payload) return [];
    return payload.accounts.map((account) => this.#toSafe(account));
  }

  /**
   * One account's public metadata by id, or null when there is no such account or the vault
   * is locked. A remote-signer account also carries the public half of its NIP-46 config
   * (the bunker's pubkey, the relay, the local pubkey) so a caller can name the connection;
   * the credentials go through {@link withRemoteSignerCredentials}.
   */
  getAccountById(accountId: string): VaultAccount | null {
    const payload = this.#payload;
    if (!payload) return null;
    const account = this.#findAccount(payload, accountId);
    if (!account) return null;
    const safe: VaultAccount = this.#toSafe(account);
    if (account.type === 'nip46' && account.nip46) {
      const match = BUNKER_PUBKEY.exec(account.nip46.bunkerUrl);
      safe.nip46 = {
        bunkerPubkey: match ? match[1]!.toLowerCase() : null,
        relay: account.nip46.relay,
        ...(account.nip46.localPubkey !== undefined ? { localPubkey: account.nip46.localPubkey } : {}),
      };
    }
    return safe;
  }

  /** The active account's id, or null when there is none — or when the vault is locked. */
  getActiveAccountId(): string | null {
    return this.#payload?.activeAccountId ?? null;
  }

  /**
   * The active account's public metadata, or null when there is none or the vault is locked.
   *
   * `getActiveAccountId()` then `getAccountById()` in one call, which is what a host does at
   * dozens of sites. Through the same allowlist as {@link listAccounts}, so it carries no
   * secret and no NIP-46 credential.
   */
  getActiveAccount(): SafeAccount | null {
    const payload = this.#payload;
    if (!payload || payload.activeAccountId === null) return null;
    const account = this.#findAccount(payload, payload.activeAccountId);
    return account ? this.#toSafe(account) : null;
  }

  /**
   * The active account's public key, or null when there is none or the vault is locked.
   *
   * The single most-called read in a signer: every "who am I" answer, every `getPublicKey`, every
   * header. Null rather than a throw while locked, because a pubkey is public and a surface
   * asking for it is not asking to be told the lock state through an exception.
   */
  getActivePubkey(): string | null {
    return this.getActiveAccount()?.pubkey ?? null;
  }

  /**
   * The active account plus the host-owned `walletConfig` the record carried, detached.
   *
   * The vault does not model that field — see {@link OpaqueWalletConfig} for why importing the
   * wallet's type here would invert the layering — but it does store it, so it has to be
   * readable. The config is deep-copied through JSON on the way out: it is JSON by construction
   * (it was sealed into the record), and a caller that mutated the object it got back would
   * otherwise be editing the open vault.
   */
  getActiveAccountWithWallet(): VaultAccountWithWallet | null {
    const payload = this.#payload;
    if (!payload || payload.activeAccountId === null) return null;
    const account = this.#findAccount(payload, payload.activeAccountId);
    if (!account) return null;
    const stored = (account as unknown as Record<string, unknown>)['walletConfig'];
    return {
      ...this.#toSafe(account),
      ...(stored === undefined ? {} : { walletConfig: cloneJson(stored) as OpaqueWalletConfig }),
    };
  }

  /**
   * The whole decrypted payload, secrets and all, as the storage shape. **An escape hatch.**
   *
   * One of the two members on this class that hands out key material outside a scoped callback,
   * and it is the broader of the two, so what it costs is written here rather than implied:
   * `privkey`, `mnemonic` and every NIP-46 credential come back as JavaScript STRINGS. A string
   * cannot be overwritten, so these copies are outside `lock()`'s reach entirely and stay in the
   * heap until the collector happens to reclaim them. That is the exact property the whole
   * memory shape of this package exists to provide, and this method does not provide it.
   *
   * It exists because two host operations cannot be expressed any other way, and both are real:
   *
   *   - **Re-creating the vault under a different password.** The never-lock switch calls
   *     `create(otherPassword, payload.accounts)` on a vault that is already open. `create`
   *     takes `Account[]`, so the payload has to come from somewhere, and there is no current
   *     password to re-derive it from.
   *   - **Showing the user their own seed phrase**, and reading a mnemonic whose word count
   *     decides whether post-quantum keys may be derived at all.
   *
   * Prefer, in this order: {@link getActiveAccount} / {@link listAccounts} for metadata,
   * {@link withMnemonic} and {@link withPrivkey} for a secret that is only computed with,
   * {@link reEncrypt} for a password change that does not change the lock mode. Reach for this
   * only for the two cases above, and let what it returns go out of scope immediately.
   *
   * A detached deep copy, through JSON: the payload is JSON by construction, and a caller
   * editing the object it got back would otherwise be editing the open vault.
   *
   * @throws if the vault is locked. Deliberately, rather than answering an empty payload: a
   *         caller about to re-seal from this must not seal an empty vault over a full one.
   */
  getDecryptedPayload(): VaultPayload {
    return cloneJson(toStoragePayload(this.#requireOpen()));
  }

  /**
   * A NIP-46 account's public metadata plus its full configuration, credentials as strings, or
   * null when the account is not a remote signer. **The second escape hatch.**
   *
   * `withRemoteSignerCredentials` is the right shape for everything that computes and returns,
   * and it cannot express the one thing a NIP-46 host actually does: hold a connected bunker
   * client for the life of a session. The client owns a local keypair, reconnects with it, and
   * outlives any callback by design, so the credentials have to leave the vault. Cancelling such
   * a handle needs an `AbortSignal` contract that belongs with whatever introduces long-lived
   * signers; until then a host pins its client to {@link getSessionRevision} and drops it from
   * {@link onSessionInvalidated}, which is what makes a lock reach a live bunker connection.
   *
   * What it costs: the connect token and the local private key come back as strings, outside
   * `lock()`'s reach, exactly as on {@link getDecryptedPayload}. Use
   * {@link withRemoteSignerCredentials} for anything that is not a long-lived client.
   *
   * `readOnly` is reported as STORED here, and not forced true for the missing local private
   * key the way {@link listAccounts} forces it. A remote-signer account has no local key by
   * definition and signs perfectly well through its bunker; calling it read-only would tell the
   * caller the opposite of the truth on the one path that exists to use it.
   *
   * A detached deep copy. Null while locked.
   */
  getAccountForRemoteSigning(accountId: string): RemoteSignerAccount | null {
    const payload = this.#payload;
    if (!payload || !accountId) return null;
    const account = this.#findAccount(payload, accountId);
    if (!account || account.type !== 'nip46' || !account.nip46) return null;
    const stored = toStorageAccount(account);
    if (!stored.nip46Config) return null;
    return {
      ...toSafeAccount(account),
      nip46Config: cloneJson(stored.nip46Config),
    };
  }

  /**
   * Move the active account and persist it. The account has to be in the vault.
   *
   * Deliberately does NOT move the session on, where the extension's `setActiveAccount`
   * does. The guarantee that switching invalidates is held one layer up: the signing
   * pipeline re-checks the active account against the one the user was shown on every
   * path, including after execute, and pins the key by account id. Invalidating here as
   * well would void an in-flight `withPrivkey` whose own account did not change, for no
   * gain. A host using the vault directly gets the id-pinned accessors and no void on switch.
   */
  async setActiveAccountId(id: string): Promise<void> {
    const revision = this.#sessionRevision;
    return this.#run(async () => {
      this.#assertRevision(revision);
      const payload = this.#requireOpen();
      if (!payload.accounts.some((account) => account.id === id)) {
        throw new Error('Account not found');
      }
      if (payload.activeAccountId === id) return;
      payload.activeAccountId = id;
      await this.#saveNow(revision);
    });
  }

  /**
   * Add an account and re-seal. The active account does not change: adding is not switching.
   *
   * @throws if the vault is locked, an account with this id is already in it, or the store
   *         refused the write — in which case the account is not left in memory either
   */
  async addAccount(account: Account): Promise<void> {
    return this.#mutate('no-secrets', (payload) => {
      if (payload.accounts.some((candidate) => candidate.id === account.id)) {
        throw new Error('Account already exists in vault');
      }
      const added = toMemoryAccount(account);
      payload.accounts.push(added);
      return {
        undo: () => {
          payload.accounts.splice(payload.accounts.indexOf(added), 1);
          zeroMemoryAccount(added);
        },
        abandon: () => zeroMemoryAccount(added),
      };
    });
  }

  /**
   * Remove an account, zero its secrets and re-seal. If it was the active account, the first
   * remaining one becomes active.
   *
   * This moves the session on, as the extension's does: a `withPrivkey` callback still
   * holding the removed account's key when this lands gets its result voided rather than
   * returned, since the key it computed under no longer exists. The vault stays open.
   *
   * @throws if the vault is locked or there is no such account
   */
  async removeAccount(accountId: string): Promise<void> {
    return this.#mutate('secrets', (payload) => {
        const index = payload.accounts.findIndex((candidate) => candidate.id === accountId);
        if (index < 0) throw new Error('Account not found');
        const [removed] = payload.accounts.splice(index, 1) as [MemoryAccount];
        const previousActive = payload.activeAccountId;
        if (payload.activeAccountId === accountId) {
          payload.activeAccountId = payload.accounts[0]?.id ?? null;
        }
        return {
          undo: () => {
            payload.accounts.splice(index, 0, removed);
            payload.activeAccountId = previousActive;
          },
          commit: () => zeroMemoryAccount(removed),
          // Detached from the payload before the write, so the lock never reached it.
          abandon: () => zeroMemoryAccount(removed),
        };
    });
  }

  /**
   * Store the local keypair a NIP-46 session was established with, so a restart reconnects
   * as the same client identity. Takes the raw 32-byte key, copies it, and keeps the copy as
   * the ASCII hex the record stores; the previous key, if any, is zeroed once the write lands.
   * Moves the session on: a `withRemoteSignerCredentials` callback still holding the previous
   * key gets its result voided, since the key it computed under no longer exists.
   *
   * @throws if the vault is locked, the account is not a NIP-46 account, or the key is not
   *         32 bytes
   */
  async updateAccountNip46Keys(accountId: string, localPrivkey: Uint8Array, localPubkey: string): Promise<void> {
    if (localPrivkey.length !== VAULT_KEY_BYTES) {
      throw new Error(`A NIP-46 local private key is ${VAULT_KEY_BYTES} bytes`);
    }
    // The copy is made inside `apply`, after every refusal (locked, session moved, wrong
    // account) has had its chance: a copy made out here would be dropped un-zeroed by any of
    // them. The caller's buffer stays theirs and must outlive this call.
    return this.#mutate('secrets', (payload) => {
      const account = this.#findAccount(payload, accountId);
      if (!account || account.type !== 'nip46' || !account.nip46) {
        throw new Error('This account is not a NIP-46 account');
      }
      const encoded = bytesToHexBytes(localPrivkey);
      const config = account.nip46;
      const previous = { key: config.localPrivkeyBytes, pubkey: config.localPubkey };
      config.localPrivkeyBytes = encoded;
      config.localPubkey = localPubkey;
      return {
        undo: () => {
          encoded.fill(0);
          if (previous.key === undefined) delete config.localPrivkeyBytes;
          else config.localPrivkeyBytes = previous.key;
          if (previous.pubkey === undefined) delete config.localPubkey;
          else config.localPubkey = previous.pubkey;
        },
        commit: () => previous.key?.fill(0),
        abandon: () => {
          previous.key?.fill(0);
          encoded.fill(0);
        },
      };
    });
  }

  /**
   * Set or remove an account's host-owned `walletConfig` and re-seal. `null` removes it.
   *
   * The vault does not model this field and must not: typing it would mean importing the wallet
   * package, which builds on the vault. See {@link OpaqueWalletConfig}. It stores it, because
   * `toMemoryAccount` and `toStorageAccount` walk an account's keys generically, so it round
   * trips whether or not this layer has a name for it — and it needs to be settable, or a host
   * that stores the field cannot use this vault at all.
   *
   * `null` DELETES the key rather than writing an explicit null, which is not tidiness: the
   * serializer keeps `undefined` and `null` apart so a record round trips byte for byte, and
   * writing a null where the field was absent would change the sealed bytes of every vault a
   * host touched.
   *
   * Declared `'secrets'`, and that is the significant choice here. An NWC connection string
   * carries a secret in its query, so replacing or removing one replaces or destroys secret
   * material, which moves the session on and lets a host drop the live wallet client it opened
   * under the old configuration through {@link onSessionInvalidated}. A `'no-secrets'` mutation
   * would leave a connected client authenticating with a connection the user has just revoked.
   *
   * The config is deep-copied on the way in, so a caller that goes on editing the object it
   * passed is not editing the open vault.
   *
   * @throws if the vault is locked, there is no such account, or the store refused the write
   */
  async updateAccountWalletConfig(accountId: string, walletConfig: OpaqueWalletConfig | null): Promise<void> {
    const next = walletConfig === null ? null : cloneJson(walletConfig);
    return this.#mutate('secrets', (payload) => {
      const account = this.#findAccount(payload, accountId);
      if (!account) throw new Error('Account not found');
      // The field is not on `MemoryAccount` by design; it rides along in the generic passthrough.
      const host = account as unknown as Record<string, unknown>;
      const had = 'walletConfig' in host;
      const previous = host['walletConfig'];
      if (next === null) delete host['walletConfig'];
      else host['walletConfig'] = next;
      return {
        undo: () => {
          if (had) host['walletConfig'] = previous;
          else delete host['walletConfig'];
        },
        // Nothing to zero: a `walletConfig` is JSON, not a `Uint8Array`, which is precisely the
        // caveat {@link OpaqueWalletConfig} records. There is no buffer to fill on either path.
        abandon: () => {},
      };
    });
  }

  /**
   * Store externally generated post-quantum keys on an account and re-seal. The caller has
   * validated the pair; this only stores. Replacing an existing import zeroes the outgoing
   * secrets once the write lands and moves the session on, voiding any `withImportedPqKeys`
   * callback still holding them.
   *
   * @throws if the vault is locked or there is no such account
   */
  async setImportedPqKeys(accountId: string, keys: PqKeyPair, profile: string): Promise<void> {
    const importedAt = this.#now();
    // Copies are made inside `apply`, after every refusal has had its chance; see
    // `updateAccountNip46Keys`. The caller's buffers stay theirs and must outlive this call.
    return this.#mutate('secrets', (payload) => {
      const account = this.#findAccount(payload, accountId);
      if (!account) throw new Error('Account not found');
      // The public halves first: encoding is the last thing that can throw, and a throw
      // after the secret copies exist would leave two un-zeroed buffers nothing holds.
      const pqPublic = {
        profile,
        kem: bytesToBase64(keys.kem.publicKey),
        dsa: bytesToBase64(keys.dsa.publicKey),
        importedAt,
      };
      const kemSecret = new Uint8Array(keys.kem.secretKey);
      const dsaSecret = new Uint8Array(keys.dsa.secretKey);
      const previous = {
        pqPublic: account.pqPublic,
        kem: account.pqKemSecretBytes,
        dsa: account.pqDsaSecretBytes,
      };
      account.pqPublic = pqPublic;
      account.pqKemSecretBytes = kemSecret;
      account.pqDsaSecretBytes = dsaSecret;
      return {
        undo: () => {
          kemSecret.fill(0);
          dsaSecret.fill(0);
          if (previous.pqPublic === undefined) delete account.pqPublic;
          else account.pqPublic = previous.pqPublic;
          account.pqKemSecretBytes = previous.kem;
          account.pqDsaSecretBytes = previous.dsa;
        },
        commit: () => {
          previous.kem?.fill(0);
          previous.dsa?.fill(0);
        },
        abandon: () => {
          previous.kem?.fill(0);
          previous.dsa?.fill(0);
          kemSecret.fill(0);
          dsaSecret.fill(0);
        },
      };
    });
  }

  /**
   * Remove an account's imported post-quantum keys, zeroing the secrets, and re-seal. Moves
   * the session on, voiding any `withImportedPqKeys` callback still holding them.
   *
   * @returns true when there was something to remove
   * @throws if the vault is locked or there is no such account
   */
  async clearImportedPqKeys(accountId: string): Promise<boolean> {
    let cleared = false;
    await this.#mutate('secrets', (payload) => {
      const account = this.#findAccount(payload, accountId);
      if (!account) throw new Error('Account not found');
      if (!account.pqPublic) return null;
      cleared = true;
      const previous = { pqPublic: account.pqPublic, kem: account.pqKemSecretBytes, dsa: account.pqDsaSecretBytes };
      account.pqPublic = null;
      account.pqKemSecretBytes = null;
      account.pqDsaSecretBytes = null;
      return {
        undo: () => {
          account.pqPublic = previous.pqPublic;
          account.pqKemSecretBytes = previous.kem;
          account.pqDsaSecretBytes = previous.dsa;
        },
        commit: () => {
          previous.kem?.fill(0);
          previous.dsa?.fill(0);
        },
        abandon: () => {
          previous.kem?.fill(0);
          previous.dsa?.fill(0);
        },
      };
    });
    return cleared;
  }

  /** Does this account carry imported post-quantum keys? False while locked. Reveals nothing secret. */
  hasImportedPqKeys(accountId: string): boolean {
    const payload = this.#payload;
    if (!payload) return false;
    return !!this.#findAccount(payload, accountId)?.pqPublic;
  }

  /**
   * Does this account hold a seed phrase? False while locked. Reveals nothing secret.
   *
   * For a caller that has to name the refusal before it asks: {@link withMnemonic} throws
   * the same way for "no phrase" and "no such account", and a signing pipeline that wants
   * to tell the user "this account has no seed phrase" asks here first, as a caller that
   * wants to fall back from imported post-quantum keys asks {@link hasImportedPqKeys}.
   */
  hasMnemonic(accountId: string): boolean {
    const payload = this.#payload;
    if (!payload) return false;
    return !!this.#findAccount(payload, accountId)?.mnemonicBytes;
  }

  // ── Session lifecycle a host can subscribe to ─────────────────────────────────────────
  //
  // A host's private cache, wallet client and social-graph layer all hold state that is only
  // valid while one vault session is. Polling `isLocked()` is not a substitute: the moment that
  // matters is the TRANSITION, and an auto-lock fires on a timer nobody is watching. Every
  // subscribe returns its own unsubscribe, so a surface that comes and goes does not accumulate
  // listeners.

  /**
   * Which session the vault is on. Changes on every lock, destroy, create, unlock and
   * secret-touching mutation, and never otherwise.
   *
   * For a host that holds something derived from an open vault across awaits — a bunker client,
   * a decrypted cache entry, a pending signature — and has to know it is still the same session
   * when it comes back. Capture it, compare it, and throw rather than use what you were holding.
   * The vault's own scoped accessors do exactly this internally; this is the same guarantee for
   * state the vault cannot see.
   *
   * The number itself means nothing beyond "different means a different session". Do not persist
   * it: it starts at 0 in a fresh process.
   */
  getSessionRevision(): number {
    return this.#sessionRevision;
  }

  /**
   * Called synchronously after every {@link lock}, including an auto-lock.
   *
   * Synchronous because `lock()` is, and `lock()` is synchronous so that nothing can make it
   * fail or wait. A listener that throws is swallowed and the next one still runs: one host's
   * cleanup failing must never leave the vault half-locked. A listener with asynchronous work to
   * do starts it and does not expect to be awaited.
   *
   * @returns the unsubscribe
   */
  onLock(listener: () => void): () => void {
    this.#lockListeners.add(listener);
    return () => {
      this.#lockListeners.delete(listener);
    };
  }

  /**
   * Called, and AWAITED, after every successful {@link unlock} and {@link create}, before either
   * resolves.
   *
   * Awaited because the work is real and ordered: a host's private cache may need re-encrypting
   * under a key that exists only while the vault is open, and a caller that proceeded first
   * would read a cache that had not been migrated yet. A listener that throws is swallowed, with
   * the next one still run, and the unlock still succeeds — a deferred cache migration is not a
   * reason to refuse a user their vault.
   *
   * Announcing an unlock matters as much as announcing a lock. A never-lock vault re-opens
   * itself on every cold start, and a surface that asked during that window was told "locked"
   * with no way to ever hear the correction.
   *
   * @returns the unsubscribe
   */
  onUnlock(listener: () => Promise<void>): () => void {
    this.#unlockListeners.add(listener);
    return () => {
      this.#unlockListeners.delete(listener);
    };
  }

  /**
   * Called, and AWAITED, inside {@link destroy}, after the record is gone and before it resolves.
   *
   * For data a host derived from the vault and that must not outlive it: a private cache keyed to
   * the vault's cache key, a relay-list snapshot, anything that would otherwise sit there
   * undecryptable and undeleted. A listener that throws is swallowed, because the record is
   * already gone and a failed cleanup must not make `destroy` look incomplete.
   *
   * @returns the unsubscribe
   */
  onDestroy(listener: () => Promise<void>): () => void {
    this.#destroyListeners.add(listener);
    return () => {
      this.#destroyListeners.delete(listener);
    };
  }

  /**
   * Called synchronously on every session change, which is strictly more often than
   * {@link onLock}: a lock, a destroy, a create, an unlock, and every mutation declared
   * `'secrets'`.
   *
   * The difference is the point. `onLock` says "the keys are gone"; this says "whatever you
   * derived from the previous session is void", which is also true when the vault is still open —
   * an account was removed, a NIP-46 keypair was replaced, a wallet configuration changed. A
   * host that only listened for locks kept a bunker client connected with credentials the user
   * had just revoked.
   *
   * Synchronous, and a thrower is swallowed, for the reason {@link onLock} is: revocation is the
   * path that must run to completion whatever happens on it.
   *
   * @returns the unsubscribe
   */
  onSessionInvalidated(listener: () => void): () => void {
    this.#sessionListeners.add(listener);
    return () => {
      this.#sessionListeners.delete(listener);
    };
  }

  // ── The startup auto-unlock gate ──────────────────────────────────────────────────────
  //
  // A "never lock" vault is re-opened automatically on every cold start, and that unlock is
  // asynchronous: a storage read plus PBKDF2. So the vault reports LOCKED for a few hundred
  // milliseconds after the host starts, and on a platform that tears its worker down when idle
  // an ordinary request routinely lands inside that window. Without a gate the request path saw
  // `isLocked() === true`, queued an unlock and put a password prompt in front of the user — for
  // an unlock they did not have to perform, on a request their saved permission had already
  // approved.
  //
  // The gate is in this class rather than in the host because `isLocked()` is here: the state a
  // caller would otherwise misread is this object's, so the correction belongs beside it.

  /**
   * Register the host's startup auto-unlock so request paths can wait for it.
   *
   * `run` is invoked immediately and its rejection is SWALLOWED: a failed auto-unlock simply
   * means the vault stays locked and the user is prompted, which is the correct outcome and not
   * an error every awaiting request path should have to catch. The returned promise resolves
   * when the attempt settles, either way.
   *
   * Calling this again replaces the gate, so a host that restarts its own startup sequence does
   * not leave callers waiting on the previous attempt.
   */
  beginStartupUnlock(run: () => Promise<void>): Promise<void> {
    const settled = run()
      .catch(() => {})
      .then(() => {
        // Only clear it if it is still ours: a second `beginStartupUnlock` has installed a newer
        // gate that callers are now waiting on, and clearing it would release them early.
        if (this.#startupUnlock === settled) this.#startupUnlock = null;
      });
    this.#startupUnlock = settled;
    return settled;
  }

  /**
   * Resolves once any in-flight startup auto-unlock has settled, immediately when there is none.
   *
   * What a request path awaits BEFORE reading {@link isLocked}, so a cold start is not mistaken
   * for a locked vault. Never rejects.
   */
  whenStartupUnlockSettled(): Promise<void> {
    return this.#startupUnlock ?? Promise.resolve();
  }

  /**
   * Wait through any startup auto-unlock, then enforce the real lock state.
   *
   * The two-line sequence every request path needs, in one place so no path can get the order
   * wrong — reading {@link isLocked} before the gate is exactly the bug the gate exists for, and
   * it is invisible in a test where the unlock happens to have finished.
   *
   * @throws `Vault is locked` when the vault is genuinely locked, after the gate has settled
   */
  async requireUnlocked(): Promise<void> {
    await this.whenStartupUnlockSettled();
    if (this.isLocked()) throw new Error('Vault is locked');
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────

  /**
   * Serializes mutations. Every public entry point that writes goes through here, so an
   * unlock and a save cannot interleave and leave the record describing neither.
   *
   * Internal helpers (`#saveNow`, `#resealNow`) deliberately do not, because they are called
   * from inside the lane and re-entering it would deadlock.
   */
  /**
   * Move to a new session, cancelling everything in flight against the old one.
   *
   * Cheap and synchronous on purpose: `lock()` calls it, and locking must never be able to
   * queue, wait or fail. See {@link Vault.#sessionRevision}.
   */
  #invalidateSession(): void {
    this.#sessionRevision += 1;
    for (const listener of this.#sessionListeners) {
      // One holder failing to let go must not stop the next from being told. Revocation is the
      // path that has to run to completion whatever happens on it.
      try {
        listener();
      } catch {
        /* Revocation must continue for every other holder. */
      }
    }
  }

  /**
   * Tell every unlock listener, in turn, and swallow what they throw.
   *
   * Sequential rather than `Promise.all`: a host registers these in the order its subsystems
   * depend on each other (the private cache before anything that reads it), and a concurrent
   * fan-out would silently break that. A throwing listener does not fail the unlock; see
   * {@link onUnlock}.
   */
  async #notifyUnlocked(): Promise<void> {
    for (const listener of this.#unlockListeners) {
      try {
        await listener();
      } catch {
        /* A deferred host migration is not a reason to refuse the user their vault. */
      }
    }
  }

  /** Refuse to install anything from a session that has been overtaken. */
  #assertRevision(revision: number): void {
    if (revision !== this.#sessionRevision) throw new Error('Vault session changed');
  }

  #run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#lane.then(fn, fn);
    this.#lane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** The open payload, or the one error every accessor and mutation share. */
  #requireOpen(): MemoryVaultPayload {
    const payload = this.#payload;
    if (!payload) throw new Error('Vault is locked');
    return payload;
  }

  #findAccount(payload: MemoryVaultPayload, accountId: string): MemoryAccount | undefined {
    return payload.accounts.find((candidate) => candidate.id === accountId);
  }

  #toSafe(account: MemoryAccount): SafeAccount {
    return toSafeAccount({ ...account, readOnly: account.readOnly || !account.privkeyBytes });
  }

  /**
   * Run a callback over copies of secret bytes, and zero every copy afterwards on every path.
   *
   * The discipline behind {@link withPrivkey} and its siblings, in one place so a new accessor
   * cannot get it subtly wrong. The copies are registered so a lock taken mid-callback reaches
   * them too: otherwise a callback that is already running keeps computing with live key
   * material while `isLocked()` says true. And zeroing is necessary but not sufficient —
   * NIP-44, HMAC and AES-GCM all accept 32 zero bytes without complaint, so a callback that
   * read the key after the lock landed would hand back a publishable signature or ciphertext
   * computed under a zero key, with nothing anywhere to notice. Whatever it produced under a
   * revoked session is void, and this throws instead of returning it.
   *
   * Using a secret is activity; it pushes the idle deadline out.
   */
  async #scoped<T>(copies: Uint8Array[], fn: () => Promise<T>): Promise<T> {
    this.#armAutoLock();
    const revision = this.#sessionRevision;
    for (const copy of copies) this.#liveKeys.add(copy);
    try {
      const result = await fn();
      this.#assertRevision(revision);
      return result;
    } finally {
      for (const copy of copies) {
        this.#liveKeys.delete(copy);
        copy.fill(0);
      }
    }
  }

  /**
   * Apply a change to the open payload and re-seal, on the lane, under the revision discipline.
   *
   * `apply` edits the payload in place and hands back how to undo it; `null` means there was
   * nothing to change and nothing is written. The undo runs only when the store refuses the
   * write AND the session is still alive, so memory never describes a record that was not
   * saved. `commit` runs after the write has landed and is where outgoing secrets get zeroed:
   * zeroing them before the write would destroy the only copy of something the undo might
   * have to put back.
   *
   * The undo is right while the session is alive and wrong once it is not. A lock landing
   * inside the write zeroes the payload; if the write then fails, restoring the outgoing
   * secrets would put live key material back into a payload nobody will ever lock again. So
   * on a dead session the mutation is abandoned instead: everything it detached or created
   * is zeroed, and nothing is restored. It is the one case where rollback is worse than loss.
   *
   * `touches` is required and has no default, on purpose. A mutation that replaces or
   * destroys secret material (`'secrets'`) moves the session on before the write, so anything
   * in flight against the old one — a scoped callback holding a key this change removes or
   * replaces — is voided rather than returned: the key it computed under no longer exists.
   * Only a mutation that says `'no-secrets'` (adding an account touches nothing that anyone
   * could be holding) skips that. An optional flag defaulting to "do not void" was how three
   * of the five mutations quietly lost the property `removeAccount` had; the choice is now
   * made at every site, in the open. The write itself is made under the new revision, so a
   * lock landing inside it still wins.
   */
  async #mutate(
    touches: 'secrets' | 'no-secrets',
    apply: (payload: MemoryVaultPayload) => Mutation | null,
  ): Promise<void> {
    const revision = this.#sessionRevision;
    return this.#run(async () => {
      this.#assertRevision(revision);
      const payload = this.#requireOpen();
      let current = revision;
      if (touches === 'secrets') {
        this.#invalidateSession();
        current = this.#sessionRevision;
      }
      const mutation = apply(payload);
      if (mutation === null) return;
      try {
        await this.#saveNow(current);
      } catch (error) {
        if (current === this.#sessionRevision) mutation.undo();
        else mutation.abandon();
        throw error;
      }
      mutation.commit?.();
    });
  }

  async #readRecord(): Promise<VaultRecord | undefined> {
    return this.#store.get<VaultRecord>(VAULT_STORAGE_KEY);
  }

  async #readGuard(): Promise<UnlockGuardState> {
    const stored = await this.#store.get<UnlockGuardState>(UNLOCK_GUARD_KEY);
    if (!stored || typeof stored.failures !== 'number' || typeof stored.lockedUntil !== 'number') {
      return emptyGuardState();
    }
    return stored;
  }

  /**
   * A {@link Pbkdf2Port} that keeps a copy of what it derives.
   *
   * `sealPayload` and `openRecord` own the record format, and both zero the derived key in a
   * `finally` — correctly, since neither knows what the caller intends. But the vault has to
   * keep that key to re-save later without asking for the password again, and deriving twice
   * would double the cost of every unlock. Wrapping the port is how it keeps one without
   * either reimplementing the format or holding on to the password.
   */
  #capturingKdf(): { kdf: Pbkdf2Port; take: () => HeldKey; discard: () => void } {
    const inner = this.#kdf;
    let captured: HeldKey | null = null;
    const kdf: Pbkdf2Port = {
      async derive(password, salt, iterations) {
        const key = await inner.derive(password, salt, iterations);
        // Only the last derivation of a call is the one that matters; anything earlier was a
        // step on the way and must not be left lying around.
        captured?.key.fill(0);
        captured = { key: new Uint8Array(key), salt: new Uint8Array(salt), iterations };
        return key;
      },
    };
    return {
      kdf,
      take: () => {
        if (!captured) throw new Error('The key derivation port returned no key');
        const taken = captured;
        captured = null;
        return taken;
      },
      discard: () => {
        captured?.key.fill(0);
        captured = null;
      },
    };
  }

  /** Replace the decrypted payload, zeroing whatever it replaces. */
  #adoptPayload(next: MemoryVaultPayload): void {
    if (this.#payload) zeroMemoryPayload(this.#payload);
    this.#payload = next;
    this.#armAutoLock();
  }

  /** Replace the held key, zeroing whatever it replaces. */
  #adoptKey(next: HeldKey): void {
    this.#held?.key.fill(0);
    this.#held = next;
  }

  /**
   * Re-encrypt the payload under the key already in memory, reusing the record's salt.
   *
   * The record is assembled here rather than through `sealPayload` because `sealPayload`
   * derives — which is the whole thing this path avoids. `iterations` is the count the held
   * key was actually derived at, never the constant: a record that claims 600000 over a key
   * derived at 210000 is a vault nobody can open again.
   */
  async #saveNow(revision: number): Promise<void> {
    this.#assertRevision(revision);
    const payload = this.#payload;
    const held = this.#held;
    if (!payload || !held) throw new Error('Vault is locked');

    const { iv, ciphertext } = encrypt(held.key, JSON.stringify(toStoragePayload(payload)));
    const record: VaultRecord = {
      version: VAULT_VERSION,
      iterations: held.iterations,
      salt: bytesToBase64(held.salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext),
    };
    await this.#store.set(VAULT_STORAGE_KEY, record);
    this.#armAutoLock();
  }

  /**
   * Re-seal the open vault under `password`, with a fresh salt and the current work factor.
   *
   * Both the transparent upgrade and the password change end up here. The session stays open
   * across it: the payload is untouched, only the record and the held key change.
   */
  async #resealNow(password: string, revision: number): Promise<void> {
    this.#assertRevision(revision);
    const payload = this.#payload;
    if (!payload) throw new Error('Vault is locked');

    const capture = this.#capturingKdf();
    try {
      const record = await sealPayload(toStoragePayload(payload), password, capture.kdf);
      this.#assertRevision(revision);
      await this.#store.set(VAULT_STORAGE_KEY, record);
      // Again after the write, immediately before the key is installed. The write is a window
      // of its own — on a host whose storage is a round trip it can be the longer one — and a
      // lock landing inside it would otherwise put a live AES-256 vault key into a locked
      // vault, where nothing zeroes it until the next lock or unlock. Throwing here hands the
      // capture to the `finally` below, which zeroes it. The record itself is already written
      // and is perfectly valid; it is only this session that is over.
      this.#assertRevision(revision);
      this.#adoptKey(capture.take());
      this.#armAutoLock();
    } finally {
      // The transparent upgrade swallows failures from this path by design, so without this
      // a full copy of the AES-256 vault key would be dropped un-zeroed in normal operation.
      capture.discard();
    }
  }

  /** Lock without announcing it. The announcement is fire and forget; this is not. */
  #lockNow(): void {
    // The copies in flight first: a signing callback holding one is the only key material a
    // caller outside this class can still read once the payload is gone.
    for (const key of this.#liveKeys) key.fill(0);
    this.#liveKeys.clear();
    if (this.#payload) zeroMemoryPayload(this.#payload);
    this.#payload = null;
    this.#held?.key.fill(0);
    this.#held = null;
    if (this.#autoLockTimer) {
      clearTimeout(this.#autoLockTimer);
      this.#autoLockTimer = null;
    }
  }

  async #restoreAutoLockSetting(): Promise<void> {
    this.#autoLockMs = await this.getAutoLockMs();
    this.#armAutoLock();
  }

  /**
   * (Re)arm the idle timer. Called on every unlock, save and key access.
   *
   * The timer is `unref`ed where the runtime has it, so it cannot keep a Node process alive
   * on its own — an auto-lock timer that holds the event loop open turns every test run into
   * a hang. It also re-checks {@link shouldAutoLock} when it fires rather than trusting that
   * it slept exactly as long as it was asked to: a suspended device wakes its timers late, and
   * a host that resets activity from another path would otherwise lock a vault in use.
   */
  #armAutoLock(): void {
    this.#lastActivity = this.#now();
    if (this.#autoLockTimer) {
      clearTimeout(this.#autoLockTimer);
      this.#autoLockTimer = null;
    }
    if (!this.#payload || this.#autoLockMs <= 0) return;
    this.#scheduleAutoLock(this.#autoLockMs);
  }

  #scheduleAutoLock(delayMs: number): void {
    const timer = setTimeout(() => {
      this.#autoLockTimer = null;
      if (!this.#payload) return;
      if (shouldAutoLock(this.#lastActivity, this.#autoLockMs, this.#now())) {
        this.lock();
        return;
      }
      const remaining = this.#autoLockMs - (this.#now() - this.#lastActivity);
      this.#scheduleAutoLock(Math.max(remaining, 1));
    }, delayMs);
    // `unref` exists on Node's Timeout and on nothing else we target; where it is missing the
    // host has no event loop to hold open in the first place.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.#autoLockTimer = timer;
  }

  /**
   * Bump the marker another context watches, in both directions.
   *
   * Fire and forget on purpose: neither locking nor unlocking may depend on a storage write
   * succeeding, and `lock()` is synchronous precisely so nothing can make it fail.
   */
  #noteLockStateChanged(): void {
    void Promise.resolve(this.#store.set(LOCK_STATE_KEY, this.#now())).catch(() => {});
  }
}
