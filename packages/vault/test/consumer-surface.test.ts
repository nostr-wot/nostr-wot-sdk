/**
 * The surface a shipping consumer needs, and the shape it needs it in.
 *
 * Every test here corresponds to something a real browser extension calls and this class did
 * not offer, found by attempting the migration rather than by review. Two families:
 *
 *   - **Shape.** The extension's account accessors are SYNCHRONOUS and its existing suite calls
 *     them without `await` in 208 places. The package's were `async` — not because anything in
 *     them awaited, but by habit: `listAccounts`, `getAccountById` and `getActiveAccountId` read
 *     `#payload`, which is in memory by definition, since it only exists while unlocked. The
 *     async-ness was load-bearing nowhere and unadaptable everywhere (no adapter can make an
 *     asynchronous method synchronous), so the read path over already-decrypted state is now
 *     synchronous and anything that touches the injected `KeyValueStore` stays asynchronous.
 *     `sync-vs-async.test.ts` is where that rule is asserted as a rule.
 *   - **Missing members.** The accessors, the listeners, the startup gate, and the two escape
 *     hatches (`getDecryptedPayload`, `getAccountForRemoteSigning`) whose cost is written on
 *     them where they are defined.
 */
import { describe, test, expect, vi } from 'vitest';
import type { Account } from '@nostr-wot/accounts';
import { MemoryStore } from '@nostr-wot/storage';
import { Vault } from '../src/vault.js';
import { noblePbkdf2, type Pbkdf2Port } from '../src/crypto.js';
import { AUTO_LOCK_STORAGE_KEY, VAULT_KEY_BYTES } from '../src/constants.js';

const PASSWORD = 'correct horse battery staple';

const fastKdf: Pbkdf2Port = {
  derive: (password, salt, iterations) =>
    noblePbkdf2.derive(password, salt, Math.max(1, Math.round(iterations / 100_000))),
};

const account: Account = {
  id: 'acct_1',
  name: 'Main',
  type: 'generated',
  pubkey: 'ab'.repeat(32),
  privkey: 'cd'.repeat(32),
  mnemonic: 'abandon '.repeat(23) + 'art',
  nip46Config: null,
  readOnly: false,
  createdAt: 1,
};

const second: Account = {
  ...account,
  id: 'acct_2',
  name: 'Second',
  pubkey: 'ef'.repeat(32),
  privkey: '11'.repeat(32),
  mnemonic: null,
};

const remote: Account = {
  id: 'acct_bunker',
  name: 'Bunker',
  type: 'nip46',
  pubkey: '22'.repeat(32),
  privkey: null,
  mnemonic: null,
  nip46Config: {
    bunkerUrl: `bunker://${'33'.repeat(32)}?relay=wss%3A%2F%2Frelay.example`,
    relay: 'wss://relay.example',
    secret: 'connect-token',
    localPrivkey: '44'.repeat(32),
    localPubkey: '55'.repeat(32),
  },
  readOnly: false,
  createdAt: 2,
};

/** An account carrying a field this package does not model, exactly as the extension stores it. */
const withWallet = {
  ...second,
  id: 'acct_wallet',
  walletConfig: { type: 'nwc', uri: 'nostr+walletconnect://deadbeef?secret=s3cret' },
} as Account;

async function open(accounts: Account[] = [account, second]): Promise<Vault> {
  const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
  await vault.create(PASSWORD, accounts);
  return vault;
}

