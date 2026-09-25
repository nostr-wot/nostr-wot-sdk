/**
 * The pipeline, end to end: a real `Vault`, real `Permissions`, the real `PrivateKeySigner`,
 * and only the ports a host supplies replaced by recorders.
 *
 * The vault is created over a scaled PBKDF2 port, exactly as the vault's own suite does: the
 * work factor is not what any test here is about, and every test builds a fresh vault.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { getPublicKey, verifyEvent, type Event } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { Account, SafeAccount } from '@nostr-wot/accounts';
import { toSafeAccount } from '@nostr-wot/accounts';
import { MemoryStore } from '@nostr-wot/storage';
import { Vault, noblePbkdf2, type Pbkdf2Port } from '@nostr-wot/vault';
import { Permissions } from '@nostr-wot/permissions';
import { PrivateKeySigner } from '@nostr-wot/signers';
import {
  SignerCore,
  SignerError,
  MAX_PENDING_PER_ORIGIN,
  REQUEST_TIMEOUT_MS,
  GET_PUBLIC_KEY_COOLDOWN_MS,
  type ActivityEntry,
  type ActivityPort,
  type ApprovalDecision,
  type ApprovalPort,
  type IdentityPort,
  type RemoteSignerPort,
  type SignerLogger,
  type SignerMethod,
  type SignerRequest,
  type SignerBatchRequest,
  type SignerBatchItem,
  type UnlockPort,
} from '../src/index.js';

import {
  PRIVKEY_1,
  PUBKEY_1,
  PRIVKEY_2,
  PUBKEY_2,
  PASSWORD,
  account,
  fastKdf,
  Mode,
  RecordingApproval,
  recordingApproval,
  RecordingActivity,
  recordingActivity,
  FixtureOptions,
  cores,
  vaultIdentity,
  fixture,
  req,
  settle,
  nextId,
} from './harness.js';

// ── One clock ──

describe('the vault\'s clock is the pipeline\'s clock', () => {
  test('activity timestamps, created_at and queue stamps all read the vault\'s now', async () => {
    const now = 1_700_000_000_000;
    const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf, now: () => now });
    const accounts = [account('acct_1', PRIVKEY_1)];
    await vault.create(PASSWORD, accounts);
    const approval = recordingApproval(true);
    const activity = recordingActivity();
    const core = new SignerCore({
      vault,
      permissions: new Permissions(new MemoryStore()),
      approval,
      activity,
      identity: vaultIdentity(vault, accounts),
    });
    cores.push(core);
    let stamped: number | undefined;
    approval.decide = async () => {
      stamped = core.pending()[0]?.queuedAt;
      return { allow: true };
    };
    const event = (await core.handle(req('signEvent', { kind: 1 }))) as Event;
    expect(event.created_at).toBe(Math.floor(now / 1000));
    expect(activity.entries[0]!.timestamp).toBe(now);
    expect(stamped).toBe(now);
  });
});

// ── The thinnest points, named by the whole-branch review ──

describe('an oversized origin never reaches the activity log', () => {
  test('a huge displayName, icon or id is refused at the boundary and nothing is recorded', async () => {
    const { core, activity, approval } = await fixture(true);
    const big = 'a'.repeat(1024 * 1024);
    for (const request of [
      { ...req('getPublicKey'), id: big },
      { ...req('getPublicKey'), origin: { kind: 'web' as const, identifier: 'example.com', displayName: big } },
      { ...req('getPublicKey'), origin: { kind: 'web' as const, identifier: 'example.com', icon: big } },
    ]) {
      await expect(core.handle(request)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(activity.entries).toHaveLength(0);
    expect(approval.presented).toHaveLength(0);
  });
});

describe('a lock landing inside the signing step', () => {
  test('between the last identity check and withPrivkey: vault_locked, and no result', async () => {
    // The identity port is the last thing awaited before the key is read. A lock that lands
    // during that await leaves the pipeline with a resolved account and no key.
    let target!: { vault: Vault; inner: IdentityPort };
    let calls = 0;
    const identity: IdentityPort = {
      async getActiveAccount() {
        const answer = await target.inner.getActiveAccount();
        calls += 1;
        if (calls === 3) target.vault.lock(); // 1: resolve; 2: after approval; 3: before execute
        return answer;
      },
    };
    const { core, vault, accounts, activity } = await fixture(true, { identity });
    target = { vault, inner: vaultIdentity(vault, accounts) };
    const spy = vi.spyOn(vault, 'withPrivkey');
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toMatchObject({ code: 'vault_locked' });
    expect(calls).toBe(3);
    expect(vault.isLocked()).toBe(true);
    // withPrivkey was reached on a locked vault and refused; nothing was computed.
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(spy.mock.results[0]!.value).rejects.toThrow(/locked/i);
    expect(activity.entries.at(-1)).toMatchObject({ decision: 'deny', code: 'vault_locked' });
  });

  test('after the callback computed and before withPrivkey returned: vault_locked, and the signature is void', async () => {
    // Tested in the vault alone until now, never through the pipeline. The signing step has
    // finished with the real key and produced a perfectly valid event; the lock lands in the
    // window before withPrivkey hands it back. That event must not reach the caller.
    const { core, vault, activity } = await fixture(true);
    const original = vault.withPrivkey.bind(vault);
    let computed: Event | undefined;
    vi.spyOn(vault, 'withPrivkey').mockImplementation((accountId, fn) =>
      original(accountId, async (key) => {
        const result = (await fn(key)) as Event;
        computed = result;
        vault.lock();
        return result;
      }),
    );
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toMatchObject({ code: 'vault_locked' });
    // The callback really did produce a publishable signature by the right key; the
    // rejection above is the whole property.
    expect(computed?.pubkey).toBe(PUBKEY_1);
    expect(verifyEvent(computed!)).toBe(true);
    expect(activity.entries.at(-1)).toMatchObject({ decision: 'deny', code: 'vault_locked' });
  });
});

describe('a switch landing inside the signing step', () => {
  test('a request is not answered once the user has moved on, even after execute', async () => {
    // The extension asserts the account session after cryptoSignEvent too (signer.ts:184).
    // Without the post-execute check, a switch inside withPrivkey lets the event, signed by
    // the account the user was shown, be handed back and logged as allowed.
    const one = account('acct_1', PRIVKEY_1);
    const two = account('acct_2', PRIVKEY_2);
    const { core, vault, activity } = await fixture(true, { accounts: [one, two] });
    const original = vault.withPrivkey.bind(vault);
    let computed: Event | undefined;
    vi.spyOn(vault, 'withPrivkey').mockImplementation((accountId, fn) =>
      original(accountId, async (key) => {
        const result = (await fn(key)) as Event;
        computed = result;
        await vault.setActiveAccountId('acct_2');
        return result;
      }),
    );
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toMatchObject({ code: 'account_switched' });
    expect(computed?.pubkey).toBe(PUBKEY_1);
    expect(verifyEvent(computed!)).toBe(true);
    expect(activity.entries.at(-1)).toMatchObject({ decision: 'deny', code: 'account_switched' });
  });

  test('the same holds for getPublicKey answered from the port', async () => {
    const one = account('acct_1', PRIVKEY_1);
    const two = account('acct_2', PRIVKEY_2);
    // The switch lands during the pre-execute check itself (the port's third call: resolve,
    // post-approval, pre-execute), after that check has read acct_1. Only the post-execute
    // check can see it; without it acct_1's pubkey is handed out after the switch.
    let target!: { vault: Vault; inner: IdentityPort };
    let calls = 0;
    const identity: IdentityPort = {
      async getActiveAccount() {
        calls += 1;
        const answer = await target.inner.getActiveAccount();
        if (calls === 3) await target.vault.setActiveAccountId('acct_2');
        return answer;
      },
    };
    const { core, vault } = await fixture(true, { accounts: [one, two], identity });
    target = { vault, inner: vaultIdentity(vault, [one, two]) };
    await expect(core.handle(req('getPublicKey'))).rejects.toMatchObject({ code: 'account_switched' });
    expect(calls).toBe(4);
  });
});

describe('the identity port and the vault agree', () => {
  test('the fixture\'s port names the account the vault holds active, with the pubkey of that key', async () => {
    // The test double itself has to be honest, or every test above proves less than it says.
    const { vault, identity } = await fixture(true);
    const shown = (await identity.getActiveAccount())!;
    expect(shown.id).toBe(await vault.getActiveAccountId());
    const derived = await vault.withPrivkey(shown.id, async (key) => getPublicKey(key));
    expect(shown.pubkey).toBe(derived);
  });

  test('a port whose pubkey is not the key the vault holds under that id is refused, and nothing is signed', async () => {
    // The port is the host's. If it says acct_1 is PUBKEY_2 while the vault's acct_1 key is
    // PRIVKEY_1, the user approved as one identity and the signature would be another's.
    // Nothing else in the chain compares the two; this is where it has to happen.
    const one = account('acct_1', PRIVKEY_1);
    const lying: IdentityPort = {
      async getActiveAccount() {
        return toSafeAccount({ ...one, pubkey: PUBKEY_2 });
      },
    };
    const { core, approval, activity } = await fixture(true, { accounts: [one], identity: lying });
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toMatchObject({ code: 'author_mismatch' });
    // The prompt showed PUBKEY_2; that is what the user agreed to, and it was a lie.
    expect(approval.presented[0]!.account.pubkey).toBe(PUBKEY_2);
    expect(activity.entries.at(-1)).toMatchObject({ decision: 'deny', code: 'author_mismatch' });
    // getPublicKey answers from the port and never touches the key, so it is not covered by
    // this guard; the honest half of that is that it cannot produce a signature either.
    for (const method of ['nip04Encrypt', 'nip44Encrypt'] as const) {
      await expect(core.handle(req(method, { pubkey: PUBKEY_2, plaintext: 'x' }))).rejects.toMatchObject({
        code: 'author_mismatch',
      });
    }
  });
});

// ── The order of the pipeline ──

describe('permissions come before everything', () => {
  test('a denied permission is refused even when the vault is unlocked', async () => {
    const { core, permissions, approval, vault } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'deny', 'acct_1');
    expect(vault.isLocked()).toBe(false);
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/denied/i);
    expect(approval.presented).toHaveLength(0);
    expect(approval.cancelled).toHaveLength(0);
  });

  test('a deny stored for an origin holds for every spelling of it', async () => {
    const { core, permissions, approval } = await fixture(true);
    await permissions.save('https://example.com', 'signEvent', 1, 'deny', 'acct_1');
    for (const identifier of ['https://EXAMPLE.COM', 'https://example.com:443', 'HTTPS://Example.Com:0443']) {
      const request = { ...req('signEvent', { kind: 1 }), origin: { kind: 'web' as const, identifier } };
      await expect(core.handle(request)).rejects.toThrow(/denied/i);
    }
    expect(approval.presented).toHaveLength(0);
  });

  test('a remembered refusal for every kind survives a permissions migration', async () => {
    // `rememberKind: false` persists the bare `signEvent` key, which the migrations used to
    // list as a retired blanket key and delete. This branch is what starts persisting denies.
    const { core, permissions, approval } = await fixture(false);
    approval.decide = async () => ({ allow: false, remember: true, rememberKind: false });
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/rejected/i);
    expect(approval.presented).toHaveLength(1);

    await permissions.migrate();
    for (const kind of [1, 7, 30023]) {
      await expect(core.handle(req('signEvent', { kind }))).rejects.toThrow(/denied/i);
    }
    expect(approval.presented).toHaveLength(1);
  });

  test('a deny is refused before the vault is consulted', async () => {
    const { core, permissions, vault } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'deny', 'acct_1');
    const spy = vi.spyOn(vault, 'withPrivkey');
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/denied/i);
    expect(spy).not.toHaveBeenCalled();
  });

  test('a deny is never routed to a remote signer', async () => {
    const remote = { calls: 0, async execute() { remote.calls += 1; return 'x'; } };
    const { core, permissions, approval } = await fixture(true, {
      accounts: [account('acct_1', null, { type: 'nip46', readOnly: false })],
      remote,
    });
    await permissions.save('example.com', 'signEvent', 1, 'deny', 'acct_1');
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/denied/i);
    expect(remote.calls).toBe(0);
    expect(approval.presented).toHaveLength(0);
  });

  test('a deny wins over a getPublicKey cooldown earned earlier', async () => {
    const { core, permissions, approval } = await fixture(true);
    expect(await core.handle(req('getPublicKey'))).toBe(PUBKEY_1);
    expect(approval.presented).toHaveLength(1);
    await permissions.save('example.com', 'getPublicKey', null, 'deny', 'acct_1');
    await expect(core.handle(req('getPublicKey'))).rejects.toThrow(/denied/i);
    expect(approval.presented).toHaveLength(1);
  });

  test('a deny holds while the vault is locked, and permissions are consulted before the lock', async () => {
    const { core, permissions, approval } = await fixture(true, { locked: true });
    await permissions.save('example.com', 'signEvent', 1, 'deny', 'acct_1');
    const check = vi.spyOn(permissions, 'check');
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(approval.presented).toHaveLength(0);
  });

  test('a deny for a read-only account is a deny, not a hint about the account', async () => {
    const { core, permissions } = await fixture(true, { accounts: [account('acct_ro', null)] });
    await permissions.save('example.com', 'signEvent', 1, 'deny', 'acct_1');
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/denied/i);
  });

  test('a deny for example.com holds for EXAMPLE.COM', async () => {
    const { core, permissions, approval } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'deny', 'acct_1');
    const shouting = { ...req('signEvent', { kind: 1 }), origin: { kind: 'web' as const, identifier: 'EXAMPLE.COM' } };
    await expect(core.handle(shouting)).rejects.toThrow(/denied/i);
    expect(approval.presented).toHaveLength(0);
  });

  test('a deny for example.com holds for example.com. with a trailing dot', async () => {
    const { core, permissions, approval } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'deny', 'acct_1');
    const dotted = { ...req('signEvent', { kind: 1 }), origin: { kind: 'web' as const, identifier: 'example.com.' } };
    await expect(core.handle(dotted)).rejects.toThrow(/denied/i);
    expect(approval.presented).toHaveLength(0);
  });

  test('a browser origin is accepted, and http and https are different keys', async () => {
    const { core, permissions, approval } = await fixture(true);
    await permissions.save('https://example.com', 'signEvent', 1, 'allow', 'acct_1');
    const secure = { ...req('signEvent', { kind: 1 }), origin: { kind: 'web' as const, identifier: 'https://example.com' } };
    await core.handle(secure);
    expect(approval.presented).toHaveLength(0);
    const plain = { ...req('signEvent', { kind: 1 }), origin: { kind: 'web' as const, identifier: 'http://example.com' } };
    await core.handle(plain);
    expect(approval.presented).toHaveLength(1);
    expect(approval.presented[0]!.request.origin.identifier).toBe('http://example.com');
  });

  test('an exact-origin deny is consulted for the origin form', async () => {
    const { core, permissions, approval } = await fixture(true);
    await permissions.save('https://example.com', 'signEvent', 1, 'deny', 'acct_1');
    const secure = { ...req('signEvent', { kind: 1 }), origin: { kind: 'web' as const, identifier: 'https://example.com' } };
    await expect(core.handle(secure)).rejects.toThrow(/denied/i);
    expect(approval.presented).toHaveLength(0);
  });

  test('the origin form also reads the legacy hostname rule, and the bare form reads only itself, as siteScopes intends', async () => {
    const { core, permissions, approval } = await fixture(true);
    // Legacy: stored under the bare hostname. The origin form still sees it.
    await permissions.save('example.com', 'signEvent', 1, 'deny', 'acct_1');
    const secure = { ...req('signEvent', { kind: 1 }), origin: { kind: 'web' as const, identifier: 'https://example.com' } };
    await expect(core.handle(secure)).rejects.toThrow(/denied/i);
    // Exact: stored under the origin. The bare form is its own scope and does not see it.
    await permissions.clear('example.com', 'acct_1');
    await permissions.save('https://example.com', 'signEvent', 7, 'deny', 'acct_1');
    await core.handle(req('signEvent', { kind: 7 }));
    expect(approval.presented).toHaveLength(1);
    const dotted = { ...req('signEvent', { kind: 7 }), origin: { kind: 'web' as const, identifier: 'https://example.com' } };
    await expect(core.handle(dotted)).rejects.toThrow(/denied/i);
  });

  test('a request whose id throws when read is a SignerError, never a raw error', async () => {
    const { core } = await fixture(true);
    const booby = {
      ...req('getPublicKey'),
      get id(): string {
        throw new Error('caller-controlled text');
      },
    };
    let outcome: unknown;
    try {
      await core.handle(booby as SignerRequest);
    } catch (error) {
      outcome = error;
    }
    expect(outcome).toBeInstanceOf(SignerError);
    expect(outcome).toMatchObject({ code: 'invalid_request' });
    expect((outcome as Error).message).not.toContain('caller-controlled');
  });

  test('a web caller cannot spell another transport\'s namespace to borrow its grant', async () => {
    const { core, permissions, approval } = await fixture(true);
    await permissions.save('nip55:com.evil.app', 'signEvent', 1, 'allow', 'acct_1');
    const forged = { ...req('signEvent', { kind: 1 }), origin: { kind: 'web' as const, identifier: 'nip55:com.evil.app' } };
    await expect(core.handle(forged)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(approval.presented).toHaveLength(0);
  });

  test('a grant to a hostname is not a grant to the Android package spelled the same', async () => {
    const { core, permissions, approval } = await fixture(true);
    await permissions.save('com.example.app', 'signEvent', 1, 'allow', 'acct_1');
    const web = { ...req('signEvent', { kind: 1 }), origin: { kind: 'web' as const, identifier: 'com.example.app' } };
    await core.handle(web);
    expect(approval.presented).toHaveLength(0);
    const android = { ...req('signEvent', { kind: 1 }), origin: { kind: 'nip55' as const, identifier: 'com.example.app' } };
    await core.handle(android);
    expect(approval.presented).toHaveLength(1);
    expect(await permissions.check('nip55:com.example.app', 'signEvent', 1, 'acct_1')).toBe('ask');
  });

  test('a wildcard deny blocks a kind that was allowed', async () => {
    const { core, permissions } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    await permissions.saveDirect('example.com', '*', 'deny', 'acct_1');
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/denied/i);
  });
});

describe('allow and ask', () => {
  test('an allowed permission signs without asking', async () => {
    const { core, permissions, approval } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    const signed = (await core.handle(req('signEvent', { kind: 1, content: 'hi' }))) as Event;
    expect(approval.presented).toHaveLength(0);
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(signed.pubkey).toBe(PUBKEY_1);
    expect(signed.content).toBe('hi');
    expect(verifyEvent(signed)).toBe(true);
  });

  test('an unset permission asks, and an approval signs', async () => {
    const { core, approval } = await fixture(true);
    const signed = (await core.handle(req('signEvent', { kind: 1 }))) as Event;
    expect(approval.presented).toHaveLength(1);
    expect(approval.presented[0]!.request.method).toBe('signEvent');
    expect(approval.presented[0]!.account.id).toBe('acct_1');
    expect(approval.presented[0]!.account).not.toHaveProperty('privkey');
    expect(verifyEvent(signed)).toBe(true);
  });

  test('an unset permission asks, and a refusal is an error not a null', async () => {
    const { core, approval } = await fixture(false);
    let outcome: unknown = 'unset';
    try {
      outcome = await core.handle(req('signEvent', { kind: 1 }));
    } catch (error) {
      outcome = error;
    }
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/rejected/i);
    expect(approval.presented).toHaveLength(1);
  });

  test('a refusal carries the reason the host gave', async () => {
    const { core, approval } = await fixture(false);
    approval.decide = async () => ({ allow: false, reason: 'Nope, said the user' });
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow('Nope, said the user');
  });

  test('an allowed request is refused if the account switches during the permission check', async () => {
    const two = [account('acct_1', PRIVKEY_1), account('acct_2', PRIVKEY_2)];
    const { core, permissions, vault } = await fixture(true, { accounts: two });
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    const original = permissions.check.bind(permissions);
    vi.spyOn(permissions, 'check').mockImplementation(async (...args) => {
      const decision = await original(...args);
      await vault.setActiveAccountId('acct_2');
      return decision;
    });
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toMatchObject({
      code: 'account_switched',
    });
  });

  test('a read-only account is refused before anyone is asked', async () => {
    const { core, approval } = await fixture(true, { accounts: [account('acct_ro', null)] });
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/signing key/i);
    expect(approval.presented).toHaveLength(0);
  });

  test('an event authored by another key is refused', async () => {
    const { core, permissions } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    await expect(core.handle(req('signEvent', { kind: 1, pubkey: PUBKEY_2 }))).rejects.toThrow(
      /author/i,
    );
  });
});

// ── The queue ──

describe('the approval queue', () => {
  test('an origin cannot queue more than the cap', async () => {
    const { core, approval } = await fixture('never');
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < MAX_PENDING_PER_ORIGIN; i++) {
      pending.push(core.handle(req('signEvent', { kind: 1 })));
    }
    for (const promise of pending) promise.catch(() => {});
    await settle();
    expect(approval.presented).toHaveLength(MAX_PENDING_PER_ORIGIN);
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/too many/i);
    expect(approval.presented).toHaveLength(MAX_PENDING_PER_ORIGIN);
  });

  test('the cap is per origin', async () => {
    const { core } = await fixture('never');
    for (let i = 0; i < MAX_PENDING_PER_ORIGIN; i++) {
      core.handle(req('signEvent', { kind: 1 })).catch(() => {});
    }
    await settle();
    const other: SignerRequest = {
      ...req('signEvent', { kind: 1 }),
      origin: { kind: 'web', identifier: 'other.example' },
    };
    const promise = core.handle(other);
    promise.catch(() => {});
    await settle();
    expect(core.pending().filter((entry) => entry.origin === 'other.example')).toHaveLength(1);
  });

  test('unlock markers do not count toward the cap', async () => {
    const unlock: UnlockPort = { requestUnlock: () => new Promise(() => {}) };
    const { core, permissions } = await fixture('never', { locked: true, unlock });
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    for (let i = 0; i < MAX_PENDING_PER_ORIGIN + 2; i++) {
      core.handle(req('signEvent', { kind: 1 })).catch(() => {});
    }
    await settle();
    const markers = core.pending().filter((entry) => entry.kind === 'unlock');
    expect(markers).toHaveLength(MAX_PENDING_PER_ORIGIN + 2);
    // And the approval cap is still intact underneath them.
    const promise = core.handle(req('signEvent', { kind: 7 }));
    promise.catch(() => {});
    await settle();
    expect(core.pending().filter((entry) => entry.kind === 'approval')).toHaveLength(1);
  });

  test('cancel names the origin, so two clients sharing a request id never withdraw each other\'s prompt', async () => {
    // The queue keys entries by origin, kind and id; a NIP-46 request id is chosen by the
    // client, so two connected clients using the same id is trivially arranged. The host has
    // to be able to match what the queue matched, or a timeout for one client's request
    // drops the other client's prompt.
    vi.useFakeTimers();
    const { core, approval } = await fixture('never');
    const first = { ...req('getPublicKey'), id: 'shared-id', origin: { kind: 'web' as const, identifier: 'https://one.example' } };
    const second = { ...req('getPublicKey'), id: 'shared-id', origin: { kind: 'web' as const, identifier: 'https://two.example' } };
    // Settled into values at creation: the rejections land inside the timer advances, before
    // a later `.rejects` could attach, and an unhandled one fails the run without failing a test.
    const firstOutcome = core.handle(first).then(() => 'resolved', (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    const secondOutcome = core.handle(second).then(() => 'resolved', (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1000);
    expect(await firstOutcome).toMatchObject({ code: 'timeout' });
    expect(approval.cancelled).toEqual([{ origin: 'https://one.example', id: 'shared-id', reason: expect.stringMatching(/timed out/i) }]);
    expect(core.pending().map((entry) => entry.origin)).toEqual(['https://two.example']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await secondOutcome).toMatchObject({ code: 'timeout' });
    expect(approval.cancelled[1]).toEqual({ origin: 'https://two.example', id: 'shared-id', reason: expect.stringMatching(/timed out/i) });
  });

  test('a request nobody answers times out and the prompt is cancelled', async () => {
    vi.useFakeTimers();
    const { core, approval } = await fixture('never');
    const request = req('signEvent', { kind: 1 });
    const promise = core.handle(request);
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(approval.cancelled).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).rejects.toThrow(/timed out/i);
    expect(approval.cancelled).toEqual([{ origin: 'example.com', id: request.id, reason: expect.stringMatching(/timed out/i) }]);
    expect(core.pending()).toHaveLength(0);
  });

  test('an answered request leaves the queue', async () => {
    const { core } = await fixture(true);
    await core.handle(req('signEvent', { kind: 1 }));
    expect(core.pending()).toHaveLength(0);
  });
});

// ── Switching accounts ──

describe('switching accounts', () => {
  test('switching account rejects everything queued for the previous one', async () => {
    const { core, approval } = await fixture('never');
    const request = req('signEvent', { kind: 1 });
    const inflight = core.handle(request);
    inflight.catch(() => {});
    await settle();
    await core.onActiveAccountChanged('acct_1', 'acct_2');
    await expect(inflight).rejects.toThrow(/account switched/i);
    expect(approval.cancelled).toEqual([{ origin: 'example.com', id: request.id, reason: 'Account switched' }]);
  });

  test('a request queued for another account is left alone', async () => {
    const { core } = await fixture('never');
    const inflight = core.handle(req('signEvent', { kind: 1 }));
    inflight.catch(() => {});
    await settle();
    await core.onActiveAccountChanged('acct_9', 'acct_2');
    expect(core.pending()).toHaveLength(1);
  });

  test('switching clears the getPublicKey cooldown', async () => {
    const { core, approval } = await fixture(true);
    await core.handle(req('getPublicKey'));
    await core.handle(req('getPublicKey'));
    expect(approval.presented).toHaveLength(1);
    await core.onActiveAccountChanged('acct_1', 'acct_2');
    await core.handle(req('getPublicKey'));
    expect(approval.presented).toHaveLength(2);
  });

  test('the getPublicKey cooldown expires on its own', async () => {
    vi.useFakeTimers();
    const { core, approval } = await fixture(true);
    await core.handle(req('getPublicKey'));
    await vi.advanceTimersByTimeAsync(GET_PUBLIC_KEY_COOLDOWN_MS - 1);
    await core.handle(req('getPublicKey'));
    expect(approval.presented).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await core.handle(req('getPublicKey'));
    expect(approval.presented).toHaveLength(2);
  });

  test('getPublicKey snapshots the identity at queue time and refuses to answer for another', async () => {
    const two = [account('acct_1', PRIVKEY_1), account('acct_2', PRIVKEY_2)];
    const { core, approval, vault } = await fixture(true, { accounts: two });
    approval.decide = async () => {
      await vault.setActiveAccountId('acct_2');
      return { allow: true };
    };
    let outcome: unknown;
    try {
      outcome = await core.handle(req('getPublicKey'));
    } catch (error) {
      outcome = error;
    }
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/account switched/i);
    expect(approval.presented[0]!.account.pubkey).toBe(PUBKEY_1);
  });

  test('getPublicKey answers the pubkey the user was shown, never a later one', async () => {
    // The identity port names acct_1 while the request is resolved, re-checked after the
    // prompt, re-checked before execution and re-checked after it. A port that flips only
    // after all four reads never touches the answer, which is the snapshot the user approved;
    // a port that flips at the fourth read is a switch inside the execute window, and the
    // answer is refused rather than being either account's pubkey.
    const one = account('acct_1', PRIVKEY_1);
    const two = account('acct_2', PRIVKEY_2);
    const flippingAfter = (reads: number): IdentityPort => {
      let calls = 0;
      return {
        async getActiveAccount() {
          calls += 1;
          return toSafeAccount(calls <= reads ? one : two);
        },
      };
    };
    const steady = await fixture(true, { accounts: [one, two], identity: flippingAfter(4) });
    expect(await steady.core.handle(req('getPublicKey'))).toBe(PUBKEY_1);
    expect(steady.approval.presented[0]!.account.pubkey).toBe(PUBKEY_1);

    const late = await fixture(true, { accounts: [one, two], identity: flippingAfter(3) });
    await expect(late.core.handle(req('getPublicKey'))).rejects.toMatchObject({ code: 'account_switched' });
  });

  test('a cooldown earned by one account never answers for another, even when the host forgets to notify the switch', async () => {
    const two = [account('acct_1', PRIVKEY_1), account('acct_2', PRIVKEY_2)];
    const { core, approval, vault } = await fixture(true, { accounts: two });
    expect(await core.handle(req('getPublicKey'))).toBe(PUBKEY_1);
    expect(approval.presented).toHaveLength(1);
    // The host switches the vault's active account and does NOT call onActiveAccountChanged.
    await vault.setActiveAccountId('acct_2');
    expect(await core.handle(req('getPublicKey'))).toBe(PUBKEY_2);
    expect(approval.presented).toHaveLength(2);
    expect(approval.presented[1]!.account.pubkey).toBe(PUBKEY_2);
  });

  test('signEvent refuses to sign with an account other than the one shown', async () => {
    const two = [account('acct_1', PRIVKEY_1), account('acct_2', PRIVKEY_2)];
    const { core, approval, vault } = await fixture(true, { accounts: two });
    approval.decide = async () => {
      await vault.setActiveAccountId('acct_2');
      return { allow: true };
    };
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/account switched/i);
  });
});

// ── What the user sees is what gets signed ──

describe('the approval snapshot', () => {
  test('signEvent prompts carry the full content and every tag', async () => {
    const { core, approval } = await fixture(true);
    const content = 'x'.repeat(200_000);
    const tags = Array.from({ length: 3_000 }, (_, i) => ['t', `tag-${i}`, 'wss://relay.example', 'extra']);
    const signed = (await core.handle(req('signEvent', { kind: 30023, content, tags }))) as Event;
    const shown = approval.presented[0]!.request.params as { event: { content: string; tags: string[][] } };
    expect(shown.event.content).toBe(content);
    expect(shown.event.content).toHaveLength(200_000);
    expect(shown.event.tags).toEqual(tags);
    expect(shown.event.tags).toHaveLength(3_000);
    expect(signed.content).toBe(content);
    expect(signed.tags).toEqual(tags);
  });

  test('a caller mutating its template after the prompt does not change what is signed', async () => {
    const { core, approval } = await fixture(true);
    const request = req('signEvent', { kind: 1, content: 'shown', tags: [['t', 'shown']] });
    const template = (request.params as { event: { content: string; tags: string[][] } }).event;
    approval.decide = async () => {
      template.content = 'hidden';
      template.tags.push(['p', PUBKEY_2]);
      return { allow: true };
    };
    const signed = (await core.handle(request)) as Event;
    expect(signed.content).toBe('shown');
    expect(signed.tags).toEqual([['t', 'shown']]);
    const shown = approval.presented[0]!.request.params as { event: { content: string } };
    expect(shown.event.content).toBe('shown');
  });

  test('the presented request is frozen', async () => {
    const { core, approval } = await fixture(true);
    await core.handle(req('signEvent', { kind: 1, content: 'a' }));
    const shown = approval.presented[0]!.request;
    expect(Object.isFrozen(shown)).toBe(true);
    expect(Object.isFrozen(shown.params)).toBe(true);
    expect(Object.isFrozen((shown.params as { event: unknown }).event)).toBe(true);
  });
});

// ── Remembering ──

describe('remember', () => {
  test('remember persists an allow for the event kind', async () => {
    const { core, approval, permissions } = await fixture(true);
    approval.decide = async () => ({ allow: true, remember: true });
    await core.handle(req('signEvent', { kind: 1 }));
    expect(await permissions.check('example.com', 'signEvent', 1, 'acct_1')).toBe('allow');
    expect(await permissions.check('example.com', 'signEvent', 7, 'acct_1')).toBe('ask');
    await core.handle(req('signEvent', { kind: 1 }));
    expect(approval.presented).toHaveLength(1);
  });

  test('rememberKind false persists the allow for every kind of the method', async () => {
    const { core, approval, permissions } = await fixture(true);
    approval.decide = async () => ({ allow: true, remember: true, rememberKind: false });
    await core.handle(req('signEvent', { kind: 1 }));
    expect(await permissions.check('example.com', 'signEvent', 7, 'acct_1')).toBe('allow');
  });

  test('a remembered refusal persists a deny', async () => {
    const { core, approval, permissions } = await fixture(false);
    approval.decide = async () => ({ allow: false, remember: true });
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/rejected/i);
    expect(await permissions.check('example.com', 'signEvent', 1, 'acct_1')).toBe('deny');
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/denied/i);
    expect(approval.presented).toHaveLength(1);
  });

  test('remember on getPublicKey persists without a kind', async () => {
    const { core, approval, permissions } = await fixture(true);
    approval.decide = async () => ({ allow: true, remember: true });
    await core.handle(req('getPublicKey'));
    expect(await permissions.check('example.com', 'getPublicKey', undefined, 'acct_1')).toBe('allow');
  });
});

// ── Validation at the boundary ──

describe('malformed requests', () => {
  const cases: Array<[string, SignerRequest]> = [
    ['a string kind', req('signEvent', { kind: '1' })],
    ['a missing content', { ...req('signEvent'), params: { event: { kind: 1, tags: [] } } }],
    ['tags that are not an array', req('signEvent', { kind: 1, tags: 'nope' })],
    ['a tag that is not an array of strings', req('signEvent', { kind: 1, tags: [['t', 1]] })],
    ['an uppercase pubkey', req('nip44Encrypt', { pubkey: PUBKEY_2.toUpperCase(), plaintext: 'x' })],
    ['a short pubkey', req('nip44Encrypt', { pubkey: PUBKEY_2.slice(1), plaintext: 'x' })],
    ['a missing plaintext', req('nip04Encrypt', { pubkey: PUBKEY_2 })],
    ['a missing ciphertext', req('nip04Decrypt', { pubkey: PUBKEY_2 })],
    ['an unknown method', { ...req('getPublicKey'), method: 'nip07_steal' as SignerMethod }],
    ['an unknown origin kind', { ...req('getPublicKey'), origin: { kind: 'evil' as 'web', identifier: 'x' } }],
    ['an empty origin identifier', { ...req('getPublicKey'), origin: { kind: 'web', identifier: '' } }],
    ['an empty id', { ...req('getPublicKey'), id: '' }],
    ['an event author that is not hex', req('signEvent', { kind: 1, pubkey: 'not-hex' })],
  ];

  test.each(cases)('%s is rejected before it reaches the vault or the user', async (_, request) => {
    const { core, approval, vault, activity, permissions } = await fixture(true);
    await permissions.saveDirect('example.com', '*', 'allow', 'acct_1');
    const withPrivkey = vi.spyOn(vault, 'withPrivkey');
    const check = vi.spyOn(permissions, 'check');
    await expect(core.handle(request)).rejects.toThrow(SignerError);
    await expect(core.handle(request)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(withPrivkey).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(approval.presented).toHaveLength(0);
    expect(activity.entries).toHaveLength(0);
  });

  test('a request that is not an object is rejected', async () => {
    const { core } = await fixture(true);
    await expect(core.handle(null as unknown as SignerRequest)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

// ── Execution ──

describe('execution', () => {
  test('getPublicKey answers with the active pubkey', async () => {
    const { core, permissions } = await fixture(true);
    await permissions.save('example.com', 'getPublicKey', null, 'allow', 'acct_1');
    expect(await core.handle(req('getPublicKey'))).toBe(PUBKEY_1);
  });

  test('nip44 encrypts for the recipient and decrypts what they send', async () => {
    const { core, permissions } = await fixture(true);
    await permissions.saveDirect('example.com', '*', 'allow', 'acct_1');
    const other = new PrivateKeySigner(PRIVKEY_2);
    const ciphertext = (await core.handle(
      req('nip44Encrypt', { pubkey: PUBKEY_2, plaintext: 'to you' }),
    )) as string;
    expect(await other.nip44Decrypt(PUBKEY_1, ciphertext)).toBe('to you');
    const theirs = await other.nip44Encrypt(PUBKEY_1, 'to me');
    expect(await core.handle(req('nip44Decrypt', { pubkey: PUBKEY_2, ciphertext: theirs }))).toBe('to me');
  });

  test('nip04 encrypts for the recipient and decrypts what they send', async () => {
    const { core, permissions } = await fixture(true);
    await permissions.saveDirect('example.com', '*', 'allow', 'acct_1');
    const other = new PrivateKeySigner(PRIVKEY_2);
    const ciphertext = (await core.handle(
      req('nip04Encrypt', { pubkey: PUBKEY_2, plaintext: 'legacy' }),
    )) as string;
    expect(await other.nip04Decrypt(PUBKEY_1, ciphertext)).toBe('legacy');
    const theirs = await other.nip04Encrypt(PUBKEY_1, 'back');
    expect(await core.handle(req('nip04Decrypt', { pubkey: PUBKEY_2, ciphertext: theirs }))).toBe('back');
  });

  test('getRelays answers empty without a relay port and is blocked by a deny', async () => {
    const { core, permissions, approval } = await fixture(true);
    expect(await core.handle(req('getRelays'))).toEqual({});
    expect(approval.presented).toHaveLength(0);
    await permissions.save('example.com', 'getRelays', null, 'deny', 'acct_1');
    await expect(core.handle(req('getRelays'))).rejects.toThrow(/denied/i);
  });

  test('a created_at is defaulted from the clock when the template has none', async () => {
    const { core, permissions } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    const before = Math.floor(Date.now() / 1000);
    const signed = (await core.handle(req('signEvent', { kind: 1 }))) as Event;
    expect(signed.created_at).toBeGreaterThanOrEqual(before);
    const pinned = (await core.handle(req('signEvent', { kind: 1, created_at: 1234 }))) as Event;
    expect(pinned.created_at).toBe(1234);
  });

  test('a remote account is executed through the remote port after the same gate', async () => {
    const remote = {
      calls: [] as Array<{ accountId: string; method: string }>,
      async execute(acct: SafeAccount, request: SignerRequest) {
        remote.calls.push({ accountId: acct.id, method: request.method });
        return 'remote-result';
      },
    };
    const { core, approval } = await fixture(true, {
      accounts: [account('acct_1', null, { type: 'nip46', readOnly: false })],
      remote,
    });
    // The bunker runs its own approval, so an unset permission does not prompt locally.
    expect(await core.handle(req('signEvent', { kind: 1 }))).toBe('remote-result');
    expect(approval.presented).toHaveLength(0);
    expect(remote.calls).toEqual([{ accountId: 'acct_1', method: 'signEvent' }]);
  });

  test('a remote account with no remote port is refused', async () => {
    const { core } = await fixture(true, {
      accounts: [account('acct_1', null, { type: 'nip46', readOnly: false })],
    });
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/remote/i);
  });
});

// ── Lock state ──

describe('the vault lock', () => {
  test('a locked vault with no unlock port refuses after the permission gate', async () => {
    const { core, permissions } = await fixture(true, { locked: true });
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/locked/i);
    await permissions.save('example.com', 'signEvent', 1, 'deny', 'acct_1');
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/denied/i);
  });

  test('getPublicKey answers from the identity port while the vault is locked', async () => {
    const { core, permissions } = await fixture(true, { locked: true });
    await permissions.save('example.com', 'getPublicKey', null, 'allow', 'acct_1');
    expect(await core.handle(req('getPublicKey'))).toBe(PUBKEY_1);
  });

  test('an unlock port is asked, and signing proceeds once the vault opens', async () => {
    const asked: string[] = [];
    let vaultRef: Vault | null = null;
    const unlock: UnlockPort = {
      async requestUnlock(request) {
        asked.push(request.id);
        await vaultRef!.unlock(PASSWORD);
      },
    };
    const { core, permissions, vault } = await fixture(true, { locked: true, unlock });
    vaultRef = vault;
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    const request = req('signEvent', { kind: 1 });
    const signed = (await core.handle(request)) as Event;
    expect(asked).toEqual([request.id]);
    expect(verifyEvent(signed)).toBe(true);
    expect(core.pending()).toHaveLength(0);
  });

  test('an unlock the user cancels is an error to the caller, with the port\'s reason', async () => {
    const unlock: UnlockPort = {
      async requestUnlock() {
        throw new SignerError('rejected', 'Cancelled by user');
      },
    };
    const { core, permissions } = await fixture(true, { locked: true, unlock });
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toMatchObject({
      code: 'rejected',
      message: 'Cancelled by user',
    });
  });

  test('an unlock that does not actually open the vault is still locked', async () => {
    const unlock: UnlockPort = { async requestUnlock() {} };
    const { core, permissions } = await fixture(true, { locked: true, unlock });
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/locked/i);
  });
});

// ── Only fixed text leaves ──

describe('foreign errors', () => {
  const PATH = 'EACCES /Users/leon/Library/vault.db';

  test('an unlock port that throws raw text reaches the caller as fixed text', async () => {
    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const unlock: UnlockPort = {
      async requestUnlock() {
        throw new Error(PATH);
      },
    };
    const { core, permissions, activity } = await fixture(true, {
      locked: true,
      unlock,
      logger: { warn: (message, context) => warnings.push({ message, context }) },
    });
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    let outcome: unknown;
    try {
      await core.handle(req('signEvent', { kind: 1 }));
    } catch (error) {
      outcome = error;
    }
    expect(outcome).toBeInstanceOf(SignerError);
    expect(outcome).toMatchObject({ code: 'internal', message: 'Internal signer error', wireVisible: true });
    expect(String((outcome as Error).message)).not.toContain('EACCES');
    expect(JSON.stringify(warnings)).toContain(PATH);
    expect(activity.entries[0]!.reason).toContain(PATH);
    expect(activity.entries[0]!.code).toBe('internal');
  });

  test('a failing permissions store reaches the caller as fixed text', async () => {
    const { core, permissions, approval } = await fixture(true);
    vi.spyOn(permissions, 'check').mockRejectedValue(
      new Error('IndexedDB quota exceeded at /private/var/mobile/Containers/x'),
    );
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toMatchObject({
      code: 'internal',
      message: 'Internal signer error',
    });
    expect(approval.presented).toHaveLength(0);
  });

  test('a cipher failure reaches the caller as a fixed-text operation failure', async () => {
    const { core, permissions } = await fixture(true);
    await permissions.saveDirect('example.com', '*', 'allow', 'acct_1');
    for (const method of ['nip04Decrypt', 'nip44Decrypt'] as const) {
      await expect(core.handle(req(method, { pubkey: PUBKEY_2, ciphertext: 'garbage?iv=abc' }))).rejects.toMatchObject({
        code: 'operation_failed',
        message: 'Operation failed',
      });
    }
  });

  test('a remote port that throws raw text reaches the caller as fixed text', async () => {
    const remote: RemoteSignerPort = {
      async execute() {
        throw new RangeError('offset is out of bounds');
      },
    };
    const { core } = await fixture(true, {
      accounts: [account('acct_1', null, { type: 'nip46', readOnly: false })],
      remote,
    });
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toMatchObject({
      code: 'operation_failed',
      message: 'Operation failed',
    });
  });

  test('a failing activity port on the allow path still answers', async () => {
    const { core, permissions, activity } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    activity.record = async () => {
      throw new Error('disk full');
    };
    const signed = (await core.handle(req('signEvent', { kind: 1 }))) as Event;
    expect(verifyEvent(signed)).toBe(true);
  });
});

describe('host-side cancel', () => {
  test('cancel is scoped to the origin', async () => {
    const { core, approval } = await fixture('never');
    const request = req('signEvent', { kind: 1 });
    const inflight = core.handle(request);
    inflight.catch(() => {});
    await settle();
    expect(core.cancel('other.example', request.id)).toBe(false);
    expect(core.pending()).toHaveLength(1);
    expect(core.cancel('example.com', request.id)).toBe(true);
    await expect(inflight).rejects.toMatchObject({ code: 'rejected', message: 'Cancelled by user' });
    expect(approval.cancelled).toEqual([{ origin: 'example.com', id: request.id, reason: 'Cancelled by user' }]);
  });
});

// ── The activity log ──

describe('the activity log', () => {
  test('every handled request lands in the activity log with its origin', async () => {
    const { core, permissions, activity } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    await core.handle(req('signEvent', { kind: 1 }));
    expect(activity.entries).toHaveLength(1);
    expect(activity.entries[0]!.origin.identifier).toBe('example.com');
    expect(activity.entries[0]!.method).toBe('signEvent');
    expect(activity.entries[0]!.kind).toBe(1);
    expect(activity.entries[0]!.decision).toBe('allow');
    expect(activity.entries[0]!.accountId).toBe('acct_1');
    expect(activity.entries[0]!.pubkey).toBe(PUBKEY_1);
  });

  test('a denial is logged with its reason', async () => {
    const { core, permissions, activity } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'deny', 'acct_1');
    await core.handle(req('signEvent', { kind: 1 })).catch(() => {});
    expect(activity.entries).toHaveLength(1);
    expect(activity.entries[0]!.decision).toBe('deny');
    expect(activity.entries[0]!.reason).toMatch(/denied/i);
  });

  test('a refusal is logged as a deny', async () => {
    const { core, activity } = await fixture(false);
    await core.handle(req('signEvent', { kind: 1 })).catch(() => {});
    expect(activity.entries[0]!.decision).toBe('deny');
    expect(activity.entries[0]!.reason).toMatch(/rejected/i);
  });

  test('a decrypt entry keeps the ciphertext and never the plaintext', async () => {
    const { core, permissions, activity } = await fixture(true);
    await permissions.saveDirect('example.com', '*', 'allow', 'acct_1');
    const other = new PrivateKeySigner(PRIVKEY_2);
    const theirs = await other.nip44Encrypt(PUBKEY_1, 'the secret');
    await core.handle(req('nip44Decrypt', { pubkey: PUBKEY_2, ciphertext: theirs }));
    const entry = activity.entries[0]!;
    expect(entry.ciphertext).toBe(theirs);
    expect(entry.theirPubkey).toBe(PUBKEY_2);
    expect(JSON.stringify(entry)).not.toContain('the secret');
  });

  test('an encrypt entry never carries the plaintext', async () => {
    const { core, permissions, activity } = await fixture(true);
    await permissions.saveDirect('example.com', '*', 'allow', 'acct_1');
    await core.handle(req('nip44Encrypt', { pubkey: PUBKEY_2, plaintext: 'the secret' }));
    expect(JSON.stringify(activity.entries[0])).not.toContain('the secret');
  });

  test('a signEvent entry keeps the event that was signed', async () => {
    const { core, permissions, activity } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    await core.handle(req('signEvent', { kind: 1, content: 'logged', tags: [['t', 'x']] }));
    expect(activity.entries[0]!.event).toMatchObject({ kind: 1, content: 'logged', tags: [['t', 'x']] });
  });

  test('a failing activity port does not hold the response hostage, and is reported', async () => {
    const warnings: string[] = [];
    const { core, permissions, activity } = await fixture(true, {
      logger: { warn: (message) => warnings.push(message) },
    });
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    activity.record = async () => {
      throw new Error('disk full');
    };
    const signed = (await core.handle(req('signEvent', { kind: 1 }))) as Event;
    expect(verifyEvent(signed)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/activity/i);
  });
});

describe('disposal', () => {
  test('dispose rejects everything pending', async () => {
    const { core, approval } = await fixture('never');
    const inflight = core.handle(req('signEvent', { kind: 1 }));
    inflight.catch(() => {});
    await settle();
    core.dispose();
    await expect(inflight).rejects.toThrow(/shut down/i);
    expect(approval.cancelled).toHaveLength(1);
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toThrow(/shut down/i);
  });
});

// ── Batches: one request, one approval, many signatures ──

/** A batch from `example.com` with a fresh id; item ids default to `i0`, `i1`, ... */
function batchReq(items: Array<Partial<SignerBatchItem> & { method: SignerMethod }>): SignerBatchRequest {
  return {
    id: nextId('batch'),
    origin: { kind: 'web', identifier: 'example.com' },
    items: items.map((item, index) => ({ id: item.id ?? `i${index}`, method: item.method, params: item.params ?? {} })),
    receivedAt: Date.now(),
  };
}

