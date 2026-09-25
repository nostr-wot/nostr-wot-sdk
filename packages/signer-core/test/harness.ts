/**
 * The harness every signer-core suite runs on: a real `Vault`, real `Permissions`, the real
 * `PrivateKeySigner`, and only the ports a host supplies replaced by recorders.
 *
 * The vault is created over a scaled PBKDF2 port, exactly as the vault's own suite does: the
 * work factor is not what any test here is about, and every test builds a fresh vault.
 * Importing this module registers an `afterEach` that disposes every core built through
 * `fixture` and restores real timers.
 */
import { afterEach, vi } from 'vitest';
import { getPublicKey } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { Account, SafeAccount } from '@nostr-wot/accounts';
import { toSafeAccount } from '@nostr-wot/accounts';
import { MemoryStore } from '@nostr-wot/storage';
import { Vault, noblePbkdf2, type Pbkdf2Port } from '@nostr-wot/vault';
import { Permissions } from '@nostr-wot/permissions';
import {
  SignerCore,
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
  type UnlockPort,
} from '../src/index.js';

export const PRIVKEY_1 = 'cd'.repeat(32);
export const PUBKEY_1 = getPublicKey(hexToBytes(PRIVKEY_1));
export const PRIVKEY_2 = '11'.repeat(32);
export const PUBKEY_2 = getPublicKey(hexToBytes(PRIVKEY_2));
export const PASSWORD = 'correct horse battery staple';

export function account(id: string, privkey: string | null, extra: Partial<Account> = {}): Account {
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
export const fastKdf: Pbkdf2Port = {
  derive: (password, salt, iterations) =>
    noblePbkdf2.derive(password, salt, Math.max(1, Math.round(iterations / 100_000))),
};

export type Mode = boolean | 'never';

export interface RecordingApproval extends ApprovalPort {
  presented: Array<{ request: SignerRequest; account: SafeAccount }>;
  presentedBatches: Array<{ batch: SignerBatchRequest; account: SafeAccount }>;
  cancelled: Array<{ origin: string; id: string; reason: string }>;
  /** Replaceable per test, for a prompt that does something before it answers. */
  decide: (request: SignerRequest, account: SafeAccount) => Promise<ApprovalDecision>;
  decideBatch: (batch: SignerBatchRequest, account: SafeAccount) => Promise<ApprovalDecision>;
}

export function recordingApproval(mode: Mode): RecordingApproval {
  const answer = async (): Promise<ApprovalDecision> => {
    if (mode === 'never') return new Promise<ApprovalDecision>(() => {});
    return { allow: mode };
  };
  const port: RecordingApproval = {
    presented: [],
    presentedBatches: [],
    cancelled: [],
    decide: answer,
    decideBatch: answer,
    async present(request, account) {
      port.presented.push({ request, account });
      return port.decide(request, account);
    },
    async presentBatch(batch, account) {
      port.presentedBatches.push({ batch, account });
      return port.decideBatch(batch, account);
    },
    cancel(origin, id, reason) {
      port.cancelled.push({ origin, id, reason });
    },
  };
  return port;
}

export interface RecordingActivity extends ActivityPort {
  entries: ActivityEntry[];
}

export function recordingActivity(): RecordingActivity {
  const port: RecordingActivity = {
    entries: [],
    async record(entry) {
      port.entries.push(entry);
    },
  };
  return port;
}

export interface FixtureOptions {
  accounts?: Account[];
  locked?: boolean;
  unlock?: UnlockPort;
  identity?: IdentityPort;
  remote?: RemoteSignerPort;
  logger?: SignerLogger;
}

export const cores: SignerCore[] = [];
afterEach(() => {
  for (const core of cores.splice(0)) core.dispose();
  vi.useRealTimers();
});

/**
 * The host's source of truth for the active account, as the extension keeps one outside the
 * vault: follows the vault while it is open, and still answers while it is locked.
 */
export function vaultIdentity(vault: Vault, accounts: Account[]): IdentityPort & { active: string } {
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

export async function fixture(approve: Mode, options: FixtureOptions = {}) {
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

/** A fresh, process-unique id for a request or a batch built by hand. */
export const nextId = (prefix: string): string => `${prefix}_${++counter}`;

/**
 * A request from `example.com` with a fresh id. For `signEvent` the params are the event
 * template, with `content` and `tags` defaulted so `req('signEvent', { kind: 1 })` is complete.
 */
export function req(method: SignerMethod, params: Record<string, unknown> = {}): SignerRequest {
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
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