describe('the synchronous read path over already-decrypted state', () => {
  test('the account accessors answer without a promise', async () => {
    const vault = await open();
    // Not `await`ed, on purpose: this is the call shape 208 existing sites use, and an
    // adapter cannot manufacture it over an async method.
    expect(vault.getActiveAccountId()).toBe('acct_1');
    expect(vault.getActivePubkey()).toBe('ab'.repeat(32));
    expect(vault.getActiveAccount()?.name).toBe('Main');
    expect(vault.listAccounts().map((a) => a.id)).toEqual(['acct_1', 'acct_2']);
    expect(vault.getAccountById('acct_2')?.name).toBe('Second');
  });

  test('every one of them answers for a locked vault without throwing', async () => {
    const vault = await open();
    vault.lock();
    expect(vault.getActiveAccountId()).toBeNull();
    expect(vault.getActivePubkey()).toBeNull();
    expect(vault.getActiveAccount()).toBeNull();
    expect(vault.listAccounts()).toEqual([]);
    expect(vault.getAccountById('acct_1')).toBeNull();
    expect(vault.getActiveAccountWithWallet()).toBeNull();
    expect(vault.getAccountForRemoteSigning('acct_1')).toBeNull();
  });

  test('the public projection still goes through the allowlist, so no secret rides along', async () => {
    const vault = await open();
    const active = vault.getActiveAccount()!;
    expect(active).not.toHaveProperty('privkey');
    expect(active).not.toHaveProperty('mnemonic');
    expect(active).not.toHaveProperty('privkeyBytes');
    expect(active).not.toHaveProperty('mnemonicBytes');
    expect(Object.keys(active).sort()).toEqual(['createdAt', 'id', 'name', 'pubkey', 'readOnly', 'type']);
  });

  test('an account with no private key reports readOnly whatever its stored flag says', async () => {
    const vault = await open([{ ...account, privkey: null, readOnly: false }]);
    expect(vault.getActiveAccount()?.readOnly).toBe(true);
  });

  test('getActivePubkey is null when the active id names no account', async () => {
    const vault = await open([account]);
    await vault.removeAccount('acct_1');
    expect(vault.getActiveAccountId()).toBeNull();
    expect(vault.getActivePubkey()).toBeNull();
  });
});

describe('walletConfig, reachable without a type this layer must not import', () => {
  test('getActiveAccountWithWallet hands back the host field the record carried', async () => {
    const vault = await open([withWallet]);
    const active = vault.getActiveAccountWithWallet()!;
    expect(active.id).toBe('acct_wallet');
    expect(active.walletConfig).toEqual({ type: 'nwc', uri: 'nostr+walletconnect://deadbeef?secret=s3cret' });
  });

  test('the returned config is detached: mutating it cannot reach the open vault', async () => {
    const vault = await open([withWallet]);
    const active = vault.getActiveAccountWithWallet()!;
    (active.walletConfig as Record<string, unknown>)['uri'] = 'tampered';
    expect(vault.getActiveAccountWithWallet()!.walletConfig).toMatchObject({ uri: 'nostr+walletconnect://deadbeef?secret=s3cret' });
  });

  test('an account without one simply has no walletConfig key', async () => {
    const vault = await open([account]);
    expect(vault.getActiveAccountWithWallet()).not.toHaveProperty('walletConfig');
  });

  test('updateAccountWalletConfig persists, and null removes the field rather than nulling it', async () => {
    const vault = await open([account]);
    await vault.updateAccountWalletConfig('acct_1', { type: 'nwc', uri: 'a' });
    expect(vault.getActiveAccountWithWallet()!.walletConfig).toEqual({ type: 'nwc', uri: 'a' });
    // Round trips through the sealed record, which is the claim that matters: the serializer
    // walks account keys generically, so a field this package does not model still survives.
    expect(vault.getDecryptedPayload().accounts[0]).toMatchObject({ walletConfig: { uri: 'a' } });

    await vault.updateAccountWalletConfig('acct_1', null);
    expect(vault.getActiveAccountWithWallet()).not.toHaveProperty('walletConfig');
    expect(vault.getDecryptedPayload().accounts[0]).not.toHaveProperty('walletConfig');
  });

  test('it copies on the way in too, so the caller cannot mutate the vault afterwards', async () => {
    const vault = await open([account]);
    const config = { type: 'nwc', uri: 'a' };
    await vault.updateAccountWalletConfig('acct_1', config);
    config.uri = 'tampered';
    expect(vault.getActiveAccountWithWallet()!.walletConfig).toMatchObject({ uri: 'a' });
  });

  test('it refuses an unknown account and a locked vault', async () => {
    const vault = await open([account]);
    await expect(vault.updateAccountWalletConfig('nope', { a: 1 })).rejects.toThrow(/Account not found/);
    vault.lock();
    await expect(vault.updateAccountWalletConfig('acct_1', { a: 1 })).rejects.toThrow(/locked/);
  });
});

