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
import { Vault, type PqKeyPair } from '../src/vault.js';
import * as serialization from '../src/serialization.js';
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
import type { MemoryVaultPayload, VaultPayload, VaultRecord } from '../src/types.js';

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
  /**
   * Nothing in `src/` exposes the live payload, by ruling. The test intercepts it where it is
   * born instead: `toMemoryPayload` is what `create`/`unlock` install, so a spy on that export
   * hands the test the very object the vault holds. Every string still on it after `lock()`
   * is a string the collector, not the vault, decides the fate of.
   */
  test('nothing the vault holds after lock() still spells a NIP-46 secret', async () => {
    const remote: Account = {
      ...watcher,
      id: 'acct_bunker',
      type: 'nip46',
      nip46Config: {
        bunkerUrl: `bunker://${'12'.repeat(32)}?relay=wss%3A%2F%2Frelay.example`,
        relay: 'wss://relay.example',
        secret: 'topsecret-token',
        localPrivkey: '5a'.repeat(32),
        localPubkey: '6b'.repeat(32),
      },
    };
    const installed: MemoryVaultPayload[] = [];
    const real = serialization.toMemoryPayload;
    const spy = vi.spyOn(serialization, 'toMemoryPayload').mockImplementation((payload) => {
      const mem = real(payload);
      installed.push(mem);
      return mem;
    });
    try {
      const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
      await vault.create('hunter22', [account, remote]);
      expect(installed).toHaveLength(1);
      vault.lock();

      const strings: string[] = [];
      JSON.stringify(installed[0], (_key, value: unknown) => {
        if (typeof value === 'string') strings.push(value);
        return value instanceof Uint8Array ? Array.from(value) : value;
      });
      expect(strings.some((text) => text.includes('topsecret-token'))).toBe(false);
      expect(strings.some((text) => text.includes('5a'.repeat(32)))).toBe(false);
      const bunker = installed[0]!.accounts.find((candidate) => candidate.id === 'acct_bunker')!;
      expect(Array.from(bunker.nip46!.secretBytes!)).toEqual(new Array('topsecret-token'.length).fill(0));
      expect(Array.from(bunker.nip46!.localPrivkeyBytes!)).toEqual(new Array(64).fill(0));
    } finally {
      spy.mockRestore();
    }
  });

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
    // There is no "the active one" shorthand: a caller names the account, every time.
    await vault.setActiveAccountId('acct_1');
    const active = (await vault.getActiveAccountId())!;
    expect(await vault.withPrivkey(active, async (key) => bytesToHex(key))).toBe(account.privkey);
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

// ── The account surface ──

const MNEMONIC = `${'abandon '.repeat(23)}art`;

const seeded: Account = {
  ...account,
  id: 'acct_seed',
  name: 'Seed',
  mnemonic: MNEMONIC,
  derivationIndex: 0,
  derivationPath: "m/44'/1237'/0'/0/0",
};

const bunker: Account = {
  ...watcher,
  id: 'acct_bunker',
  name: 'Bunker',
  type: 'nip46',
  pubkey: '12'.repeat(32),
  nip46Config: {
    bunkerUrl: `bunker://${'12'.repeat(32)}?relay=wss%3A%2F%2Frelay.example`,
    relay: 'wss://relay.example',
    secret: 'topsecret-token',
  },
};

const pqKeys = {
  kem: { publicKey: new Uint8Array(8).fill(1), secretKey: new Uint8Array(8).fill(2) },
  dsa: { publicKey: new Uint8Array(8).fill(3), secretKey: new Uint8Array(8).fill(4) },
};

async function openVault(accounts: Account[]): Promise<{ vault: Vault; store: MemoryStore }> {
  const store = new MemoryStore();
  const vault = new Vault({ store, kdf: fastKdf });
  await vault.create('hunter22', accounts);
  return { vault, store };
}

/** What the record on disk says, opened independently of the vault that wrote it. */
async function reopen(store: MemoryStore): Promise<VaultPayload> {
  const record = (await readRecord(store))!;
  return (await openRecord(record, 'hunter22', fastKdf)).payload;
}

