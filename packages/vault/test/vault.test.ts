/**
 * The vault lifecycle: create, unlock, lock, scoped key access, auto-lock and the guard.
 *
 * Most of this file runs against a deliberately weakened PBKDF2 port, because 600000
 * iterations of pure JavaScript costs about a second per derivation and this suite performs
 * dozens. The port is the real `noblePbkdf2` with the count scaled down rather than pinned,
 * so a key derived at the legacy count still differs from one derived at the current count:
 * the transparent work-factor upgrade would fail here if it wrote the wrong number. Two
 * tests deliberately use the real, unweakened default — one end to end, one over a record
 * the shipping browser extension wrote.
 */
import { describe, test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from '@noble/ciphers/utils.js';
import type { Account } from '@nostr-wot/accounts';
import { MemoryStore, type KeyValueStore } from '@nostr-wot/storage';
import { Vault } from '../src/vault.js';
import { openRecord } from '../src/record.js';
import { encrypt, noblePbkdf2, type Pbkdf2Port } from '../src/crypto.js';
import { bytesToBase64, bytesToHex, toMemoryPayload, zeroMemoryPayload } from '../src/serialization.js';
import {
  LEGACY_VAULT_PBKDF2_ITERATIONS,
  LOCK_STATE_KEY,
  UNLOCK_GUARD_KEY,
  VAULT_PBKDF2_ITERATIONS,
  VAULT_STORAGE_KEY,
  VAULT_VERSION,
} from '../src/constants.js';
import type { UnlockGuardState } from '../src/guard.js';
import type { VaultPayload, VaultRecord } from '../src/types.js';

const account: Account = {
  id: 'acct_1',
  name: 'Main',
  type: 'generated',
  pubkey: 'ab'.repeat(32),
  privkey: 'cd'.repeat(32),
  mnemonic: null,
  nip46Config: null,
  readOnly: false,
  createdAt: 1,
};

const watcher: Account = {
  ...account,
  id: 'acct_2',
  name: 'Watch only',
  type: 'npub',
  pubkey: 'ef'.repeat(32),
  privkey: null,
  readOnly: false,
};

/** Real PBKDF2, scaled so the suite is fast and the work factor still changes the key. */
const fastKdf: Pbkdf2Port = {
  derive: (password, salt, iterations) =>
    noblePbkdf2.derive(password, salt, Math.max(1, Math.round(iterations / 100_000))),
};

/** The same port, counting derivations, for proving the guard refuses before deriving. */
function countingKdf(): Pbkdf2Port & { calls: number } {
  const port = {
    calls: 0,
    derive(password: string, salt: Uint8Array, iterations: number) {
      port.calls += 1;
      return fastKdf.derive(password, salt, iterations);
    },
  };
  return port;
}

/**
 * Write a record the way an older writer would have: any iteration count, and optionally
 * no `cacheKey` in the plaintext at all, which is what records predating that field look
 * like. `sealPayload` can produce neither, by design.
 */
async function writeLegacyRecord(
  store: MemoryStore,
  payload: VaultPayload,
  password: string,
  kdf: Pbkdf2Port,
  iterations: number,
  options: { omitIterations?: boolean } = {},
): Promise<void> {
  const salt = randomBytes(32);
  const key = await kdf.derive(password, salt, iterations);
  const { iv, ciphertext } = encrypt(key, JSON.stringify(payload));
  key.fill(0);
  await store.set(VAULT_STORAGE_KEY, {
    version: VAULT_VERSION,
    ...(options.omitIterations ? {} : { iterations }),
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  } satisfies VaultRecord);
}

const readRecord = (store: MemoryStore) => store.get<VaultRecord>(VAULT_STORAGE_KEY);

/** Let a fire-and-forget storage write (the lock-state marker) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the vault lifecycle', () => {
  test('a new vault is locked until it is unlocked with the right password', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    expect(await vault.exists()).toBe(false);
    await vault.create('hunter22', [account]);
    expect(await vault.exists()).toBe(true);
    vault.lock();
    expect(vault.isLocked()).toBe(true);
    expect(await vault.unlock('wrong')).toBe(false);
    expect(vault.isLocked()).toBe(true);
    expect(await vault.unlock('hunter22')).toBe(true);
    expect(vault.isLocked()).toBe(false);
  });

  test('unlocking a vault that is not there is an error, not a false', async () => {
    // A caller has to be able to tell "wrong password" from "nothing to open", or the setup
    // wizard offers a password prompt for a vault that does not exist.
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await expect(vault.unlock('hunter22')).rejects.toThrow(/no vault/i);
  });

  test('a short password is refused, and the empty one is not', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await expect(vault.create('short', [account])).rejects.toThrow(/8 characters/i);
    // The empty password is how "never lock" is stored: still encrypted, never plaintext.
    await vault.create('', [account]);
    expect(vault.isLocked()).toBe(false);
  });

  test('destroy wipes the record and locks the session', async () => {
    const store = new MemoryStore();
    const vault = new Vault({ store, kdf: fastKdf });
    await vault.create('hunter22', [account]);
    await vault.destroy();
    expect(vault.isLocked()).toBe(true);
    expect(await vault.exists()).toBe(false);
    expect(await readRecord(store)).toBeUndefined();
  });

  test('the storage keys are the extension\'s, so a migrated vault reads its own data', async () => {
    const store = new MemoryStore();
    const vault = new Vault({ store, kdf: fastKdf, now: () => 1234 });
    await vault.create('hunter22', [account]);
    vault.lock();
    await vault.unlock('nope');
    await flush();
    expect((await store.keys()).sort()).toEqual([LOCK_STATE_KEY, UNLOCK_GUARD_KEY, VAULT_STORAGE_KEY].sort());
    expect(VAULT_STORAGE_KEY).toBe('keyVault');
    expect(LOCK_STATE_KEY).toBe('vaultLockStateAt');
    expect(UNLOCK_GUARD_KEY).toBe('vaultUnlockGuard');
  });

  test('the lock-state marker moves in both directions', async () => {
    const store = new MemoryStore();
    let clock = 1000;
    const vault = new Vault({ store, kdf: fastKdf, now: () => clock });
    await vault.create('hunter22', [account]);
    await flush();
    clock = 2000;
    vault.lock();
    await flush();
    expect(await store.get<number>(LOCK_STATE_KEY)).toBe(2000);
    // Unlocking matters as much as locking: a surface watching only for locks never learns
    // that a "never lock" vault re-opened itself on a cold start.
    clock = 3000;
    await vault.unlock('hunter22');
    await flush();
    expect(await store.get<number>(LOCK_STATE_KEY)).toBe(3000);
  });
});

describe('key material', () => {
  test('locking zeroes the key bytes rather than dropping the reference', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await vault.create('hunter22', [account]);
    let captured: Uint8Array | null = null;
    await vault.withPrivkey('acct_1', async (key) => {
      captured = key;
      expect(bytesToHex(key)).toBe(account.privkey);
    });
    expect(captured).not.toBeNull();
    expect(Array.from(captured!)).toEqual(new Array(32).fill(0));
  });

  test('the scoped copy is zeroed even when the callback throws', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await vault.create('hunter22', [account]);
    let captured: Uint8Array | null = null;
    await expect(
      vault.withPrivkey('acct_1', async (key) => {
        captured = key;
        throw new Error('signing blew up');
      }),
    ).rejects.toThrow(/signing blew up/);
    expect(Array.from(captured!)).toEqual(new Array(32).fill(0));
  });

  test('the caller cannot reach the vault\'s own buffer through the copy it is handed', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await vault.create('hunter22', [account]);
    await vault.withPrivkey('acct_1', async (key) => {
      key.fill(9);
    });
    // If withPrivkey handed out the live array, the vault would now hold nines.
    const second = await vault.withPrivkey('acct_1', async (key) => bytesToHex(key));
    expect(second).toBe(account.privkey);
  });

  test('lock\'s zeroing pass leaves no secret byte standing', () => {
    // The pass `lock()` runs, tested where the buffers are reachable: a vault that exposed
    // its live payload for an assertion would be the leak this design exists to prevent.
    const payload = toMemoryPayload({
      cacheKey: bytesToBase64(new Uint8Array(32).fill(7)),
      activeAccountId: 'acct_1',
      accounts: [
        {
          ...account,
          mnemonic: `${'abandon '.repeat(23)}art`,
          pqKeys: {
            profile: 'nip-pqc/v1',
            kem: { public: bytesToBase64(new Uint8Array(8).fill(1)), secret: bytesToBase64(new Uint8Array(8).fill(2)) },
            dsa: { public: bytesToBase64(new Uint8Array(8).fill(3)), secret: bytesToBase64(new Uint8Array(8).fill(4)) },
            importedAt: 5,
          },
        },
      ],
    });
    zeroMemoryPayload(payload);
    const [acct] = payload.accounts;
    for (const bytes of [
      payload.cacheKeyBytes,
      acct!.privkeyBytes,
      acct!.mnemonicBytes,
      acct!.pqKemSecretBytes,
      acct!.pqDsaSecretBytes,
    ]) {
      expect(bytes).toBeDefined();
      expect(bytes!.length).toBeGreaterThan(0);
      expect(bytes!.every((byte) => byte === 0)).toBe(true);
    }
    // Public metadata survives: zeroing is not destruction of the account record.
    expect(acct!.pubkey).toBe(account.pubkey);
  });

  test('a locked vault refuses to hand out a key', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await vault.create('hunter22', [account]);
    vault.lock();
    await expect(vault.withPrivkey('acct_1', async () => 'x')).rejects.toThrow(/locked/i);
  });

  test('an account with no private key is not a null key, it is an error', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await vault.create('hunter22', [account, watcher]);
    await expect(vault.withPrivkey('acct_2', async () => 'x')).rejects.toThrow(/no private key/i);
    await expect(vault.withPrivkey('acct_nope', async () => 'x')).rejects.toThrow(/no private key/i);
  });

  test('listAccounts never returns private fields', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await vault.create('hunter22', [account, watcher]);
    const [safe, readOnly] = await vault.listAccounts();
    // The exact surviving key set, not just the absence of one field: a new Account field is
    // private by default, and only this assertion notices when one starts riding along.
    expect(Object.keys(safe!).sort()).toEqual(['createdAt', 'id', 'name', 'pubkey', 'readOnly', 'type']);
    expect(safe!.pubkey).toBe(account.pubkey);
    // An account with no key is read-only whatever its stored flag says.
    expect(readOnly!.readOnly).toBe(true);
    expect(await new Vault({ store: new MemoryStore(), kdf: fastKdf }).listAccounts()).toEqual([]);
  });

  test('the active account can be read and moved, and survives a lock', async () => {
    const store = new MemoryStore();
    const vault = new Vault({ store, kdf: fastKdf });
    await vault.create('hunter22', [account, watcher]);
    expect(await vault.getActiveAccountId()).toBe('acct_1');
    await vault.setActiveAccountId('acct_2');
    expect(await vault.getActiveAccountId()).toBe('acct_2');
    await expect(vault.setActiveAccountId('acct_nope')).rejects.toThrow(/not found/i);
    vault.lock();
    expect(await vault.getActiveAccountId()).toBeNull();
    await vault.unlock('hunter22');
    expect(await vault.getActiveAccountId()).toBe('acct_2');
    // The default account is the active one, so withPrivkey needs no id.
    await vault.setActiveAccountId('acct_1');
    expect(await vault.withPrivkey(undefined, async (key) => bytesToHex(key))).toBe(account.privkey);
  });
});

describe('re-sealing', () => {
  test('changing the password re-seals under the new one', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await vault.create('hunter22', [account]);
    expect(await vault.changePassword('wrong', 'next-one')).toBe(false);
    expect(await vault.changePassword('hunter22', 'next-one')).toBe(true);
    vault.lock();
    expect(await vault.unlock('hunter22')).toBe(false);
    expect(await vault.unlock('next-one')).toBe(true);
  });

  test('a password change cannot quietly disarm the vault', async () => {
    // An empty new password is how "never lock" is stored. Reaching it through a password
    // change would leave a vault that still presents as protected while anyone can open it.
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await vault.create('hunter22', [account]);
    await expect(vault.changePassword('hunter22', '')).rejects.toThrow(/8 characters|required/i);
    vault.lock();
    expect(await vault.unlock('hunter22')).toBe(true);
  });

  test('an old vault is upgraded to the current work factor on unlock', async () => {
    const store = new MemoryStore();
    await writeLegacyRecord(
      store,
      { cacheKey: bytesToBase64(new Uint8Array(32).fill(7)), accounts: [account], activeAccountId: 'acct_1' },
      'hunter22',
      fastKdf,
      LEGACY_VAULT_PBKDF2_ITERATIONS,
    );
    const vault = new Vault({ store, kdf: fastKdf });
    expect(await vault.unlock('hunter22')).toBe(true);

    const upgraded = await readRecord(store);
    expect(upgraded!.iterations).toBe(VAULT_PBKDF2_ITERATIONS);
    // And the record still opens with the same password the user has always had, at the new
    // count — the whole point of doing this while the password is in hand.
    const { payload } = await openRecord(upgraded!, 'hunter22', fastKdf);
    expect(payload.accounts[0]).toEqual(account);
    vault.lock();
    expect(await vault.unlock('hunter22')).toBe(true);
  });

  test('a record with no iterations field is treated as legacy and upgraded', async () => {
    const store = new MemoryStore();
    await writeLegacyRecord(
      store,
      { cacheKey: bytesToBase64(new Uint8Array(32).fill(7)), accounts: [account], activeAccountId: 'acct_1' },
      'hunter22',
      fastKdf,
      LEGACY_VAULT_PBKDF2_ITERATIONS,
      { omitIterations: true },
    );
    const vault = new Vault({ store, kdf: fastKdf });
    expect(await vault.unlock('hunter22')).toBe(true);
    expect((await readRecord(store))!.iterations).toBe(VAULT_PBKDF2_ITERATIONS);
  });

  test('a never-lock vault is not "upgraded" into a slow one', async () => {
    // The empty password is published in the source; stretching it buys nothing and costs a
    // second on every cold start. `iterationsFor` says so, and the upgrade must agree.
    const store = new MemoryStore();
    const vault = new Vault({ store, kdf: fastKdf });
    await vault.create('', [account]);
    expect((await readRecord(store))!.iterations).toBe(LEGACY_VAULT_PBKDF2_ITERATIONS);
    vault.lock();
    expect(await vault.unlock('')).toBe(true);
    expect((await readRecord(store))!.iterations).toBe(LEGACY_VAULT_PBKDF2_ITERATIONS);
  });

  test('a minted cache key is persisted, so it is the same one on the next unlock', async () => {
    const store = new MemoryStore();
    // A record from before the cacheKey field existed: the reader has to invent one.
    await writeLegacyRecord(
      store,
      { accounts: [account], activeAccountId: 'acct_1' } as VaultPayload,
      'hunter22',
      fastKdf,
      VAULT_PBKDF2_ITERATIONS,
    );
    const vault = new Vault({ store, kdf: fastKdf });
    expect(await vault.unlock('hunter22')).toBe(true);

    const stored = await readRecord(store);
    const first = await openRecord(stored!, 'hunter22', fastKdf);
    // The re-seal already happened: reading it back never has to mint again.
    expect(first.cacheKeyMinted).toBe(false);

    vault.lock();
    expect(await vault.unlock('hunter22')).toBe(true);
    const second = await openRecord((await readRecord(store))!, 'hunter22', fastKdf);
    // A different key on every unlock makes everything in the private cache unreadable,
    // silently and with no error anywhere.
    expect(second.payload.cacheKey).toBe(first.payload.cacheKey);
  });
});

describe('the brute-force guard', () => {
  test('a run of failures locks unlock out before it derives anything', async () => {
    const store = new MemoryStore();
    let clock = 1000;
    const kdf = countingKdf();
    const vault = new Vault({ store, kdf, now: () => clock });
    await vault.create('hunter22', [account]);
    vault.lock();

    for (let i = 0; i < 5; i++) expect(await vault.unlock('wrong')).toBe(false);
    expect(await store.get<UnlockGuardState>(UNLOCK_GUARD_KEY)).toEqual({
      failures: 5,
      lockedUntil: 1000 + 60_000,
    });

    const derivations = kdf.calls;
    await expect(vault.unlock('hunter22')).rejects.toThrow(/too many/i);
    // Refused before the derivation, which is the point: otherwise the lockout is a second
    // of PBKDF2 an attacker can spend in parallel.
    expect(kdf.calls).toBe(derivations);

    clock = 1000 + 60_001;
    expect(await vault.unlock('hunter22')).toBe(true);
    expect(await store.get(UNLOCK_GUARD_KEY)).toBeUndefined();
  });

  test('the guard is persisted, so a fresh caller inherits the lockout', async () => {
    const store = new MemoryStore();
    const clock = () => 1000;
    const first = new Vault({ store, kdf: fastKdf, now: clock });
    await first.create('hunter22', [account]);
    first.lock();
    for (let i = 0; i < 5; i++) await first.unlock('wrong');

    // A caller that resets its own UI — a reloaded popup, a restarted process — must not
    // reset the counter with it.
    const second = new Vault({ store, kdf: fastKdf, now: clock });
    await expect(second.unlock('hunter22')).rejects.toThrow(/too many/i);
  });

  test('destroying the vault clears the guard', async () => {
    const store = new MemoryStore();
    const vault = new Vault({ store, kdf: fastKdf, now: () => 1000 });
    await vault.create('hunter22', [account]);
    vault.lock();
    for (let i = 0; i < 5; i++) await vault.unlock('wrong');
    await vault.destroy();
    expect(await store.get(UNLOCK_GUARD_KEY)).toBeUndefined();
  });

  test('a failed unlock must not wipe the current session', async () => {
    // The change-password flow re-verifies the password against an already open vault. A
    // typo there used to zero the live buffers and leave the user locked out of their own
    // unlocked session.
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await vault.create('hunter22', [account]);
    expect(await vault.unlock('wrong')).toBe(false);
    expect(vault.isLocked()).toBe(false);
    expect(await vault.withPrivkey('acct_1', async (key) => bytesToHex(key))).toBe(account.privkey);
  });
});

describe('auto-lock settings', () => {
  test('the interval persists and defaults to fifteen minutes', async () => {
    const store = new MemoryStore();
    const vault = new Vault({ store, kdf: fastKdf });
    expect(await vault.getAutoLockMs()).toBe(900_000);
    await vault.setAutoLockMs(300_000);
    expect(await vault.getAutoLockMs()).toBe(300_000);
    // Persisted, not in-memory: the interval has to survive the process that set it.
    expect(await new Vault({ store, kdf: fastKdf }).getAutoLockMs()).toBe(300_000);
    await expect(vault.setAutoLockMs(-1)).rejects.toThrow();
  });

  test('the idle timer locks the vault and does not hold the process open', async () => {
    const store = new MemoryStore();
    const vault = new Vault({ store, kdf: fastKdf });
    await vault.setAutoLockMs(5);

    // An auto-lock timer that keeps a ref turns every Node process that opened a vault into
    // one that will not exit, and every test run into a hang.
    const timers: Array<{ hasRef?: () => boolean }> = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
        const timer = (realSetTimeout as (...args: unknown[]) => unknown)(handler, ms, ...rest);
        timers.push(timer as { hasRef?: () => boolean });
        return timer;
      }) as unknown as typeof globalThis.setTimeout);
    try {
      await vault.create('hunter22', [account]);
    } finally {
      spy.mockRestore();
    }
    const refable = timers.filter((timer) => typeof timer.hasRef === 'function');
    expect(refable.length).toBeGreaterThan(0);
    expect(refable.every((timer) => timer.hasRef!() === false)).toBe(true);

    expect(vault.isLocked()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(vault.isLocked()).toBe(true);
    // A never-lock vault is not on a timer at all.
    await vault.setAutoLockMs(0);
    await vault.unlock('hunter22');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(vault.isLocked()).toBe(false);
    vault.lock();
  });
});

describe('the real work factor', () => {
  test('a vault created and reopened with the shipping PBKDF2', { timeout: 60_000 }, async () => {
    const store = new MemoryStore();
    const vault = new Vault({ store });
    await vault.create('hunter22', [account]);
    expect((await readRecord(store))!.iterations).toBe(VAULT_PBKDF2_ITERATIONS);
    vault.lock();
    expect(await vault.unlock('hunter22')).toBe(true);
    expect(await vault.withPrivkey('acct_1', async (key) => bytesToHex(key))).toBe(account.privkey);
  });

  test('a vault the extension wrote at the old work factor is upgraded in place', { timeout: 60_000 }, async () => {
    const fixtures = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
    const record = JSON.parse(
      readFileSync(join(fixtures, 'extension-vault-v1-no-iterations.json'), 'utf8'),
    ) as VaultRecord;
    const expected = JSON.parse(
      readFileSync(join(fixtures, 'extension-vault-v1-no-iterations.plaintext.json'), 'utf8'),
    ) as { password: string; payload: VaultPayload };

    const store = new MemoryStore();
    await store.set(VAULT_STORAGE_KEY, record);
    const vault = new Vault({ store });
    expect(await vault.unlock(expected.password)).toBe(true);
    expect((await vault.listAccounts())[0]!.pubkey).toBe(expected.payload.accounts[0]!.pubkey);

    const upgraded = await readRecord(store);
    expect(record.iterations).toBeUndefined();
    expect(upgraded!.iterations).toBe(VAULT_PBKDF2_ITERATIONS);
    vault.lock();
    expect(await vault.unlock(expected.password)).toBe(true);
  });
});

describe('racing the session', () => {
  /**
   * A derivation that parks until the test lets it through, so a lock can be taken while an
   * unlock is genuinely mid-flight rather than merely queued behind one. At the shipping work
   * factor that window is about a second wide in real life.
   */
  function gatedKdf(gateCall = 1): Pbkdf2Port & { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    let calls = 0;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      entered,
      release,
      async derive(password, salt, iterations) {
        calls += 1;
        // `gateCall` picks WHICH derivation to park in: a password change derives twice, and
        // the interesting window is the second one, inside the re-seal.
        if (calls === gateCall) {
          markEntered();
          await gate;
        }
        return fastKdf.derive(password, salt, iterations);
      },
    };
  }

  test('destroy beats an unlock that is already in flight', async () => {
    const store = new MemoryStore();
    const vault = new Vault({ store, kdf: fastKdf });
    await vault.create('hunter22', [account]);
    vault.lock();

    // The unlock is on the lane; destroy locks synchronously and queues behind it. Without a
    // session revision the unlock lands afterwards and repopulates the payload — a destroyed
    // vault still handing out the private key, which is the worst outcome this has.
    const pending = vault.unlock('hunter22');
    await vault.destroy();
    expect(await pending).toBe(false);

    expect(vault.isLocked()).toBe(true);
    expect(await vault.exists()).toBe(false);
    await expect(vault.withPrivkey('acct_1', async () => 'x')).rejects.toThrow(/locked/i);
  });

  test('an explicit lock beats an unlock that is already in flight', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await vault.create('hunter22', [account]);
    vault.lock();

    const pending = vault.unlock('hunter22');
    vault.lock();
    expect(await pending).toBe(false);
    expect(vault.isLocked()).toBe(true);
  });

  test('a lock taken during the derivation is not undone when it finishes', async () => {
    const store = new MemoryStore();
    const kdf = gatedKdf();
    const vault = new Vault({ store, kdf: fastKdf });
    await vault.create('hunter22', [account]);
    vault.lock();

    const gatedVault = new Vault({ store, kdf });
    const pending = gatedVault.unlock('hunter22');
    await kdf.entered;
    // Lock-on-blur, a panic lock, or the auto-lock firing: all land here, inside the window.
    gatedVault.lock();
    kdf.release();

    expect(await pending).toBe(false);
    expect(gatedVault.isLocked()).toBe(true);
    await expect(gatedVault.withPrivkey('acct_1', async () => 'x')).rejects.toThrow(/locked/i);
  });

  test('an overtaken unlock is not charged to the brute-force guard', async () => {
    // The password was right; the user just locked the vault. Counting it would walk an
    // ordinary lock-on-blur towards a lockout.
    const store = new MemoryStore();
    const vault = new Vault({ store, kdf: fastKdf });
    await vault.create('hunter22', [account]);
    vault.lock();

    const pending = vault.unlock('hunter22');
    vault.lock();
    expect(await pending).toBe(false);
    expect(await store.get(UNLOCK_GUARD_KEY)).toBeUndefined();
  });

  test('locking during a signing callback zeroes the key the callback is holding', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await vault.create('hunter22', [account]);
    let observed: number[] = [];
    // The call is void as well as zeroed: whatever the callback computed after the lock landed
    // was computed under a revoked session, so it must not come back as a result.
    await expect(
      vault.withPrivkey('acct_1', async (key) => {
        expect(bytesToHex(key)).toBe(account.privkey);
        vault.lock();
        // Otherwise the callback signs on with live key material while isLocked() says true.
        observed = Array.from(key);
        return 'a signature over zeroes';
      }),
    ).rejects.toThrow(/session/i);
    expect(observed).toEqual(new Array(32).fill(0));
  });

  test('creating a vault clears the lockout left by the one it replaces', async () => {
    // Five wrong guesses, then "forgot my password, start over" — the new vault must not
    // inherit a lockout the user cannot wait out of their own setup flow.
    const store = new MemoryStore();
    const vault = new Vault({ store, kdf: fastKdf, now: () => 1000 });
    await vault.create('hunter22', [account]);
    vault.lock();
    for (let i = 0; i < 5; i++) await vault.unlock('wrong');

    await vault.create('next-one', [account]);
    expect(await store.get(UNLOCK_GUARD_KEY)).toBeUndefined();
    vault.lock();
    expect(await vault.unlock('next-one')).toBe(true);
  });
});

