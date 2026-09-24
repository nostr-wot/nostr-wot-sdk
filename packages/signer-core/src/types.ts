/**
 * The request contract and the ports.
 *
 * One request shape, whatever the wire: a NIP-46 `sign_event`, an Android intent, a LAN frame
 * and an in-app action all become a {@link SignerRequest} and traverse the same pipeline.
 * There is no path to a signature that does not start here.
 *
 * The ports are what a host supplies. Two are required, because the pipeline cannot function
 * without them: somewhere to put a prompt and somewhere to write what happened. The rest are
 * optional and each one unlocks a capability the host may not have.
 */
import type { SafeAccount } from '@nostr-wot/accounts';
import type { Permissions } from '@nostr-wot/permissions';
import type { Vault } from '@nostr-wot/vault';
import type { SignerErrorCode } from './errors.js';

// ── The request ──

/** The extension's NIP-07 method set, kept identical so the bridge is structural. */
export type SignerMethod =
  | 'getPublicKey'
  | 'signEvent'
  | 'getRelays'
  | 'nip04Encrypt'
  | 'nip04Decrypt'
  | 'nip44Encrypt'
  | 'nip44Decrypt';

/** Who is asking. */
export interface RequestOrigin {
  kind: 'web' | 'nip46' | 'nip55' | 'lan' | 'local';
  /** A hostname, a client pubkey, an Android package name, a paired device id. */
  identifier: string;
  displayName?: string;
  icon?: string;
}

/**
 * One request, from any transport.
 *
 * `params` per method:
 *
 * | Method | Params |
 * | --- | --- |
 * | `getPublicKey`, `getRelays` | none |
 * | `signEvent` | `{ event: { kind, content, tags, created_at?, pubkey? } }` |
 * | `nip04Encrypt`, `nip44Encrypt` | `{ pubkey, plaintext }` |
 * | `nip04Decrypt`, `nip44Decrypt` | `{ pubkey, ciphertext }` |
 *
 * Validated at the boundary by `validateRequest`, and nowhere else.
 */
export interface SignerRequest {
  id: string;
  origin: RequestOrigin;
  method: SignerMethod;
  params: Record<string, unknown>;
  receivedAt: number;
}

/** What a caller may hand `signEvent`. The signer fills `id`, `sig` and, when absent, the rest. */
export interface EventTemplateInput {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
  /** When present it must be the active account's, or the request is refused. */
  pubkey?: string;
}

/** The params after validation, typed by method. Only `validateRequest` produces one. */
export type ValidatedParams =
  | { method: 'getPublicKey' }
  | { method: 'getRelays' }
  | { method: 'signEvent'; event: EventTemplateInput }
  | { method: 'nip04Encrypt' | 'nip44Encrypt'; pubkey: string; plaintext: string }
  | { method: 'nip04Decrypt' | 'nip44Decrypt'; pubkey: string; ciphertext: string };

/**
 * A request that passed the boundary.
 *
 * `request` is a deep copy of what the transport handed in, frozen: it is what the user is
 * shown and what will be signed, and freezing it is what keeps those two from drifting apart
 * once the caller's own object is out of our hands. `params` is the same data, typed.
 */
export interface ValidatedRequest {
  request: SignerRequest;
  params: ValidatedParams;
}

// ── Approval ──

export interface ApprovalDecision {
  allow: boolean;
  /** Persist this decision through permissions, so the origin is not asked again. */
  remember?: boolean;
  /** With `remember`, scope a `signEvent` decision to this event kind (the default) or to every kind. */
  rememberKind?: boolean;
  /** Why, when refusing. Becomes the error the caller sees. */
  reason?: string;
}

/**
 * The prompt. The host shows `request` to the user as the given account and answers.
 *
 * `present` receives a frozen snapshot of exactly what will be signed, full content and every
 * tag; the pipeline never truncates on the way in. `cancel` is called when a request the host
 * is still showing has been settled from elsewhere: timed out, disposed, or rejected because
 * the account changed. The host should close the prompt; its eventual answer is ignored.
 */