const zeros = (length: number) => new Array(length).fill(0);

describe('account mutation', () => {
  test('addAccount re-seals the record with the new account and it is there after a fresh unlock', async () => {
    const { vault, store } = await openVault([account]);
    await vault.addAccount(seeded);
    expect((await vault.listAccounts()).map((candidate) => candidate.id)).toEqual(['acct_1', 'acct_seed']);
    expect((await reopen(store)).accounts).toEqual([account, seeded]);
    // The first account stays active: adding is not switching.
    expect(await vault.getActiveAccountId()).toBe('acct_1');
  });

  test('addAccount refuses a duplicate id, and a locked vault', async () => {
    const { vault } = await openVault([account]);
    await expect(vault.addAccount({ ...seeded, id: 'acct_1' })).rejects.toThrow(/already exists/i);
    vault.lock();
    await expect(vault.addAccount(seeded)).rejects.toThrow(/locked/i);
  });

  test('addAccount does not keep an account in memory that the store refused to persist', async () => {
    const backing = new MemoryStore();
    let fail = false;
    const store: KeyValueStore = {
      get: (key) => backing.get(key),
      set: async (key, value) => {
        if (fail && key === VAULT_STORAGE_KEY) throw new Error('disk full');
        return backing.set(key, value);
      },
      remove: (key) => backing.remove(key),
      keys: () => backing.keys(),
    };
    const vault = new Vault({ store, kdf: fastKdf });
    await vault.create('hunter22', [account]);
    fail = true;
    await expect(vault.addAccount(seeded)).rejects.toThrow(/disk full/);
    expect((await vault.listAccounts()).map((candidate) => candidate.id)).toEqual(['acct_1']);
    await expect(vault.withMnemonic('acct_seed', async () => 'x')).rejects.toThrow(/no seed phrase/i);
  });

  test('removeAccount drops the account, moves the active pointer and re-seals', async () => {
    const { vault, store } = await openVault([account, seeded]);
    await vault.removeAccount('acct_1');
    expect((await vault.listAccounts()).map((candidate) => candidate.id)).toEqual(['acct_seed']);
    expect(await vault.getActiveAccountId()).toBe('acct_seed');
    expect(await reopen(store)).toMatchObject({ accounts: [seeded], activeAccountId: 'acct_seed' });
    await expect(vault.removeAccount('acct_nope')).rejects.toThrow(/not found/i);
  });

  test('removeAccount zeroes the removed account\'s secrets and voids a callback still holding its key', async () => {
    const installed: MemoryVaultPayload[] = [];
    const real = serialization.toMemoryPayload;
    const spy = vi.spyOn(serialization, 'toMemoryPayload').mockImplementation((payload) => {
      const mem = real(payload);
      installed.push(mem);
      return mem;
    });
    try {
      const { vault } = await openVault([account, seeded]);
      const live = installed[0]!.accounts.find((candidate) => candidate.id === 'acct_seed')!;

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = vault.withPrivkey('acct_seed', async (key) => {
        await gate;
        return bytesToHex(key);
      });
      await vault.removeAccount('acct_seed');
      release();
      // The key the callback holds belonged to an account that no longer exists: void.
      await expect(pending).rejects.toThrow(/session/i);
      expect(Array.from(live.privkeyBytes!)).toEqual(zeros(32));
      expect(Array.from(live.mnemonicBytes!)).toEqual(zeros(MNEMONIC.length));
      // The vault itself is still open; removing an account is not a lock.
      expect(vault.isLocked()).toBe(false);
      expect(await vault.withPrivkey('acct_1', async (key) => bytesToHex(key))).toBe(account.privkey);
    } finally {
      spy.mockRestore();
    }
  });

  test('updateAccountNip46Keys stores the local keypair as hex, copying the bytes it was given', async () => {
    const { vault, store } = await openVault([account, bunker]);
    const localKey = new Uint8Array(32).fill(0x5a);
    await vault.updateAccountNip46Keys('acct_bunker', localKey, '6b'.repeat(32));
    localKey.fill(9); // the caller's buffer is theirs; the vault keeps its own copy
    const stored = (await reopen(store)).accounts.find((candidate) => candidate.id === 'acct_bunker')!;
    expect(stored.nip46Config).toEqual({ ...bunker.nip46Config, localPrivkey: '5a'.repeat(32), localPubkey: '6b'.repeat(32) });
    await vault.withRemoteSignerCredentials('acct_bunker', async (creds) => {
      expect(bytesToHex(creds.localPrivkey!)).toBe('5a'.repeat(32));
      expect(creds.localPubkey).toBe('6b'.repeat(32));
    });
  });

  test('updateAccountNip46Keys zeroes the keypair it replaces and refuses a non-NIP-46 account', async () => {
    const { vault } = await openVault([account, bunker]);
    await vault.updateAccountNip46Keys('acct_bunker', new Uint8Array(32).fill(1), '01'.repeat(32));
    let previous: Uint8Array | null = null;
    await vault.withRemoteSignerCredentials('acct_bunker', async (creds) => {
      previous = creds.localPrivkey;
    });
    // The scoped copy is zeroed on return; the test wants the vault's own buffer, which only
    // the round trip can reveal: after the update the old key must not read back anywhere.
    await vault.updateAccountNip46Keys('acct_bunker', new Uint8Array(32).fill(2), '02'.repeat(32));
    await vault.withRemoteSignerCredentials('acct_bunker', async (creds) => {
      expect(bytesToHex(creds.localPrivkey!)).toBe('02'.repeat(32));
    });
    expect(Array.from(previous!)).toEqual(zeros(32));
    await expect(vault.updateAccountNip46Keys('acct_1', new Uint8Array(32), '00'.repeat(32))).rejects.toThrow(/nip-46/i);
    await expect(vault.updateAccountNip46Keys('acct_bunker', new Uint8Array(31), '00'.repeat(32))).rejects.toThrow(/32 bytes/);
  });

  test('every mutation refuses to land on a session that moved while it waited for the lane', async () => {
    const { vault } = await openVault([account, bunker]);
    // Park the lane behind a mutation that never finishes until released.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const parked = vault.withPrivkey('acct_1', async () => gate); // not on the lane; just keeps things busy
    const queued = [
      vault.addAccount(seeded),
      vault.removeAccount('acct_bunker'),
      vault.updateAccountNip46Keys('acct_bunker', new Uint8Array(32), '00'.repeat(32)),
      vault.setImportedPqKeys('acct_1', pqKeys, 'nip-pqc/v1'),
      vault.clearImportedPqKeys('acct_1'),
    ];
    vault.lock();
    release();
    for (const operation of queued) await expect(operation).rejects.toThrow(/session|locked/i);
    await expect(parked).rejects.toThrow(/session/i);
    expect(await vault.unlock('hunter22')).toBe(true);
    expect((await vault.listAccounts()).map((candidate) => candidate.id)).toEqual(['acct_1', 'acct_bunker']);
  });
});