describe('racing the session, round two', () => {
  /** As above: park inside a chosen derivation until the test lets it through. */
  function gatedKdf(gateCall = 1): Pbkdf2Port & { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    let calls = 0;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      entered,
      release,
      async derive(password, salt, iterations) {
        calls += 1;
        if (calls === gateCall) {
          markEntered();
          await gate;
        }
        return fastKdf.derive(password, salt, iterations);
      },
    };
  }

  test('a signing callback that outlives a lock does not return a result', async () => {
    // Zeroing the copy mid-callback is necessary but not sufficient: NIP-44, HMAC and AES-GCM
    // all accept 32 zero bytes without complaint, so returning the value would hand the caller
    // a publishable signature or ciphertext computed under a zero key, with nothing to notice.
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await vault.create('hunter22', [account]);

    const pending = vault.withPrivkey('acct_1', async (key) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return bytesToHex(key);
    });
    vault.lock();
    await expect(pending).rejects.toThrow(/session|locked/i);
  });

  test('a lock during a password change is not undone by it', async () => {
    const store = new MemoryStore();
    const setup = new Vault({ store, kdf: fastKdf });
    await setup.create('hunter22', [account]);
    setup.lock();

    // Derivation 1 is the unlock that verifies the current password; derivation 2 is the
    // re-seal under the new one. The re-seal is where the ~1 second window lives, and the
    // auto-lock armed by that very unlock can fire inside it — no adversary required.
    const kdf = gatedKdf(2);
    const vault = new Vault({ store, kdf });
    const pending = vault.changePassword('hunter22', 'next-one');
    await kdf.entered;
    vault.lock();
    kdf.release();

    await expect(pending).rejects.toThrow(/session/i);
    expect(vault.isLocked()).toBe(true);
    // The record was never rewritten, so the password the user still has is the one that works.
    expect(await vault.unlock('hunter22')).toBe(true);
  });

  test('a failed cache-key save ends the session for anything queued behind it', async () => {
    const backing = new MemoryStore();
    // A record from before the cacheKey field: unlocking has to mint one and save it.
    await writeLegacyRecord(
      backing,
      { accounts: [account], activeAccountId: 'acct_1' } as VaultPayload,
      'hunter22',
      fastKdf,
      VAULT_PBKDF2_ITERATIONS,
    );
    let failWrites = true;
    const store: KeyValueStore = {
      get: (key) => backing.get(key),
      set: async (key, value) => {
        if (failWrites && key === VAULT_STORAGE_KEY) throw new Error('storage is full');
        return backing.set(key, value);
      },
      remove: (key) => backing.remove(key),
      keys: () => backing.keys(),
    };

    const vault = new Vault({ store, kdf: fastKdf });
    const first = vault.unlock('hunter22');
    const second = vault.unlock('hunter22');

    await expect(first).rejects.toThrow(/storage is full/);
    // The first unlock locked the vault; the second was queued against that same session and
    // must be told so rather than marching on as if nothing had happened.
    expect(await second).toBe(false);
    expect(vault.isLocked()).toBe(true);

    failWrites = false;
    expect(await vault.unlock('hunter22')).toBe(true);
  });
});

