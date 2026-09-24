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
 *   - nothing here ever returns the decrypted payload, and {@link Vault.listAccounts} goes
 *     through `toSafeAccount` so a new private field cannot start riding along by accident.
 *
 * The one secret held as anything other than a zeroable array is the derived vault key, which
 * is a `Uint8Array` too — the extension holds a non-extractable `CryptoKey`, which is strictly
 * better and is not available on every host this package targets. It is zeroed on lock with
 * everything else. The password itself is never retained.
 */
import { randomBytes } from '@noble/ciphers/utils.js';
import type { Account, SafeAccount } from '@nostr-wot/accounts';
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
  toMemoryPayload,
  toStoragePayload,
  zeroMemoryPayload,
} from './serialization.js';
import type { MemoryVaultPayload, VaultPayload, VaultRecord } from './types.js';

/** What a {@link Vault} needs from its host. */
export interface VaultOptions {
  /** Where the record, the lock marker, the guard and the interval live. */
  store: KeyValueStore;
  /** Password stretching. Defaults to {@link noblePbkdf2}, which needs nothing native. */
  kdf?: Pbkdf2Port;
  /** The clock, injectable so the guard and the auto-lock can be tested without waiting. */
  now?: () => number;
}

/** The derived key the vault keeps so it can re-seal without asking for the password again. */
interface HeldKey {
  key: Uint8Array;
  salt: Uint8Array;
  iterations: number;
}

/** Thrown by {@link Vault.unlock} while the brute-force guard is refusing attempts. */
export class VaultLockedOutError extends Error {
  constructor(readonly remainingMs: number) {
    super(`Too many failed attempts. Try again in ${Math.ceil(remainingMs / 1000)}s`);
    this.name = 'VaultLockedOutError';
  }
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

  /** The decrypted vault, or null when locked. The only place key material lives. */
  #payload: MemoryVaultPayload | null = null;
  /** The key the payload was opened with, so a save need not re-derive. Zeroed on lock. */
  #held: HeldKey | null = null;
  #autoLockMs = DEFAULT_AUTO_LOCK_MS;
  #autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  #lastActivity = 0;
  /** One lane for every mutation, so two unlocks cannot interleave their writes. */
  #lane: Promise<unknown> = Promise.resolve();

  constructor(options: VaultOptions) {
    this.#store = options.store;
    this.#kdf = options.kdf ?? noblePbkdf2;
    this.#now = options.now ?? Date.now;
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
    return this.#run(async () => {
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
      const record = await sealPayload(stored, password, capture.kdf);
      await this.#store.set(VAULT_STORAGE_KEY, record);

      this.#adoptPayload(toMemoryPayload(stored));
      this.#adoptKey(capture.take());
      await this.#restoreAutoLockSetting();
      this.#noteLockStateChanged();
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
    return this.#run(async () => {
      const guard = await this.#readGuard();
      const remaining = guardLockoutRemaining(guard, this.#now());
      if (remaining > 0) throw new VaultLockedOutError(remaining);

      const record = await this.#readRecord();
      if (!record) throw new Error('No vault found');

      const capture = this.#capturingKdf();
      let opened;
      try {
        opened = await openRecord(record, password, capture.kdf);
      } catch {
        // Wrong password, or a corrupt record. Either way nothing about the current session
        // changes except the counter.
        capture.discard();
        await this.#store.set(UNLOCK_GUARD_KEY, nextGuardState(guard, false, this.#now()));
        return false;
      }

      this.#adoptPayload(toMemoryPayload(opened.payload));
      this.#adoptKey(capture.take());
      await this.#store.remove(UNLOCK_GUARD_KEY);
      await this.#restoreAutoLockSetting();

      const storedIterations = record.iterations ?? LEGACY_VAULT_PBKDF2_ITERATIONS;
      if (storedIterations < iterationsFor(password)) {
        try {
          await this.#resealNow(password);
        } catch {
          // An upgrade that fails must never cost the user their unlocked session: the vault
          // is open and the record that opened it is still perfectly valid.
        }
      }
      if (opened.cacheKeyMinted) {
        try {
          await this.#saveNow();
        } catch (error) {
          this.#lockNow();
          this.#noteLockStateChanged();
          throw error;
        }
      }

      this.#noteLockStateChanged();
      return true;
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
    this.#lockNow();
    this.#noteLockStateChanged();
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
    await this.#run(() => this.#resealNow(next));
    return true;
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
   * @param accountId the account, or undefined for the active one
   */
  async withPrivkey<T>(
    accountId: string | undefined,
    fn: (key: Uint8Array) => Promise<T>,
  ): Promise<T> {
    const payload = this.#payload;
    if (!payload) throw new Error('Vault is locked');
    this.#armAutoLock(); // Using a key is activity; it pushes the idle deadline out.

    const id = accountId ?? payload.activeAccountId;
    const account = payload.accounts.find((candidate) => candidate.id === id);
    if (!account?.privkeyBytes) throw new Error('No private key for this account');

    const key = new Uint8Array(account.privkeyBytes);
    try {
      return await fn(key);
    } finally {
      key.fill(0);
    }
  }

  /**
   * Public account metadata, and only that.
   *
   * Through `toSafeAccount`, which copies an explicit allowlist rather than deleting known
   * secrets: a field added to `Account` later is private until someone says otherwise, which
   * is the only default that fails safe. An account with no private key reports `readOnly`
   * whatever its stored flag says.
   */
  async listAccounts(): Promise<SafeAccount[]> {
    const payload = this.#payload;
    if (!payload) return [];
    return payload.accounts.map((account) =>
      toSafeAccount({ ...account, readOnly: account.readOnly || !account.privkeyBytes }),
    );
  }

  /** The active account's id, or null when there is none — or when the vault is locked. */
  async getActiveAccountId(): Promise<string | null> {
    return this.#payload?.activeAccountId ?? null;
  }

  /** Move the active account and persist it. The account has to be in the vault. */
  async setActiveAccountId(id: string): Promise<void> {
    return this.#run(async () => {
      const payload = this.#payload;
      if (!payload) throw new Error('Vault is locked');
      if (!payload.accounts.some((account) => account.id === id)) {
        throw new Error('Account not found');
      }
      if (payload.activeAccountId === id) return;
      payload.activeAccountId = id;
      await this.#saveNow();
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────

  /**
   * Serializes mutations. Every public entry point that writes goes through here, so an
   * unlock and a save cannot interleave and leave the record describing neither.
   *
   * Internal helpers (`#saveNow`, `#resealNow`) deliberately do not, because they are called
   * from inside the lane and re-entering it would deadlock.
   */
  #run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#lane.then(fn, fn);
    this.#lane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
  async #saveNow(): Promise<void> {
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
  async #resealNow(password: string): Promise<void> {
    const payload = this.#payload;
    if (!payload) throw new Error('Vault is locked');

    const capture = this.#capturingKdf();
    const record = await sealPayload(toStoragePayload(payload), password, capture.kdf);
    await this.#store.set(VAULT_STORAGE_KEY, record);
    this.#adoptKey(capture.take());
    this.#armAutoLock();
  }

  /** Lock without announcing it. The announcement is fire and forget; this is not. */
  #lockNow(): void {
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