export interface ApprovalPort {
  present(request: SignerRequest, account: SafeAccount): Promise<ApprovalDecision>;
  cancel(requestId: string, reason: string): void;
}

// ── Activity ──

/**
 * One entry in the activity log: something a caller asked this signer to do, and what
 * happened. Written for every request that passed the boundary, whatever the outcome.
 *
 * Never carries plaintext. A decrypt entry keeps the ciphertext, an encrypt entry keeps
 * nothing of the message at all, and a `signEvent` entry keeps the event that was signed,
 * which is public by construction.
 */
export interface ActivityEntry {
  requestId: string;
  timestamp: number;
  origin: RequestOrigin;
  method: SignerMethod;
  kind?: number;
  accountId: string | null;
  pubkey: string | null;
  decision: 'allow' | 'deny';
  /** Why, when denied. */
  reason?: string;
  /** The stable code, when denied. */
  code?: SignerErrorCode;
  /** The other party of an encrypt or decrypt. */
  theirPubkey?: string;
  /** What a decrypt was asked to open. Ciphertext only, by design. */
  ciphertext?: string;
  /** What a `signEvent` signed. */
  event?: EventTemplateInput;
}

export interface ActivityPort {
  record(entry: ActivityEntry): Promise<void>;
}

// ── Optional ports ──

/**
 * Names the active account while the vault is locked.
 *
 * The vault cannot: a locked vault has no account list. Without this port a locked vault
 * refuses every request outright, because the permission check needs the account and runs
 * before any unlock. The extension keeps the active account id outside the vault for
 * exactly this reason, and this is where a host plugs that in.
 */
export interface IdentityPort {
  getActiveAccount(): Promise<SafeAccount | null>;
}

/**
 * Opens the vault on a request's behalf.
 *
 * Called after the permission gate and after any approval, only for a method that needs the
 * key, only while the vault is locked. Resolve once the user has unlocked; reject when they
 * cancel. The pipeline re-checks the lock afterwards and does not trust the resolution alone.
 */
export interface UnlockPort {
  requestUnlock(request: SignerRequest, account: SafeAccount): Promise<void>;
}

/**
 * Executes a request for a remote-signer (NIP-46) account.
 *
 * Reached only after the same permission gate every local request passes: an explicit deny
 * blocks before anything is routed here. An unset permission does not prompt locally for a
 * signing or crypto method, because the bunker runs its own approval; `getPublicKey` still
 * does. `signal` aborts on timeout, account switch and disposal.
 */
export interface RemoteSignerPort {
  execute(
    account: SafeAccount,
    request: SignerRequest,
    params: ValidatedParams,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/** The relay list `getRelays` answers with. Without it the answer is empty. */
export interface RelayListPort {
  getRelays(account: SafeAccount): Promise<Record<string, { read: boolean; write: boolean }>>;
}

/**
 * Where a problem that must not fail the request goes. A library cannot assume a console;
 * the host injects this or nothing is written.
 */
export interface SignerLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

// ── The queue ──

/** What a pending entry is waiting on. Only `approval` counts toward the per-origin cap. */
export type PendingKind = 'approval' | 'unlock' | 'remote';

export interface PendingEntry {
  /** The request id. One request can hold one entry per kind over its lifetime. */
  id: string;
  kind: PendingKind;
  /** The permission origin key, as `permissionOrigin` spells it. */
  origin: string;
  /** The account the request was queued for; what an account switch rejects by. */
  accountId: string | null;
  queuedAt: number;
}

// ── The core ──

export interface SignerCoreDeps {
  vault: Vault;
  permissions: Permissions;
  approval: ApprovalPort;
  activity: ActivityPort;
  identity?: IdentityPort;
  unlock?: UnlockPort;
  remote?: RemoteSignerPort;
  relays?: RelayListPort;
  logger?: SignerLogger;
  /** The clock, injectable so cooldowns and timestamps can be tested without waiting. */
  now?: () => number;
}
