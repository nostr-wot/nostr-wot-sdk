/**
 * The rule about which members are synchronous, asserted as a rule.
 *
 * `Vault`'s account accessors were `async` and none of them awaited anything. That cost a
 * shipping consumer its migration outright: its own accessors are synchronous, its suite calls
 * them without `await` in 208 places, and no adapter can make an asynchronous method
 * synchronous. The async-ness was habit, not design — the accessors read `#payload`, which is in
 * memory by definition since it exists only while the vault is unlocked.
 *
 * The replacement is a rule rather than a set of individual judgements, because a rule is the
 * only thing that stops the next member from being written the wrong way:
 *
 *   - **A read over already-decrypted in-memory state is SYNCHRONOUS.**
 *   - **Anything that touches the injected `KeyValueStore` is ASYNCHRONOUS**, because the store
 *     is a port and a host's may be a network round trip. That async-ness is load-bearing.
 *   - A scoped accessor is asynchronous for its own reason: its callback is.
 *
 * This file pins both halves. The membership lists are the contract, so adding a member forces a
 * deliberate choice here rather than an accidental one at the call site — and the second half is
 * what keeps "make it synchronous" from being applied to something that genuinely has to read
 * the store, which would mean either a stale answer or a silently swallowed write.
 */
import { describe, test, expect } from 'vitest';
import type { Account } from '@nostr-wot/accounts';
import { MemoryStore } from '@nostr-wot/storage';
import { Vault } from '../src/vault.js';
import { noblePbkdf2, type Pbkdf2Port } from '../src/crypto.js';

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

async function open(): Promise<Vault> {
  const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
  await vault.create(PASSWORD, [account]);
  return vault;
}

/** Every member that reads already-decrypted state, with a call that exercises it. */
const SYNCHRONOUS: ReadonlyArray<[string, (vault: Vault) => unknown]> = [
  ['isLocked', (vault) => vault.isLocked()],
  ['getSessionRevision', (vault) => vault.getSessionRevision()],
  ['hasMnemonic', (vault) => vault.hasMnemonic('acct_1')],
  ['hasImportedPqKeys', (vault) => vault.hasImportedPqKeys('acct_1')],
  ['getActiveAccountId', (vault) => vault.getActiveAccountId()],
  ['getActivePubkey', (vault) => vault.getActivePubkey()],
  ['getActiveAccount', (vault) => vault.getActiveAccount()],
  ['getActiveAccountWithWallet', (vault) => vault.getActiveAccountWithWallet()],
  ['getAccountById', (vault) => vault.getAccountById('acct_1')],
  ['listAccounts', (vault) => vault.listAccounts()],
  ['getAccountForRemoteSigning', (vault) => vault.getAccountForRemoteSigning('acct_1')],
  ['getDecryptedPayload', (vault) => vault.getDecryptedPayload()],
  ['setAutoLockTimeout', (vault) => vault.setAutoLockTimeout(0)],
  ['lock', (vault) => vault.lock()],
];

/** Every member that reaches the store, or whose callback makes it asynchronous. */
const ASYNCHRONOUS: ReadonlyArray<[string, (vault: Vault) => unknown]> = [
  ['exists', (vault) => vault.exists()],
  ['unlock', (vault) => vault.unlock(PASSWORD)],
  ['create', (vault) => vault.create(PASSWORD, [account])],
  ['destroy', (vault) => vault.destroy()],
  ['changePassword', (vault) => vault.changePassword(PASSWORD, 'another password')],
  ['reEncrypt', (vault) => vault.reEncrypt('another password')],
  ['getAutoLockMs', (vault) => vault.getAutoLockMs()],
  ['setAutoLockMs', (vault) => vault.setAutoLockMs(0)],
  ['setActiveAccountId', (vault) => vault.setActiveAccountId('acct_1')],
  ['addAccount', (vault) => vault.addAccount({ ...account, id: 'acct_x' })],
  ['removeAccount', (vault) => vault.removeAccount('acct_1')],
  ['updateAccountWalletConfig', (vault) => vault.updateAccountWalletConfig('acct_1', null)],
  ['updateAccountNip46Keys', (vault) => vault.updateAccountNip46Keys('acct_1', new Uint8Array(32), 'ab')],
  ['setImportedPqKeys', (vault) =>
    vault.setImportedPqKeys(
      'acct_1',
      {
        kem: { publicKey: new Uint8Array(4), secretKey: new Uint8Array(4) },
        dsa: { publicKey: new Uint8Array(4), secretKey: new Uint8Array(4) },
      },
      'p',
    )],
  ['clearImportedPqKeys', (vault) => vault.clearImportedPqKeys('acct_1')],
  ['withPrivkey', (vault) => vault.withPrivkey('acct_1', async () => 1)],
  ['withMnemonic', (vault) => vault.withMnemonic('acct_1', async () => 1)],
  ['withCacheKey', (vault) => vault.withCacheKey(async () => 1)],
  ['withDerivedSecrets', (vault) => vault.withDerivedSecrets([], async () => 1)],
  ['withImportedPqKeys', (vault) => vault.withImportedPqKeys('acct_1', async () => 1)],
  ['withRemoteSignerCredentials', (vault) => vault.withRemoteSignerCredentials('acct_1', async () => 1)],
  ['requireUnlocked', (vault) => vault.requireUnlocked()],
  ['whenStartupUnlockSettled', (vault) => vault.whenStartupUnlockSettled()],
];

describe('the synchronous read path', () => {
  test.each(SYNCHRONOUS)('%s returns a value, not a promise', async (_name, call) => {
    const vault = await open();
    const result = call(vault);
    expect(result).not.toBeInstanceOf(Promise);
  });
});

describe('the asynchronous path, which is where the store is', () => {
  test.each(ASYNCHRONOUS)('%s returns a promise, because it reaches the store or a callback', async (_name, call) => {
    const vault = await open();
    const result = call(vault);
    expect(result).toBeInstanceOf(Promise);
    // Whatever it rejects with is another test's business; this one is about the shape.
    await (result as Promise<unknown>).catch(() => {});
  });
});

describe('the two lists are the whole public surface', () => {
  test('every public method is classified, so a new one cannot slip in unclassified', async () => {
    const vault = await open();
    const declared = new Set([...SYNCHRONOUS, ...ASYNCHRONOUS].map(([name]) => name));
    // The subscription registrars are synchronous by construction (they return an unsubscribe,
    // never a promise) and are covered by their own tests, so they are named rather than called.
    for (const name of ['onLock', 'onUnlock', 'onDestroy', 'onSessionInvalidated', 'beginStartupUnlock']) {
      declared.add(name);
    }
    const actual = Object.getOwnPropertyNames(Vault.prototype)
      .filter((name) => name !== 'constructor')
      .filter((name) => typeof (vault as unknown as Record<string, unknown>)[name] === 'function');
    expect(actual.filter((name) => !declared.has(name))).toEqual([]);
  });
});
