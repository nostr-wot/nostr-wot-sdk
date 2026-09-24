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
  type UnlockPort,
} from '../src/index.js';

// ── Fixtures ──

const PRIVKEY_1 = 'cd'.repeat(32);
const PUBKEY_1 = getPublicKey(hexToBytes(PRIVKEY_1));
const PRIVKEY_2 = '11'.repeat(32);
const PUBKEY_2 = getPublicKey(hexToBytes(PRIVKEY_2));
const PASSWORD = 'correct horse battery staple';

function account(id: string, privkey: string | null, extra: Partial<Account> = {}): Account {
  return {
    id,
    name: id,
    type: privkey ? 'generated' : 'npub',
    pubkey: privkey ? getPublicKey(hexToBytes(privkey)) : PUBKEY_2,
    privkey,
    mnemonic: null,
    nip46Config: null,
    readOnly: !privkey,
    createdAt: 1,
    ...extra,
  };
}

/** Real PBKDF2, scaled so the suite is fast; the work factor is not under test here. */
const fastKdf: Pbkdf2Port = {
  derive: (password, salt, iterations) =>
    noblePbkdf2.derive(password, salt, Math.max(1, Math.round(iterations / 100_000))),
};

type Mode = boolean | 'never';

interface RecordingApproval extends ApprovalPort {
  presented: Array<{ request: SignerRequest; account: SafeAccount }>;
  cancelled: Array<{ id: string; reason: string }>;
  /** Replaceable per test, for a prompt that does something before it answers. */
  decide: (request: SignerRequest, account: SafeAccount) => Promise<ApprovalDecision>;
}

function recordingApproval(mode: Mode): RecordingApproval {
  const port: RecordingApproval = {
    presented: [],
    cancelled: [],
    decide: async () => {
      if (mode === 'never') return new Promise<ApprovalDecision>(() => {});
      return { allow: mode };
    },
    async present(request, account) {
      port.presented.push({ request, account });
      return port.decide(request, account);
    },
    cancel(id, reason) {
      port.cancelled.push({ id, reason });
    },
  };
  return port;
}

interface RecordingActivity extends ActivityPort {
  entries: ActivityEntry[];
}

function recordingActivity(): RecordingActivity {
  const port: RecordingActivity = {
    entries: [],
    async record(entry) {
      port.entries.push(entry);
    },
  };
  return port;
}

interface FixtureOptions {
  accounts?: Account[];
  locked?: boolean;
  unlock?: UnlockPort;
  identity?: IdentityPort;
  remote?: RemoteSignerPort;
  logger?: SignerLogger;
}

const cores: SignerCore[] = [];
afterEach(() => {
  for (const core of cores.splice(0)) core.dispose();
  vi.useRealTimers();
});

/**
 * The host's source of truth for the active account, as the extension keeps one outside the
 * vault: follows the vault while it is open, and still answers while it is locked.
 */
function vaultIdentity(vault: Vault, accounts: Account[]): IdentityPort & { active: string } {
  const port = {
    active: accounts[0]!.id,
    async getActiveAccount() {
      const id = vault.isLocked() ? port.active : await vault.getActiveAccountId();
      const found = accounts.find((candidate) => candidate.id === id);
      return found ? toSafeAccount({ ...found, readOnly: found.readOnly || !found.privkey }) : null;
    },
  };
  return port;
}

async function fixture(approve: Mode, options: FixtureOptions = {}) {
  const vault = new Vault({ store: new MemoryStore(), kdf: fastKdf });
  const accounts = options.accounts ?? [account('acct_1', PRIVKEY_1)];
  await vault.create(PASSWORD, accounts);
  if (options.locked) vault.lock();
  const permissions = new Permissions(new MemoryStore());
  const approval = recordingApproval(approve);
  const activity = recordingActivity();
  const identity = options.identity ?? vaultIdentity(vault, accounts);
  const core = new SignerCore({
    vault,
    permissions,
    approval,
    activity,
    identity,
    unlock: options.unlock,
    remote: options.remote,
    logger: options.logger,
  });
  cores.push(core);
  return { core, vault, permissions, approval, activity, accounts, identity };
}

let counter = 0;

/**
 * A request from `example.com` with a fresh id. For `signEvent` the params are the event
 * template, with `content` and `tags` defaulted so `req('signEvent', { kind: 1 })` is complete.
 */
function req(method: SignerMethod, params: Record<string, unknown> = {}): SignerRequest {
  const wrapped = method === 'signEvent' ? { event: { content: '', tags: [], ...params } } : params;
  return {
    id: `req_${++counter}`,
    origin: { kind: 'web', identifier: 'example.com' },
    method,
    params: wrapped,
    receivedAt: Date.now(),
  };
}

/** Lets the pipeline run up to its first await on the host, without a real clock. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
    expect(approval.cancelled).toEqual([{ id: request.id, reason: expect.stringMatching(/timed out/i) }]);
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
    expect(approval.cancelled).toEqual([{ id: request.id, reason: 'Account switched' }]);
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
    // prompt and re-checked before execution, then flips. Nothing awaits between that last
    // re-check and the answer, so the only way to see acct_2 here is to ask the port again at
    // execution time instead of answering from the snapshot the user approved.
    const one = account('acct_1', PRIVKEY_1);
    const two = account('acct_2', PRIVKEY_2);
    let calls = 0;
    const identity: IdentityPort = {
      async getActiveAccount() {
        calls += 1;
        return toSafeAccount(calls <= 3 ? one : two);
      },
    };
    const { core, approval } = await fixture(true, { accounts: [one, two], identity });
    expect(await core.handle(req('getPublicKey'))).toBe(PUBKEY_1);
    expect(approval.presented[0]!.account.pubkey).toBe(PUBKEY_1);
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
    expect(approval.cancelled).toEqual([{ id: request.id, reason: 'Cancelled by user' }]);
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