/** A `signEvent` item; content and tags defaulted so `sign(7)` is complete. */
function sign(kind: number, template: Record<string, unknown> = {}): { method: SignerMethod; params: Record<string, unknown> } {
  return { method: 'signEvent', params: { event: { content: `kind ${kind}`, tags: [['k', String(kind)]], ...template, kind } } };
}

describe('a batch is one approval for every item', () => {
  test('one prompt shows every item, full content and every tag, and one approval signs them all', async () => {
    const { core, approval, activity } = await fixture(true);
    const long = 'x'.repeat(50_000);
    const tags = Array.from({ length: 300 }, (_, i) => ['p', PUBKEY_2, `relay${i}`]);
    const batch = batchReq([sign(1, { content: long }), sign(7, { tags }), sign(1059, { tags: [['p', PUBKEY_2]] })]);
    const result = await core.handleBatch(batch);
    expect(approval.presented).toHaveLength(0);
    expect(approval.presentedBatches).toHaveLength(1);
    const shown = approval.presentedBatches[0]!.batch;
    // Every item, the whole content, every tag, frozen: the prompt renders what is signed.
    expect(shown.items.map((item) => item.id)).toEqual(['i0', 'i1', 'i2']);
    expect((shown.items[0]!.params['event'] as { content: string }).content).toBe(long);
    expect((shown.items[1]!.params['event'] as { tags: string[][] }).tags).toEqual(tags);
    expect(Object.isFrozen(shown)).toBe(true);
    expect(Object.isFrozen((shown.items[1]!.params['event'] as { tags: string[][] }).tags[299])).toBe(true);
    expect(approval.presentedBatches[0]!.account.id).toBe('acct_1');
    expect(result.id).toBe(batch.id);
    expect(result.items.map((item) => item.id)).toEqual(['i0', 'i1', 'i2']);
    for (const [index, outcome] of result.items.entries()) {
      expect(outcome.ok).toBe(true);
      const signed = (outcome as { result: Event }).result;
      expect(verifyEvent(signed)).toBe(true);
      expect(signed.pubkey).toBe(PUBKEY_1);
      expect(signed.kind).toBe([1, 7, 1059][index]);
    }
    expect((result.items[1] as { result: Event }).result.tags).toEqual(tags);
    expect(activity.entries).toHaveLength(3);
    expect(activity.entries.map((entry) => [entry.requestId, entry.batchId, entry.decision, entry.kind])).toEqual([
      ['i0', batch.id, 'allow', 1],
      ['i1', batch.id, 'allow', 7],
      ['i2', batch.id, 'allow', 1059],
    ]);
  });

  test('a caller mutating its templates after the prompt does not change what is signed', async () => {
    const { core, approval } = await fixture(true);
    const batch = batchReq([sign(1, { content: 'shown' }), sign(7, { content: 'also shown' })]);
    approval.decideBatch = async () => {
      for (const item of batch.items) (item.params['event'] as { content: string }).content = 'swapped';
      (batch.items as SignerBatchItem[]).push({ id: 'late', method: 'signEvent', params: { event: { kind: 1, content: 'smuggled', tags: [] } } });
      return { allow: true };
    };
    const result = await core.handleBatch(batch);
    expect(result.items.map((item) => (item as { result: Event }).result.content)).toEqual(['shown', 'also shown']);
  });

  test('a refusal refuses every item, and every item is logged as denied', async () => {
    const { core, approval, activity } = await fixture(false);
    approval.decideBatch = async () => ({ allow: false, reason: 'Not today' });
    const batch = batchReq([sign(1), sign(7)]);
    await expect(core.handleBatch(batch)).rejects.toMatchObject({ code: 'rejected', message: 'Not today' });
    expect(activity.entries.map((entry) => [entry.requestId, entry.decision, entry.code, entry.reason])).toEqual([
      ['i0', 'deny', 'rejected', 'Not today'],
      ['i1', 'deny', 'rejected', 'Not today'],
    ]);
  });

  test('a batch nobody answers times out, and the prompt is cancelled under the batch id', async () => {
    vi.useFakeTimers();
    const { core, approval } = await fixture('never');
    const batch = batchReq([sign(1), sign(7)]);
    const outcome = core.handleBatch(batch).then(() => 'resolved', (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await outcome).toMatchObject({ code: 'timeout' });
    expect(approval.cancelled).toEqual([{ origin: 'example.com', id: batch.id, reason: expect.stringMatching(/timed out/i) }]);
    expect(core.pending()).toHaveLength(0);
  });

  test('a disposed core refuses a batch', async () => {
    const { core } = await fixture(true);
    core.dispose();
    await expect(core.handleBatch(batchReq([sign(1)]))).rejects.toMatchObject({ code: 'shutdown' });
  });
});

describe('the permission cascade applies per item', () => {
  test('every item\'s rule is consulted, and one denied item refuses the batch before any prompt', async () => {
    const { core, approval, activity, permissions, vault } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    await permissions.save('example.com', 'signEvent', 7, 'deny', 'acct_1');
    const check = vi.spyOn(permissions, 'check');
    const withPrivkey = vi.spyOn(vault, 'withPrivkey');
    const batch = batchReq([sign(1), sign(7), sign(1059)]);
    await expect(core.handleBatch(batch)).rejects.toMatchObject({ code: 'permission_denied' });
    // A deny is the end: the rule after it is not consulted, as for a single request.
    expect(check.mock.calls.map((call) => call[2])).toEqual([1, 7]);
    expect(approval.presentedBatches).toHaveLength(0);
    expect(withPrivkey).not.toHaveBeenCalled();
    // Nothing was signed, and the log says so for every item, the allowed one included.
    expect(activity.entries.map((entry) => [entry.requestId, entry.decision, entry.code])).toEqual([
      ['i0', 'deny', 'permission_denied'],
      ['i1', 'deny', 'permission_denied'],
      ['i2', 'deny', 'permission_denied'],
    ]);
  });

  test('a deny holds while the vault is locked, before the lock is consulted', async () => {
    const { core, permissions } = await fixture(true, { locked: true });
    await permissions.save('example.com', 'signEvent', 7, 'deny', 'acct_1');
    await expect(core.handleBatch(batchReq([sign(1), sign(7)]))).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('items already allowed are still shown; the prompt decides the batch, not only the asked items', async () => {
    const { core, approval, permissions } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    const result = await core.handleBatch(batchReq([sign(1), sign(1059)]));
    expect(approval.presentedBatches).toHaveLength(1);
    expect(approval.presentedBatches[0]!.batch.items.map((item) => item.id)).toEqual(['i0', 'i1']);
    expect(result.items.every((item) => item.ok)).toBe(true);
  });

  test('a batch of only allowed items signs without a prompt', async () => {
    const { core, approval, permissions } = await fixture('never');
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    await permissions.save('example.com', 'signEvent', 7, 'allow', 'acct_1');
    const result = await core.handleBatch(batchReq([sign(1), sign(7), sign(1)]));
    expect(approval.presentedBatches).toHaveLength(0);
    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => item.ok)).toBe(true);
  });

  test('a repeated kind consults the store once', async () => {
    const { core, permissions } = await fixture(true);
    const check = vi.spyOn(permissions, 'check');
    await core.handleBatch(batchReq([sign(7), sign(7), sign(7), sign(1)]));
    expect(check.mock.calls.map((call) => call[2])).toEqual([7, 1]);
  });

  test('remember persists the decision for each kind that was asked, and only those', async () => {
    const { core, approval, permissions } = await fixture(true);
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    const save = vi.spyOn(permissions, 'save');
    approval.decideBatch = async () => ({ allow: true, remember: true });
    await core.handleBatch(batchReq([sign(1), sign(7), sign(1059), sign(7)]));
    expect(save.mock.calls.map((call) => [call[1], call[2], call[3]])).toEqual([
      ['signEvent', 7, 'allow'],
      ['signEvent', 1059, 'allow'],
    ]);
    expect(await permissions.check('example.com', 'signEvent', 7, 'acct_1')).toBe('allow');
    expect(await permissions.check('example.com', 'signEvent', 1059, 'acct_1')).toBe('allow');
    // 1059 and 4 share the `sendMessages` rule in @nostr-wot/permissions; 30023 shares nothing.
    expect(await permissions.check('example.com', 'signEvent', 30023, 'acct_1')).toBe('ask');
    await core.handleBatch(batchReq([sign(1), sign(7), sign(1059)]));
    expect(approval.presentedBatches).toHaveLength(1);
  });

  test('a remembered refusal persists a deny for each kind that was asked', async () => {
    const { core, approval, permissions } = await fixture(false);
    approval.decideBatch = async () => ({ allow: false, remember: true });
    await expect(core.handleBatch(batchReq([sign(1), sign(7)]))).rejects.toMatchObject({ code: 'rejected' });
    expect(await permissions.check('example.com', 'signEvent', 1, 'acct_1')).toBe('deny');
    expect(await permissions.check('example.com', 'signEvent', 7, 'acct_1')).toBe('deny');
    await expect(core.handleBatch(batchReq([sign(7)]))).rejects.toMatchObject({ code: 'permission_denied' });
    expect(approval.presentedBatches).toHaveLength(1);
  });

  test('rememberKind false persists the method for every kind, once', async () => {
    const { core, approval, permissions } = await fixture(true);
    const save = vi.spyOn(permissions, 'save');
    approval.decideBatch = async () => ({ allow: true, remember: true, rememberKind: false });
    await core.handleBatch(batchReq([sign(1), sign(7), { method: 'nip44Encrypt', params: { pubkey: PUBKEY_2, plaintext: 'x' } }]));
    expect(save.mock.calls.map((call) => [call[1], call[2], call[3]])).toEqual([
      ['signEvent', null, 'allow'],
      ['nip44Encrypt', null, 'allow'],
    ]);
    expect(await permissions.check('example.com', 'signEvent', 30023, 'acct_1')).toBe('allow');
  });

  test('an item authored by another key refuses the batch before anyone is asked', async () => {
    const { core, approval } = await fixture(true);
    const batch = batchReq([sign(1), sign(7, { pubkey: PUBKEY_2 })]);
    await expect(core.handleBatch(batch)).rejects.toMatchObject({ code: 'author_mismatch' });
    expect(approval.presentedBatches).toHaveLength(0);
  });

  test('a read-only account is refused before anyone is asked', async () => {
    const { core, approval } = await fixture(true, { accounts: [account('ro', null)] });
    await expect(core.handleBatch(batchReq([sign(1)]))).rejects.toMatchObject({ code: 'unsupported' });
    expect(approval.presentedBatches).toHaveLength(0);
  });

  test('a remote account cannot batch: the remote port takes one request and the bunker approves each', async () => {
    const execute = vi.fn(async () => 'never');
    const remote: RemoteSignerPort = { execute };
    const acct = account('bunker', null, { type: 'nip46', pubkey: PUBKEY_2, readOnly: false });
    const { core, approval } = await fixture(true, { accounts: [acct], remote });
    // The message, not only the code: the fixture's identity port reports a keyless account as
    // read-only, and that gate answers `unsupported` too. This one has to be the remote gate.
    // `expect.stringMatching`, not a bare RegExp: `toMatchObject` does not apply a RegExp to a
    // string property, and the bare form passed against 'This account has no signing key'.
    await expect(core.handleBatch(batchReq([sign(1)]))).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringMatching(/remote/i),
    });
    expect(execute).not.toHaveBeenCalled();
    expect(approval.presentedBatches).toHaveLength(0);
  });

  test('a host that cannot show a batch is refused when a prompt is needed, and signs under remembered rules without one', async () => {
    const { core, approval, permissions, activity } = await fixture(true);
    delete (approval as Partial<ApprovalPort>).presentBatch;
    await expect(core.handleBatch(batchReq([sign(1)]))).rejects.toMatchObject({ code: 'unsupported' });
    expect(activity.entries.at(-1)).toMatchObject({ decision: 'deny', code: 'unsupported' });
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    const result = await core.handleBatch(batchReq([sign(1), sign(1)]));
    expect(result.items.every((item) => item.ok)).toBe(true);
  });
});