describe('racing the storage write', () => {
  test('a lock during the re-seal\'s write does not install a key into a locked vault', async () => {
    const backing = new MemoryStore();
    const setup = new Vault({ store: backing, kdf: fastKdf });
    await setup.create('hunter22', [account]);
    setup.lock();

    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The derivation is not the only window: the write after it is one too, and on a host
    // whose storage is a round trip it can be the longer of the two.
    let parkNextRecordWrite = true;
    const store: KeyValueStore = {
      get: (key) => backing.get(key),
      set: async (key, value) => {
        if (parkNextRecordWrite && key === VAULT_STORAGE_KEY) {
          parkNextRecordWrite = false;
          markEntered();
          await gate;
        }
        return backing.set(key, value);
      },
      remove: (key) => backing.remove(key),
      keys: () => backing.keys(),
    };

    const vault = new Vault({ store, kdf: fastKdf });
    const pending = vault.changePassword('hunter22', 'next-one');
    await entered;
    vault.lock();
    release();

    // Otherwise this resolves true over a locked vault, with a live AES-256 vault key installed
    // into the held slot and nothing to zero it until the next lock or unlock.
    await expect(pending).rejects.toThrow(/session/i);
    expect(vault.isLocked()).toBe(true);
    // The write itself was already in flight and did land, so the new password is now the one
    // that opens the record — the vault just refuses to hold its key.
    expect(await vault.unlock('next-one')).toBe(true);
  });
});