describe('a write that fails after the session has died', () => {
  /** A store whose next record write locks the vault and then fails, or just fails. */
  function failingStore(lockFirst: boolean): { store: KeyValueStore; arm: (vault: Vault) => void } {
    const backing = new MemoryStore();
    let target: Vault | null = null;
    const store: KeyValueStore = {
      get: (key) => backing.get(key),
      set: async (key, value) => {
        if (target && key === VAULT_STORAGE_KEY) {
          const vault = target;
          target = null;
          if (lockFirst) vault.lock();
          throw new Error('disk full');
        }
        return backing.set(key, value);
      },
      remove: (key) => backing.remove(key),
      keys: () => backing.keys(),
    };
    return { store, arm: (vault) => { target = vault; } };
  }

  /** The live payload the vault installs, taken where it is born. */
  function captureInstalled(): { installed: MemoryVaultPayload[]; restore: () => void } {
    const installed: MemoryVaultPayload[] = [];
    const real = serialization.toMemoryPayload;
    const spy = vi.spyOn(serialization, 'toMemoryPayload').mockImplementation((payload) => {
      const mem = real(payload);
      installed.push(mem);
      return mem;
    });
    return { installed, restore: () => spy.mockRestore() };
  }

  test('removeAccount: the undo restores the account while the session is alive', async () => {
    const { store, arm } = failingStore(false);
    const vault = new Vault({ store, kdf: fastKdf });
    await vault.create('hunter22', [account, seeded]);
    arm(vault);
    await expect(vault.removeAccount('acct_seed')).rejects.toThrow(/disk full/);
    expect(vault.isLocked()).toBe(false);
    expect((await vault.listAccounts()).map((candidate) => candidate.id)).toEqual(['acct_1', 'acct_seed']);
    expect(await vault.withMnemonic('acct_seed', async (phrase) => new TextDecoder().decode(phrase))).toBe(MNEMONIC);
  });

  test('removeAccount: when a lock landed inside the write, the outgoing secrets are zeroed, not restored', async () => {
    // Restoring them would re-insert live key material into a payload that is already dead:
    // the lock zeroed everything it could reach, and nothing will ever lock this object again.
    const { installed, restore } = captureInstalled();
    try {
      const { store, arm } = failingStore(true);
      const vault = new Vault({ store, kdf: fastKdf });
      await vault.create('hunter22', [account, seeded]);
      const dead = installed[0]!;
      const removed = dead.accounts.find((candidate) => candidate.id === 'acct_seed')!;
      arm(vault);
      await expect(vault.removeAccount('acct_seed')).rejects.toThrow(/disk full/);
      expect(vault.isLocked()).toBe(true);
      expect(Array.from(removed.privkeyBytes!)).toEqual(zeros(32));
      expect(Array.from(removed.mnemonicBytes!)).toEqual(zeros(MNEMONIC.length));
      // Nothing anywhere on the dead payload spells a secret.
      for (const acct of dead.accounts) {
        expect(Array.from(acct.privkeyBytes ?? [])).toEqual(zeros(acct.privkeyBytes?.length ?? 0));
      }
    } finally {
      restore();
    }
  });

  test('updateAccountNip46Keys: when a lock landed inside the write, the previous local key is zeroed', async () => {
    const { installed, restore } = captureInstalled();
    try {
      const { store, arm } = failingStore(true);
      const vault = new Vault({ store, kdf: fastKdf });
      await vault.create('hunter22', [
        account,
        { ...bunker, nip46Config: { ...bunker.nip46Config!, localPrivkey: '5a'.repeat(32), localPubkey: '6b'.repeat(32) } },
      ]);
      const config = installed[0]!.accounts.find((candidate) => candidate.id === 'acct_bunker')!.nip46!;
      const previous = config.localPrivkeyBytes!;
      arm(vault);
      await expect(vault.updateAccountNip46Keys('acct_bunker', new Uint8Array(32).fill(1), '01'.repeat(32))).rejects.toThrow(
        /disk full/,
      );
      expect(vault.isLocked()).toBe(true);
      expect(Array.from(previous)).toEqual(zeros(64));
      expect(Array.from(config.localPrivkeyBytes ?? [])).toEqual(zeros(config.localPrivkeyBytes?.length ?? 0));
    } finally {
      restore();
    }
  });

  test('a mutation refused before it runs allocates no secret copy to drop', async () => {
    const spy = vi.spyOn(serialization, 'bytesToHexBytes');
    try {
      const { vault } = await openVault([account, bunker]);
      vault.lock();
      await expect(vault.updateAccountNip46Keys('acct_bunker', new Uint8Array(32).fill(1), '01'.repeat(32))).rejects.toThrow(
        /locked/i,
      );
      expect(spy).not.toHaveBeenCalled();
      await vault.unlock('hunter22');
      await expect(vault.updateAccountNip46Keys('acct_1', new Uint8Array(32).fill(1), '01'.repeat(32))).rejects.toThrow(
        /nip-46/i,
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * A copy is `new Uint8Array(source)`, which nothing outside can see. A Proxy around the
   * source can: without an iterator the constructor takes the array-like path and reads
   * `length` and every index off it, so a source that was never read was never copied.
   */
  function observedKeys(): { keys: PqKeyPair; reads: () => number } {
    let reads = 0;
    const observe = (bytes: Uint8Array): Uint8Array =>
      new Proxy(bytes, {
        get(target, property, receiver) {
          if (property === Symbol.iterator) return undefined;
          reads += 1;
          void receiver;
          return Reflect.get(target, property, target) as unknown;
        },
      });
    return {
      keys: {
        kem: { publicKey: new Uint8Array(8).fill(1), secretKey: observe(new Uint8Array(8).fill(2)) },
        dsa: { publicKey: new Uint8Array(8).fill(3), secretKey: observe(new Uint8Array(8).fill(4)) },
      },
      reads: () => reads,
    };
  }

  test('setImportedPqKeys refused before it runs never reads the secret keys, so nothing was copied', async () => {
    const { vault } = await openVault([account]);
    vault.lock();
    const locked = observedKeys();
    await expect(vault.setImportedPqKeys('acct_1', locked.keys, 'nip-pqc/v1')).rejects.toThrow(/locked/i);
    expect(locked.reads()).toBe(0);
    await vault.unlock('hunter22');
    const missing = observedKeys();
    await expect(vault.setImportedPqKeys('acct_nope', missing.keys, 'nip-pqc/v1')).rejects.toThrow(/not found/i);
    expect(missing.reads()).toBe(0);
    // And the same source IS read when the call goes through, or the probe proves nothing.
    const accepted = observedKeys();
    await vault.setImportedPqKeys('acct_1', accepted.keys, 'nip-pqc/v1');
    expect(accepted.reads()).toBeGreaterThan(0);
  });

  test('setImportedPqKeys with a public half that cannot be encoded copies no secret first', async () => {
    // The public halves are encoded before the secrets are copied: a bad public half throws
    // with nothing allocated, rather than after two un-zeroed copies exist that nothing holds.
    const { vault } = await openVault([account]);
    const probe = observedKeys();
    const bad: PqKeyPair = { ...probe.keys, kem: { ...probe.keys.kem, publicKey: 'nope' as unknown as Uint8Array } };
    await expect(vault.setImportedPqKeys('acct_1', bad, 'nip-pqc/v1')).rejects.toThrow();
    expect(probe.reads()).toBe(0);
    expect(vault.hasImportedPqKeys('acct_1')).toBe(false);
  });
});

describe('a mutation that replaces or destroys secret material voids the callbacks holding them', () => {
  /** Park a scoped accessor on a gate, run `mutation` while it is parked, release, and settle. */
  async function raced<T>(
    run: (gate: Promise<void>) => Promise<T>,
    mutation: () => Promise<unknown>,
  ): Promise<PromiseSettledResult<T>> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = run(gate);
    await flush();
    await mutation();
    release();
    return (await Promise.allSettled([pending]))[0]!;
  }

  test('clearImportedPqKeys inside withImportedPqKeys: the secret the callback holds no longer exists', async () => {
    const { vault } = await openVault([account]);
    await vault.setImportedPqKeys('acct_1', pqKeys, 'nip-pqc/v1');
    const outcome = await raced(
      (gate) => vault.withImportedPqKeys('acct_1', async (keys) => { await gate; return Array.from(keys.kemSecret); }),
      () => vault.clearImportedPqKeys('acct_1'),
    );
    expect(outcome.status).toBe('rejected');
    expect(String((outcome as PromiseRejectedResult).reason)).toMatch(/session/i);
    expect(vault.isLocked()).toBe(false);
  });

  test('setImportedPqKeys inside withImportedPqKeys: the replaced secret is void too', async () => {
    const { vault } = await openVault([account]);
    await vault.setImportedPqKeys('acct_1', pqKeys, 'nip-pqc/v1');
    const replacement = {
      kem: { publicKey: new Uint8Array(8).fill(5), secretKey: new Uint8Array(8).fill(6) },
      dsa: { publicKey: new Uint8Array(8).fill(7), secretKey: new Uint8Array(8).fill(8) },
    };
    const outcome = await raced(
      (gate) => vault.withImportedPqKeys('acct_1', async () => { await gate; return 'stale'; }),
      () => vault.setImportedPqKeys('acct_1', replacement, 'nip-pqc/v1'),
    );
    expect(outcome.status).toBe('rejected');
    await vault.withImportedPqKeys('acct_1', async (keys) => {
      expect(Array.from(keys.kemSecret)).toEqual(Array.from(replacement.kem.secretKey));
    });
  });

  test('updateAccountNip46Keys inside withRemoteSignerCredentials: the replaced local key is void', async () => {
    const { vault } = await openVault([account, bunker]);
    await vault.updateAccountNip46Keys('acct_bunker', new Uint8Array(32).fill(1), '01'.repeat(32));
    const outcome = await raced(
      (gate) => vault.withRemoteSignerCredentials('acct_bunker', async () => { await gate; return 'stale'; }),
      () => vault.updateAccountNip46Keys('acct_bunker', new Uint8Array(32).fill(2), '02'.repeat(32)),
    );
    expect(outcome.status).toBe('rejected');
  });

  test('addAccount touches no existing secret, so a callback holding another account\'s key is not voided', async () => {
    const { vault } = await openVault([account]);
    const outcome = await raced(
      (gate) => vault.withPrivkey('acct_1', async (key) => { await gate; return bytesToHex(key); }),
      () => vault.addAccount(seeded),
    );
    expect(outcome).toEqual({ status: 'fulfilled', value: account.privkey });
  });
});

describe('create and addAccount agree', () => {
  test('create refuses duplicate account ids, as addAccount does', async () => {
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
    await expect(vault.create('hunter22', [account, { ...seeded, id: 'acct_1' }])).rejects.toThrow(/unique|already exists/i);
    expect(await vault.exists()).toBe(false);
  });
});

describe('imported post-quantum keys', () => {
  test('setImportedPqKeys stores the pair, hasImportedPqKeys sees it, and the record carries it', async () => {
    const { vault, store } = await openVault([account]);
    expect(vault.hasImportedPqKeys('acct_1')).toBe(false);
    await vault.setImportedPqKeys('acct_1', pqKeys, 'nip-pqc/v1');
    expect(vault.hasImportedPqKeys('acct_1')).toBe(true);
    const stored = (await reopen(store)).accounts[0]!;
    expect(stored.pqKeys).toEqual({
      profile: 'nip-pqc/v1',
      kem: { public: bytesToBase64(pqKeys.kem.publicKey), secret: bytesToBase64(pqKeys.kem.secretKey) },
      dsa: { public: bytesToBase64(pqKeys.dsa.publicKey), secret: bytesToBase64(pqKeys.dsa.secretKey) },
      importedAt: expect.any(Number),
    });
  });

  test('withImportedPqKeys hands out copies and zeroes them; clearImportedPqKeys removes them', async () => {
    const { vault, store } = await openVault([account]);
    await vault.setImportedPqKeys('acct_1', pqKeys, 'nip-pqc/v1');
    let kem: Uint8Array | null = null;
    let dsa: Uint8Array | null = null;
    await vault.withImportedPqKeys('acct_1', async (keys) => {
      kem = keys.kemSecret;
      dsa = keys.dsaSecret;
      expect(Array.from(keys.kemSecret)).toEqual(Array.from(pqKeys.kem.secretKey));
      expect(keys.kemPublic).toBe(bytesToBase64(pqKeys.kem.publicKey));
      expect(keys.profile).toBe('nip-pqc/v1');
      keys.kemSecret.fill(7); // a copy: the vault's buffer is untouched below
    });
    expect(Array.from(kem!)).toEqual(zeros(8));
    expect(Array.from(dsa!)).toEqual(zeros(8));
    await vault.withImportedPqKeys('acct_1', async (keys) => {
      expect(Array.from(keys.kemSecret)).toEqual(Array.from(pqKeys.kem.secretKey));
    });

    expect(await vault.clearImportedPqKeys('acct_1')).toBe(true);
    expect(await vault.clearImportedPqKeys('acct_1')).toBe(false);
    expect(vault.hasImportedPqKeys('acct_1')).toBe(false);
    await expect(vault.withImportedPqKeys('acct_1', async () => 'x')).rejects.toThrow(/no imported/i);
    expect((await reopen(store)).accounts[0]!.pqKeys).toBeNull();
  });
});

describe('scoped access to the other secrets', () => {
  test('withMnemonic hands out the phrase as bytes and zeroes the copy on every path', async () => {
    const { vault } = await openVault([account, seeded]);
    let captured: Uint8Array | null = null;
    expect(
      await vault.withMnemonic('acct_seed', async (phrase) => {
        captured = phrase;
        return new TextDecoder().decode(phrase);
      }),
    ).toBe(MNEMONIC);
    expect(Array.from(captured!)).toEqual(zeros(MNEMONIC.length));
    await expect(
      vault.withMnemonic('acct_seed', async (phrase) => {
        captured = phrase;
        throw new Error('derivation blew up');
      }),
    ).rejects.toThrow(/derivation blew up/);
    expect(Array.from(captured!)).toEqual(zeros(MNEMONIC.length));
    await expect(vault.withMnemonic('acct_1', async () => 'x')).rejects.toThrow(/no seed phrase/i);
    vault.lock();
    await expect(vault.withMnemonic('acct_seed', async () => 'x')).rejects.toThrow(/locked/i);
  });

  test('hasMnemonic says whether an account holds a seed phrase, reveals nothing, and is false while locked', async () => {
    const { vault } = await openVault([account, seeded]);
    expect(vault.hasMnemonic('acct_seed')).toBe(true);
    expect(vault.hasMnemonic('acct_1')).toBe(false);
    expect(vault.hasMnemonic('no_such_account')).toBe(false);
    vault.lock();
    expect(vault.hasMnemonic('acct_seed')).toBe(false);
  });

  test('withCacheKey hands out a 32 byte copy of the cache key and zeroes it', async () => {
    const { vault, store } = await openVault([account]);
    let captured: Uint8Array | null = null;
    const seen = await vault.withCacheKey(async (key) => {
      captured = key;
      return bytesToBase64(key);
    });
    expect(seen).toBe((await reopen(store)).cacheKey);
    expect(captured!.length).toBe(32);
    expect(Array.from(captured!)).toEqual(zeros(32));
    vault.lock();
    await expect(vault.withCacheKey(async () => 'x')).rejects.toThrow(/locked/i);
  });

  test('withRemoteSignerCredentials hands out the config with its secrets as bytes, zeroed after', async () => {
    const { vault } = await openVault([account, bunker]);
    let secret: Uint8Array | null = null;
    await vault.withRemoteSignerCredentials('acct_bunker', async (creds) => {
      secret = creds.secret;
      expect(new TextDecoder().decode(creds.secret!)).toBe('topsecret-token');
      expect(creds.bunkerUrl).toBe(bunker.nip46Config!.bunkerUrl);
      expect(creds.relay).toBe('wss://relay.example');
      expect(creds.localPrivkey).toBeNull();
      expect(creds.localPubkey).toBeUndefined();
    });
    expect(Array.from(secret!)).toEqual(zeros('topsecret-token'.length));
    await expect(vault.withRemoteSignerCredentials('acct_1', async () => 'x')).rejects.toThrow(/nip-46/i);
  });

  test('withDerivedSecrets zeroes the buffers it was handed, on return and on throw, and refuses while locked', async () => {
    // The accessor for a secret the vault cannot hand out because it never stored it: keys a
    // caller derived from a mnemonic the vault does hold. It exists so `lock()` reaches those
    // too, which the enumeration below covers; this is its own contract.
    const { vault } = await openVault([seeded]);
    const kem = new Uint8Array(32).fill(3);
    const dsa = new Uint8Array(64).fill(4);
    expect(await vault.withDerivedSecrets([kem, dsa], async () => 'computed')).toBe('computed');
    expect(Array.from(kem)).toEqual(zeros(32));
    expect(Array.from(dsa)).toEqual(zeros(64));

    const onThrow = new Uint8Array(16).fill(5);
    await expect(
      vault.withDerivedSecrets([onThrow], async () => {
        throw new Error('signing blew up');
      }),
    ).rejects.toThrow(/signing blew up/);
    expect(Array.from(onThrow)).toEqual(zeros(16));

    vault.lock();
    await expect(vault.withDerivedSecrets([new Uint8Array(8)], async () => 'x')).rejects.toThrow(/locked/i);
  });

  test('a lock landing inside any scoped callback zeroes its copy and voids its result', async () => {
    const { vault } = await openVault([seeded, bunker]);
    await vault.setImportedPqKeys('acct_seed', pqKeys, 'nip-pqc/v1');
    const cases: Array<[string, (release: Promise<void>) => Promise<unknown>, () => Uint8Array[]]> = [];
    const copies: Uint8Array[] = [];
    cases.push([
      'withMnemonic',
      (gate) => vault.withMnemonic('acct_seed', async (phrase) => { copies.push(phrase); await gate; return 'phrase'; }),
      () => copies,
    ]);
    cases.push([
      'withImportedPqKeys',
      (gate) => vault.withImportedPqKeys('acct_seed', async (keys) => { copies.push(keys.kemSecret, keys.dsaSecret); await gate; return 'pq'; }),
      () => copies,
    ]);
    cases.push([
      'withCacheKey',
      (gate) => vault.withCacheKey(async (key) => { copies.push(key); await gate; return 'cache'; }),
      () => copies,
    ]);
    cases.push([
      'withRemoteSignerCredentials',
      (gate) => vault.withRemoteSignerCredentials('acct_bunker', async (creds) => { copies.push(creds.secret!); await gate; return 'creds'; }),
      () => copies,
    ]);
    cases.push([
      'withDerivedSecrets',
      (gate) => {
        // A secret the vault never stored: what a caller derived from a mnemonic it does hold.
        const derived = [new Uint8Array(32).fill(7), new Uint8Array(64).fill(9)];
        return vault.withDerivedSecrets(derived, async () => { copies.push(...derived); await gate; return 'derived'; });
      },
      () => copies,
    ]);
    for (const [name, run, held] of cases) {
      copies.length = 0;
      await vault.unlock('hunter22');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = run(gate);
      await flush();
      vault.lock();
      for (const copy of held()) expect(Array.from(copy), `${name} copy zeroed by lock`).toEqual(zeros(copy.length));
      release();
      await expect(pending, `${name} result voided`).rejects.toThrow(/session/i);
    }
  });
});

describe('getAccountById', () => {
  test('returns the public metadata only, with readOnly computed, and the public NIP-46 half', async () => {
    const { vault } = await openVault([account, seeded, bunker]);
    const local = await vault.getAccountById('acct_seed');
    expect(local).toEqual({
      id: 'acct_seed',
      name: 'Seed',
      type: 'generated',
      pubkey: seeded.pubkey,
      readOnly: false,
      createdAt: 1,
      derivationIndex: 0,
      derivationPath: "m/44'/1237'/0'/0/0",
    });
    const remote = await vault.getAccountById('acct_bunker');
    expect(remote).toEqual({
      id: 'acct_bunker',
      name: 'Bunker',
      type: 'nip46',
      pubkey: bunker.pubkey,
      readOnly: true,
      createdAt: 1,
      nip46: { bunkerPubkey: '12'.repeat(32), relay: 'wss://relay.example' },
    });
    expect(JSON.stringify(remote)).not.toContain('topsecret');
    expect(await vault.getAccountById('acct_nope')).toBeNull();
    vault.lock();
    expect(await vault.getAccountById('acct_1')).toBeNull();
  });
});