describe('partial failure inside a batch', () => {
  test('eight of ten sign, the vault locks: eight are returned and two are reported locked, by id', async () => {
    const { core, vault, activity } = await fixture(true);
    const original = vault.withPrivkey.bind(vault);
    let calls = 0;
    vi.spyOn(vault, 'withPrivkey').mockImplementation((accountId, fn) =>
      original(accountId, async (key) => {
        const result = await fn(key);
        // The ninth item has been computed with the real key; the lock lands before the
        // vault hands it back, so the vault voids it. The tenth finds the vault locked.
        if (++calls === 9) vault.lock();
        return result;
      }),
    );
    const batch = batchReq(Array.from({ length: 10 }, (_, i) => sign(7, { content: `item ${i}` })));
    const result = await core.handleBatch(batch);
    expect(result.items).toHaveLength(10);
    const ok = result.items.filter((item) => item.ok);
    expect(ok.map((item) => item.id)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7']);
    for (const item of ok) {
      const signed = (item as { result: Event }).result;
      expect(verifyEvent(signed)).toBe(true);
      expect(signed.pubkey).toBe(PUBKEY_1);
    }
    expect(result.items.slice(8)).toEqual([
      { id: 'i8', ok: false, code: 'vault_locked', message: 'Vault is locked' },
      { id: 'i9', ok: false, code: 'vault_locked', message: 'Vault is locked' },
    ]);
    expect(activity.entries.map((entry) => entry.decision)).toEqual([...Array<string>(8).fill('allow'), 'deny', 'deny']);
    expect(activity.entries[8]).toMatchObject({ requestId: 'i8', code: 'vault_locked', batchId: batch.id });
  });

  test('a cipher failure on one item is that item\'s failure, with fixed text, and the rest sign', async () => {
    const warn = vi.fn();
    const { core, activity } = await fixture(true, { logger: { warn } });
    const result = await core.handleBatch(
      batchReq([
        sign(1),
        { method: 'nip44Encrypt', params: { pubkey: PUBKEY_2, plaintext: 'secret' } },
        { method: 'nip04Decrypt', params: { pubkey: PUBKEY_2, ciphertext: 'not-a-ciphertext' } },
      ]),
    );
    expect(result.items[0]!.ok).toBe(true);
    expect(verifyEvent((result.items[0] as { result: Event }).result)).toBe(true);
    expect(result.items[1]!.ok).toBe(true);
    const recipient = new PrivateKeySigner(hexToBytes(PRIVKEY_2));
    expect(await recipient.nip44Decrypt(PUBKEY_1, (result.items[1] as { result: string }).result)).toBe('secret');
    expect(result.items[2]).toEqual({ id: 'i2', ok: false, code: 'operation_failed', message: 'Operation failed' });
    // The original text went to the logger and the on-device log, not to the caller.
    expect(warn).toHaveBeenCalledWith('request failed', expect.objectContaining({ requestId: 'i2', phase: 'execute' }));
    expect(activity.entries[2]).toMatchObject({ requestId: 'i2', decision: 'deny', code: 'operation_failed', theirPubkey: PUBKEY_2, ciphertext: 'not-a-ciphertext' });
    expect(activity.entries[2]!.reason).not.toBe('Operation failed');
    expect(activity.entries[1]).not.toHaveProperty('ciphertext');
  });

  test('a switch landing mid-batch refuses the whole batch, stops signing, and discards what was signed', async () => {
    // The account is checked between items, as the lock is: a switch at item 5 of 10 ends
    // the batch there. Items 6 to 10 are never signed (no cryptographic work with a key the
    // user has just moved away from), and items 1 to 5, signed by the right key, are
    // discarded rather than returned, because they answer a question the user is no
    // longer asking.
    const one = account('acct_1', PRIVKEY_1);
    const two = account('acct_2', PRIVKEY_2);
    const { core, vault, activity } = await fixture(true, { accounts: [one, two] });
    const original = vault.withPrivkey.bind(vault);
    const computed: Event[] = [];
    vi.spyOn(vault, 'withPrivkey').mockImplementation((accountId, fn) =>
      original(accountId, async (key) => {
        const result = (await fn(key)) as Event;
        computed.push(result);
        if (computed.length === 5) await vault.setActiveAccountId('acct_2');
        return result;
      }),
    );
    const batch = batchReq(Array.from({ length: 10 }, () => sign(7)));
    await expect(core.handleBatch(batch)).rejects.toMatchObject({ code: 'account_switched' });
    expect(computed).toHaveLength(5);
    expect(computed.every((event) => event.pubkey === PUBKEY_1 && verifyEvent(event))).toBe(true);
    expect(activity.entries).toHaveLength(10);
    expect(activity.entries.every((entry) => entry.decision === 'deny' && entry.code === 'account_switched')).toBe(true);
  });

  test('a lock then a reopen inside an item voids that item as vault_locked, and the items after it sign', async () => {
    // The item's failure is attributed by where the error came from, not by whether the
    // vault happens to be locked when the pipeline looks. The vault voided this result
    // because its session moved; that is the lock, whatever the vault's state now.
    const { core, vault, activity } = await fixture(true);
    const original = vault.withPrivkey.bind(vault);
    let calls = 0;
    vi.spyOn(vault, 'withPrivkey').mockImplementation((accountId, fn) =>
      original(accountId, async (key) => {
        const result = await fn(key);
        if (++calls === 5) {
          vault.lock();
          await vault.unlock(PASSWORD);
        }
        return result;
      }),
    );
    const result = await core.handleBatch(batchReq(Array.from({ length: 7 }, () => sign(7))));
    expect(vault.isLocked()).toBe(false);
    expect(result.items.map((item) => item.ok)).toEqual([true, true, true, true, false, true, true]);
    expect(result.items[4]).toEqual({ id: 'i4', ok: false, code: 'vault_locked', message: 'Vault is locked' });
    expect(activity.entries[4]).toMatchObject({ requestId: 'i4', code: 'vault_locked' });
  });

  test('a cipher failure followed by a lock is still a cipher failure', async () => {
    // The mirror image: the throw came from the signing step, and the lock landed after
    // it. Reported as what it was, so the activity log the user reads does not blame the
    // lock for an undecryptable message.
    const { core, vault, activity } = await fixture(true);
    const original = vault.withPrivkey.bind(vault);
    vi.spyOn(vault, 'withPrivkey').mockImplementation((accountId, fn) =>
      original(accountId, async (key) => {
        try {
          return await fn(key);
        } catch (error) {
          vault.lock();
          throw error;
        }
      }),
    );
    const result = await core.handleBatch(
      batchReq([{ method: 'nip04Decrypt', params: { pubkey: PUBKEY_2, ciphertext: 'not-a-ciphertext' } }, sign(1)]),
    );
    expect(vault.isLocked()).toBe(true);
    expect(result.items[0]).toEqual({ id: 'i0', ok: false, code: 'operation_failed', message: 'Operation failed' });
    expect(result.items[1]).toEqual({ id: 'i1', ok: false, code: 'vault_locked', message: 'Vault is locked' });
    expect(activity.entries[0]).toMatchObject({ code: 'operation_failed' });
  });

  test('a switch landing while the prompt is open refuses the batch, and nothing is remembered', async () => {
    const one = account('acct_1', PRIVKEY_1);
    const two = account('acct_2', PRIVKEY_2);
    const { core, vault, approval, permissions } = await fixture(true, { accounts: [one, two] });
    approval.decideBatch = async () => {
      await vault.setActiveAccountId('acct_2');
      return { allow: true, remember: true };
    };
    await expect(core.handleBatch(batchReq([sign(1), sign(7)]))).rejects.toMatchObject({ code: 'account_switched' });
    expect(await permissions.check('example.com', 'signEvent', 1, 'acct_1')).toBe('ask');
    expect(await permissions.check('example.com', 'signEvent', 1, 'acct_2')).toBe('ask');
  });
});

describe('a batch in the queue', () => {
  test('a queued batch is rejected when the account changes, and its prompt is cancelled by the batch id', async () => {
    const { core, approval } = await fixture('never');
    const batch = batchReq([sign(1), sign(7)]);
    const promise = core.handleBatch(batch);
    promise.catch(() => {});
    await settle();
    expect(core.pending()).toEqual([expect.objectContaining({ id: batch.id, kind: 'approval', origin: 'example.com', accountId: 'acct_1' })]);
    await core.onActiveAccountChanged('acct_1', 'acct_2');
    await expect(promise).rejects.toMatchObject({ code: 'account_switched' });
    expect(approval.cancelled).toEqual([{ origin: 'example.com', id: batch.id, reason: 'Account switched' }]);
    expect(core.pending()).toHaveLength(0);
  });

  test('a batch is one queued request: the per-origin cap counts prompts, not items', async () => {
    // The cap blunts prompt spam, and a batch is one prompt: the user's attention is spent
    // once whatever the item count, which is bounded on its own by MAX_BATCH_ITEMS and
    // MAX_BATCH_BYTES. Counting items would make the cap of five refuse a twelve-event
    // burst, the exact case batching exists for.
    const { core, approval } = await fixture('never');
    for (let i = 0; i < MAX_PENDING_PER_ORIGIN; i++) {
      core.handleBatch(batchReq([sign(1), sign(7), sign(1059)])).catch(() => {});
    }
    await settle();
    expect(approval.presentedBatches).toHaveLength(MAX_PENDING_PER_ORIGIN);
    expect(core.pending()).toHaveLength(MAX_PENDING_PER_ORIGIN);
    await expect(core.handle(req('signEvent', { kind: 1 }))).rejects.toMatchObject({ code: 'too_many_pending' });
    await expect(core.handleBatch(batchReq([sign(1)]))).rejects.toMatchObject({ code: 'too_many_pending' });
    expect(approval.presentedBatches).toHaveLength(MAX_PENDING_PER_ORIGIN);
  });

  test('host-side cancel settles a batch by its id, scoped to the origin', async () => {
    const { core } = await fixture('never');
    const batch = batchReq([sign(1)]);
    const promise = core.handleBatch(batch);
    promise.catch(() => {});
    await settle();
    expect(core.cancel('other.example', batch.id)).toBe(false);
    expect(core.cancel('example.com', batch.id)).toBe(true);
    await expect(promise).rejects.toMatchObject({ code: 'rejected' });
  });

  test('a locked vault asks the batch unlock port once, and signs every item once open', async () => {
    const asked: string[] = [];
    let vaultRef: Vault | null = null;
    const unlock: UnlockPort = {
      async requestUnlock() {
        throw new Error('the single-request port must not be asked for a batch');
      },
      async requestUnlockBatch(batch) {
        asked.push(batch.id);
        await vaultRef!.unlock(PASSWORD);
      },
    };
    const { core, permissions, vault } = await fixture(true, { locked: true, unlock });
    vaultRef = vault;
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    const batch = batchReq([sign(1), sign(1)]);
    const result = await core.handleBatch(batch);
    expect(asked).toEqual([batch.id]);
    expect(result.items.every((item) => item.ok)).toBe(true);
    expect(core.pending()).toHaveLength(0);
  });

  test('a locked vault and no batch unlock port is a locked vault, after the permission gate', async () => {
    // The single-request port takes a SignerRequest and would open the vault if asked. It is
    // not asked: a batch is not a request, and a host that never opted into batches must not
    // be handed one through a port typed for something else.
    let vaultRef: Vault | null = null;
    const askedSingle: unknown[] = [];
    const unlock: UnlockPort = {
      async requestUnlock(request) {
        askedSingle.push(request);
        await vaultRef!.unlock(PASSWORD);
      },
    };
    const { core, permissions, vault } = await fixture(true, { locked: true, unlock });
    vaultRef = vault;
    await permissions.save('example.com', 'signEvent', 1, 'allow', 'acct_1');
    await expect(core.handleBatch(batchReq([sign(1)]))).rejects.toMatchObject({ code: 'vault_locked' });
    expect(askedSingle).toEqual([]);
    expect(vault.isLocked()).toBe(true);
    await permissions.save('example.com', 'signEvent', 1, 'deny', 'acct_1');
    await expect(core.handleBatch(batchReq([sign(1)]))).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('a malformed batch never reaches the store, the vault, the prompt or the log', async () => {
    const { core, approval, vault, activity, permissions } = await fixture(true);
    const withPrivkey = vi.spyOn(vault, 'withPrivkey');
    const check = vi.spyOn(permissions, 'check');
    for (const batch of [
      batchReq([{ method: 'getPublicKey' }]),
      batchReq([]),
      batchReq([sign(1), { id: 'i0', method: 'signEvent', params: { event: { kind: 1, content: '', tags: [] } } }]),
      null as unknown as SignerBatchRequest,
    ]) {
      await expect(core.handleBatch(batch)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(withPrivkey).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(approval.presentedBatches).toHaveLength(0);
    expect(activity.entries).toHaveLength(0);
  });
});

// ── Revoking an origin ──

describe('revoking an origin', () => {
  test('clears its getPublicKey cooldown, so a revoked client that reconnects is prompted again', async () => {
    // The cooldown was cleared only by an account switch or disposal. A host that revokes a
    // remote client and sees it re-send `connect` inside the window admitted it with no
    // prompt at all; the host reimplemented the window against a shared clock to refuse it,
    // which is a window the pipeline owns and the two drift. Revocation now clears it here.
    const { core, approval } = await fixture(true);
    await core.handle(req('getPublicKey'));
    await core.handle(req('getPublicKey'));
    expect(approval.presented).toHaveLength(1);
    core.revokeOrigin('example.com');
    await core.handle(req('getPublicKey'));
    expect(approval.presented).toHaveLength(2);
  });

  test('leaves another origin\'s cooldown alone', async () => {
    const { core, approval } = await fixture(true);
    const other = { ...req('getPublicKey'), origin: { kind: 'web' as const, identifier: 'other.example' } };
    await core.handle(req('getPublicKey'));
    await core.handle(other);
    expect(approval.presented).toHaveLength(2);
    core.revokeOrigin('example.com');
    await core.handle({ ...other, id: 'other_again' });
    expect(approval.presented).toHaveLength(2);
  });

  test('rejects everything it has queued, single requests and batches, with the reason, and cancels their prompts', async () => {
    const { core, approval } = await fixture('never');
    const single = req('signEvent', { kind: 1 });
    const batch = batchReq([sign(1), sign(7)]);
    const other = { ...req('signEvent', { kind: 1 }), origin: { kind: 'web' as const, identifier: 'other.example' } };
    const a = core.handle(single);
    const b = core.handleBatch(batch);
    const c = core.handle(other);
    for (const promise of [a, b, c]) promise.catch(() => {});
    await settle();
    expect(core.pending()).toHaveLength(3);
    expect(core.revokeOrigin('example.com', 'Client revoked')).toBe(2);
    await expect(a).rejects.toMatchObject({ code: 'rejected', message: 'Client revoked' });
    await expect(b).rejects.toMatchObject({ code: 'rejected', message: 'Client revoked' });
    expect(approval.cancelled.map((entry) => entry.id).sort()).toEqual([single.id, batch.id].sort());
    expect(approval.cancelled.every((entry) => entry.origin === 'example.com' && entry.reason === 'Client revoked')).toBe(true);
    expect(core.pending().map((entry) => entry.origin)).toEqual(['other.example']);
    core.cancel('other.example', other.id);
    await expect(c).rejects.toMatchObject({ code: 'rejected' });
  });

  test('is keyed like everything else: a nip46 client is revoked by its permission key', async () => {
    const { core, approval } = await fixture(true);
    const client = { ...req('getPublicKey'), origin: { kind: 'nip46' as const, identifier: 'AB'.repeat(32) } };
    await core.handle(client);
    await core.handle({ ...client, id: 'again' });
    expect(approval.presented).toHaveLength(1);
    core.revokeOrigin(`nip46:${'ab'.repeat(32)}`);
    await core.handle({ ...client, id: 'after' });
    expect(approval.presented).toHaveLength(2);
  });

  test('clearCooldown forgets the auto-approve alone and touches nothing queued', async () => {
    const { core, approval } = await fixture(true);
    approval.decide = async (request) =>
      request.method === 'getPublicKey' ? { allow: true } : new Promise<ApprovalDecision>(() => {});
    await core.handle(req('getPublicKey'));
    const pending = core.handle(req('signEvent', { kind: 1 }));
    pending.catch(() => {});
    await settle();
    expect(core.pending()).toHaveLength(1);
    core.clearCooldown('example.com');
    expect(core.pending()).toHaveLength(1);
    expect(approval.cancelled).toHaveLength(0);
    await core.handle(req('getPublicKey'));
    expect(approval.presented.filter((entry) => entry.request.method === 'getPublicKey')).toHaveLength(2);
  });

  test('the argument is canonicalised as the boundary canonicalises an origin', async () => {
    // A host revokes by whatever spelling it holds. `EXAMPLE.COM.` is `example.com`, an
    // http(s) origin is folded the same way, and a nip46 client's hex is lowercased.
    const { core, approval } = await fixture(true);
    await core.handle(req('getPublicKey'));
    await core.handle(req('getPublicKey'));
    expect(approval.presented).toHaveLength(1);
    core.revokeOrigin('EXAMPLE.COM.');
    await core.handle(req('getPublicKey'));
    expect(approval.presented).toHaveLength(2);
    const client = { ...req('getPublicKey'), origin: { kind: 'nip46' as const, identifier: 'ab'.repeat(32) } };
    await core.handle(client);
    await core.handle({ ...client, id: 'again' });
    expect(approval.presented).toHaveLength(3);
    core.revokeOrigin(`nip46:${'AB'.repeat(32)}`);
    await core.handle({ ...client, id: 'after' });
    expect(approval.presented).toHaveLength(4);
  });

  test('one revocation covers every spelling of a site: the origin form and the bare hostname, both ways', async () => {
    // The cascade reads both forms for one site, so a host had to revoke both to revoke
    // one. Revocation is about the site, and every key that names its host is covered:
    // `example.com` revokes `https://example.com` and `http://example.com:8080`, and
    // `https://example.com` revokes `example.com`. Another host is untouched.
    const { core, approval } = await fixture('never');
    const at = (identifier: string) => ({ ...req('signEvent', { kind: 1 }), origin: { kind: 'web' as const, identifier } });
    const queued = [at('https://example.com'), at('http://example.com:8080'), at('example.com'), at('https://other.example')];
    const promises = queued.map((request) => core.handle(request));
    for (const promise of promises) promise.catch(() => {});
    await settle();
    expect(core.pending()).toHaveLength(4);
    expect(core.revokeOrigin('EXAMPLE.COM')).toBe(3);
    for (const promise of promises.slice(0, 3)) await expect(promise).rejects.toMatchObject({ code: 'rejected' });
    expect(core.pending().map((entry) => entry.origin)).toEqual(['https://other.example']);
    expect(approval.cancelled.map((entry) => entry.origin).sort()).toEqual(['example.com', 'http://example.com:8080', 'https://example.com']);

    // And the other way: cooldowns earned under the bare and the origin form, revoked by the origin form.
    const fresh = await fixture(true);
    await fresh.core.handle({ ...req('getPublicKey'), origin: { kind: 'web', identifier: 'example.com' } });
    await fresh.core.handle({ ...req('getPublicKey'), origin: { kind: 'web', identifier: 'https://example.com' } });
    await fresh.core.handle({ ...req('getPublicKey'), origin: { kind: 'web', identifier: 'https://other.example' } });
    expect(fresh.approval.presented).toHaveLength(3);
    fresh.core.revokeOrigin('https://example.com');
    await fresh.core.handle({ ...req('getPublicKey'), origin: { kind: 'web', identifier: 'example.com' } });
    await fresh.core.handle({ ...req('getPublicKey'), origin: { kind: 'web', identifier: 'https://example.com' } });
    await fresh.core.handle({ ...req('getPublicKey'), origin: { kind: 'web', identifier: 'https://other.example' } });
    expect(fresh.approval.presented).toHaveLength(5);
  });

  test('a revoke landing while an approved batch executes stops it between items, and nothing is returned', async () => {
    // Approval was given, but the host has cut the caller off since: no further signatures
    // are computed for it, and the ones already computed are discarded with the batch.
    const { core, vault, activity } = await fixture(true);
    const original = vault.withPrivkey.bind(vault);
    let calls = 0;
    vi.spyOn(vault, 'withPrivkey').mockImplementation((accountId, fn) =>
      original(accountId, async (key) => {
        const result = await fn(key);
        if (++calls === 3) core.revokeOrigin('example.com', 'Client revoked');
        return result;
      }),
    );
    await expect(core.handleBatch(batchReq(Array.from({ length: 10 }, () => sign(7))))).rejects.toMatchObject({
      code: 'rejected',
      message: 'Client revoked',
    });
    expect(calls).toBe(3);
    expect(activity.entries).toHaveLength(10);
    expect(activity.entries.every((entry) => entry.decision === 'deny' && entry.code === 'rejected')).toBe(true);
  });

  test('a revoked origin can be prompted again afterwards: revocation is not a deny', async () => {
    const { core, approval } = await fixture(true);
    core.revokeOrigin('example.com');
    const signed = (await core.handle(req('signEvent', { kind: 1 }))) as Event;
    expect(verifyEvent(signed)).toBe(true);
    expect(approval.presented).toHaveLength(1);
  });
});