describe('getDecryptedPayload', () => {
  test('returns the storage shape, secrets included, for the re-seal and export paths', async () => {
    const vault = await open([account]);
    const payload = vault.getDecryptedPayload();
    expect(payload.activeAccountId).toBe('acct_1');
    expect(payload.accounts[0]!.privkey).toBe('cd'.repeat(32));
    expect(payload.accounts[0]!.mnemonic).toBe(account.mnemonic);
    expect(typeof payload.cacheKey).toBe('string');
  });

  test('it is a detached copy: mutating it cannot reach the open vault', async () => {
    // Top-level fields are already detached because `toStorageAccount` rebuilds the account, so
    // asserting only on those would pass with no clone at all. The case that needs the deep copy
    // is a NESTED host field: `walletConfig` rides along by reference through the serializer's
    // generic passthrough, which is exactly how it round trips losslessly. Measured — dropping
    // `cloneJson` leaves the two top-level assertions green and this one red.
    const vault = await open([withWallet]);
    const payload = vault.getDecryptedPayload();
    payload.accounts[0]!.name = 'tampered';
    payload.activeAccountId = 'nope';
    (payload.accounts[0] as unknown as { walletConfig: Record<string, unknown> }).walletConfig['uri'] = 'tampered';

    expect(vault.getActiveAccount()!.name).toBe('Second');
    expect(vault.getActiveAccountId()).toBe('acct_wallet');
    expect(vault.getActiveAccountWithWallet()!.walletConfig).toMatchObject({
      uri: 'nostr+walletconnect://deadbeef?secret=s3cret',
    });
  });

  test('it throws while locked rather than answering an empty payload', async () => {
    const vault = await open([account]);
    vault.lock();
    expect(() => vault.getDecryptedPayload()).toThrow(/locked/);
  });

  test('what it returns can re-create the vault under a new password, which is why it exists', async () => {
    const store = new MemoryStore();
    const vault = new Vault({ store, kdf: fastKdf });
    await vault.create(PASSWORD, [account]);
    const payload = vault.getDecryptedPayload();
    // The extension's never-lock switch: re-create under the other password with the payload
    // already in hand, because there is no current password to re-verify against.
    await vault.create('', payload.accounts);
    expect(await vault.unlock('')).toBe(true);
    expect(vault.getActiveAccount()!.id).toBe('acct_1');
  });
});

describe('getAccountForRemoteSigning', () => {
  test('hands back the credentials a long-lived NIP-46 client holds', async () => {
    const vault = await open([remote]);
    const found = vault.getAccountForRemoteSigning('acct_bunker')!;
    expect(found.id).toBe('acct_bunker');
    expect(found.nip46Config.bunkerUrl).toBe(remote.nip46Config!.bunkerUrl);
    expect(found.nip46Config.relay).toBe('wss://relay.example');
    expect(found.nip46Config.secret).toBe('connect-token');
    expect(found.nip46Config.localPrivkey).toBe('44'.repeat(32));
    expect(found.nip46Config.localPubkey).toBe('55'.repeat(32));
  });

  test('it carries the public metadata through the same allowlist as every other projection', async () => {
    const vault = await open([remote]);
    const found = vault.getAccountForRemoteSigning('acct_bunker')!;
    expect(found).not.toHaveProperty('privkey');
    expect(found).not.toHaveProperty('mnemonic');
  });

  test('readOnly is reported as STORED, not forced true for the absent local private key', async () => {
    // `listAccounts` forces `readOnly` when an account holds no private key, which is right
    // there and wrong here: a remote-signer account has no local key by definition and signs
    // through its bunker. Calling it read-only would tell the caller the opposite of the truth
    // on the single path that exists to use it.
    const vault = await open([remote]);
    expect(remote.privkey).toBeNull();
    expect(vault.getAccountForRemoteSigning('acct_bunker')!.readOnly).toBe(false);
    expect(vault.listAccounts()[0]!.readOnly).toBe(true);
  });

  test('null for an account that is not a remote signer, and for one that does not exist', async () => {
    const vault = await open([account, remote]);
    expect(vault.getAccountForRemoteSigning('acct_1')).toBeNull();
    expect(vault.getAccountForRemoteSigning('nope')).toBeNull();
  });

  test('it is a detached copy', async () => {
    // HONESTY NOTE: this assertion cannot currently be made to fail. `toStorageNip46` already
    // builds a fresh object and every field of `Nip46Config` is a primitive, so removing the
    // `cloneJson` in `getAccountForRemoteSigning` leaves this green — measured, not assumed. It
    // is kept because the claim is worth stating and because the clone is what keeps it true if
    // `Nip46Config` ever gains a nested field, which is exactly how `walletConfig` got its own
    // (genuinely failing) detachment test in `getDecryptedPayload` above.
    const vault = await open([remote]);
    const found = vault.getAccountForRemoteSigning('acct_bunker')!;
    found.nip46Config.secret = 'tampered';
    expect(vault.getAccountForRemoteSigning('acct_bunker')!.nip46Config.secret).toBe('connect-token');
  });
});

describe('updateAccountNip46Keys, as a client that has just generated a keypair calls it', () => {
  test('the stored keypair comes back through getAccountForRemoteSigning', async () => {
    const vault = await open([
      { ...remote, nip46Config: { ...remote.nip46Config!, localPrivkey: undefined, localPubkey: undefined } },
    ]);
    expect(vault.getAccountForRemoteSigning('acct_bunker')!.nip46Config.localPrivkey).toBeUndefined();
    await vault.updateAccountNip46Keys('acct_bunker', new Uint8Array(VAULT_KEY_BYTES).fill(0x66), '77'.repeat(32));
    const config = vault.getAccountForRemoteSigning('acct_bunker')!.nip46Config;
    expect(config.localPrivkey).toBe('66'.repeat(32));
    expect(config.localPubkey).toBe('77'.repeat(32));
  });
});

describe('re-sealing an already open vault with no current password', () => {
  test('reEncrypt replaces the record and keeps the session open', async () => {
    const store = new MemoryStore();
    const vault = new Vault({ store, kdf: fastKdf });
    await vault.create(PASSWORD, [account]);
    await vault.reEncrypt('a different password');
    expect(vault.isLocked()).toBe(false);
    expect(vault.getActiveAccountId()).toBe('acct_1');

    const reader = new Vault({ store, kdf: fastKdf });
    expect(await reader.unlock('a different password')).toBe(true);
    expect(await reader.unlock(PASSWORD)).toBe(false);
  });

  test('it charges no failed attempt to the brute-force guard, because it verifies nothing', async () => {
    // The distinction from `changePassword`, and the reason both exist. `changePassword`
    // verifies the current password through `unlock`, so a wrong one is charged to the guard —
    // correct for a password-change form. This path re-seals a vault that is ALREADY open, so
    // there is nothing to verify and no attempt to charge; routing it through `changePassword`
    // would make a transparent work-factor upgrade or a lock-mode switch walk a user towards a
    // lockout for something they did not type.
    const kdf = { calls: 0, derive: (p: string, s: Uint8Array, i: number) => (kdf.calls++, fastKdf.derive(p, s, i)) };
    const vault = new Vault({ store: new MemoryStore(), kdf });
    await vault.create(PASSWORD, [account]);
    const before = kdf.calls;
    await vault.reEncrypt('a different password');
    expect(kdf.calls).toBe(before + 1);
  });

  test('it refuses the empty password, so a password change cannot silently disarm the vault', async () => {
    const vault = await open([account]);
    await expect(vault.reEncrypt('')).rejects.toThrow(/required/);
  });

  test('it refuses a password below the minimum length', async () => {
    const vault = await open([account]);
    await expect(vault.reEncrypt('short')).rejects.toThrow(/at least/);
  });

  test('it refuses a locked vault', async () => {
    const vault = await open([account]);
    vault.lock();
    await expect(vault.reEncrypt('a different password')).rejects.toThrow(/locked/);
  });
});

describe('setAutoLockTimeout, synchronously', () => {
  test('it re-arms the timer now and persists the choice without being awaited', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore();
      const vault = new Vault({ store, kdf: fastKdf, now: () => Date.now() });
      await vault.create(PASSWORD, [account]);
      // Not awaited: the extension calls this from a synchronous settings handler.
      vault.setAutoLockTimeout(1000);
      expect(vault.isLocked()).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(vault.isLocked()).toBe(true);
      // The write is fire and forget, so it lands on a later microtask rather than before the
      // call returns. A host that needs to know it landed uses `setAutoLockMs`.
      await vi.runAllTimersAsync();
      expect(await store.get<number>(AUTO_LOCK_STORAGE_KEY)).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  test('0 stops the timer and the vault stays open', async () => {
    vi.useFakeTimers();
    try {
      const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf, now: () => Date.now() });
      await vault.create(PASSWORD, [account]);
      vault.setAutoLockTimeout(0);
      vi.advanceTimersByTime(10_000_000);
      expect(vault.isLocked()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('it refuses a negative or non-finite interval synchronously', async () => {
    const vault = await open([account]);
    expect(() => vault.setAutoLockTimeout(-1)).toThrow(/>= 0/);
    expect(() => vault.setAutoLockTimeout(Number.NaN)).toThrow(/>= 0/);
  });
});

describe('the startup auto-unlock gate', () => {
  test('a request path that awaits it does not mistake a cold start for a locked vault', async () => {
    const store = new MemoryStore();
    const writer = new Vault({ store, kdf: fastKdf });
    await writer.create('', [account]);

    const vault = new Vault({ store, kdf: fastKdf });
    // The window the gate exists for: the vault reports locked while the auto-unlock derives.
    const started = vault.beginStartupUnlock(() => vault.unlock('').then(() => {}));
    expect(vault.isLocked()).toBe(true);
    await vault.whenStartupUnlockSettled();
    expect(vault.isLocked()).toBe(false);
    await started;
  });

  test('it resolves immediately when no startup unlock is in flight', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await expect(vault.whenStartupUnlockSettled()).resolves.toBeUndefined();
  });

  test('a failed auto-unlock settles the gate rather than rejecting into every request path', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await vault.beginStartupUnlock(() => Promise.reject(new Error('no vault')));
    await expect(vault.whenStartupUnlockSettled()).resolves.toBeUndefined();
    expect(vault.isLocked()).toBe(true);
  });

  test('requireUnlocked waits through the gate and then enforces the real state', async () => {
    const store = new MemoryStore();
    const writer = new Vault({ store, kdf: fastKdf });
    await writer.create('', [account]);

    const vault = new Vault({ store, kdf: fastKdf });
    void vault.beginStartupUnlock(() => vault.unlock('').then(() => {}));
    await expect(vault.requireUnlocked()).resolves.toBeUndefined();

    vault.lock();
    await expect(vault.requireUnlocked()).rejects.toThrow(/locked/);
  });
});

describe('the lifecycle listeners the private cache, the wallet and the WoT layer subscribe to', () => {
  test('onLock fires on an explicit lock and on an auto-lock', async () => {
    vi.useFakeTimers();
    try {
      const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf, now: () => Date.now() });
      await vault.create(PASSWORD, [account]);
      const locks: number[] = [];
      vault.onLock(() => locks.push(1));
      vault.lock();
      expect(locks).toHaveLength(1);
      await vault.unlock(PASSWORD);
      vault.setAutoLockTimeout(1000);
      vi.advanceTimersByTime(1001);
      expect(locks).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('onUnlock is awaited, so a cache migration can finish before the host proceeds', async () => {
    const store = new MemoryStore();
    const writer = new Vault({ store, kdf: fastKdf });
    await writer.create(PASSWORD, [account]);

    const vault = new Vault({ store, kdf: fastKdf });
    // A listener that BLOCKS until the test releases it, rather than one that merely awaits a
    // microtask. An ordering assertion over microtasks passes by accident when the listener is
    // fired and not awaited — measured: replacing `await listener()` with `void listener()` left
    // that version of this test green — so the listener has to actually hold the unlock open.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listenerEntered = false;
    vault.onUnlock(async () => {
      listenerEntered = true;
      await held;
    });

    let unlockSettled = false;
    const unlocking = vault.unlock(PASSWORD).then((ok) => {
      unlockSettled = true;
      return ok;
    });

    // Long enough for every microtask and timer the unlock schedules to drain.
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listenerEntered).toBe(true);
    expect(unlockSettled).toBe(false);

    release();
    expect(await unlocking).toBe(true);
  });

  test('a throwing unlock listener does not fail the unlock or stop the next listener', async () => {
    const store = new MemoryStore();
    const writer = new Vault({ store, kdf: fastKdf });
    await writer.create(PASSWORD, [account]);

    const vault = new Vault({ store, kdf: fastKdf });
    const seen: string[] = [];
    vault.onUnlock(async () => {
      throw new Error('cache migration deferred');
    });
    vault.onUnlock(async () => void seen.push('second'));
    expect(await vault.unlock(PASSWORD)).toBe(true);
    expect(seen).toEqual(['second']);
  });

  test('a throwing lock listener does not stop the next one, because a lock cannot fail', async () => {
    const vault = await open([account]);
    const seen: string[] = [];
    vault.onLock(() => {
      throw new Error('one cleanup failed');
    });
    vault.onLock(() => void seen.push('second'));
    vault.lock();
    expect(seen).toEqual(['second']);
    expect(vault.isLocked()).toBe(true);
  });

  test('onDestroy is awaited, so a host can clear its own derived data with the vault', async () => {
    const vault = await open([account]);
    // Blocking, for the reason the unlock test above blocks: an ordering assertion over
    // microtasks stays green when the listener is fired and not awaited.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listenerEntered = false;
    vault.onDestroy(async () => {
      listenerEntered = true;
      await held;
    });

    let destroySettled = false;
    const destroying = vault.destroy().then(() => {
      destroySettled = true;
    });
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listenerEntered).toBe(true);
    expect(destroySettled).toBe(false);

    release();
    await destroying;
    expect(await vault.exists()).toBe(false);
  });

  test('onSessionInvalidated fires for every revocation, not only for a lock', async () => {
    const vault = await open([account, second]);
    let revocations = 0;
    vault.onSessionInvalidated(() => void revocations++);
    // `removeAccount` says it touches secrets, so it moves the session on.
    await vault.removeAccount('acct_2');
    expect(revocations).toBe(1);
    vault.lock();
    expect(revocations).toBe(2);
  });

  test('getSessionRevision changes exactly when the session does, so a holder can pin to one', async () => {
    const vault = await open([account, second]);
    const first = vault.getSessionRevision();
    expect(vault.getSessionRevision()).toBe(first);
    vault.lock();
    expect(vault.getSessionRevision()).not.toBe(first);
  });

  test('every subscription can be withdrawn', async () => {
    const vault = await open([account]);
    const seen: string[] = [];
    vault.onLock(() => void seen.push('lock'))();
    vault.onSessionInvalidated(() => void seen.push('session'))();
    const offUnlock = vault.onUnlock(async () => void seen.push('unlock'));
    const offDestroy = vault.onDestroy(async () => void seen.push('destroy'));
    offUnlock();
    offDestroy();
    vault.lock();
    await vault.unlock(PASSWORD);
    await vault.destroy();
    expect(seen).toEqual([]);
  });
});
