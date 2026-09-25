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

// ── The batch ──

/** One item of a batch: a request without an envelope, since the batch carries that. */
export interface SignerBatchItem {
  /** Unique within the batch; how the caller matches each outcome to what it asked. */
  id: string;
  /** A method that uses the key: `signEvent` or one of the four crypto methods. */
  method: SignerMethod;
  params: Record<string, unknown>;
}

/**
 * Many items, one origin, one approval.
 *
 * A first-class request, not a loop over single ones: the user is shown every item and
 * answers once, the permission cascade is consulted for every item, and the caller is told
 * what happened to each. Bounded at the boundary by `MAX_BATCH_ITEMS` and `MAX_BATCH_BYTES`
 * before anything is walked or copied. Validated by `validateBatchRequest`, and nowhere else.
 *
 * Only methods that use the key may be batched. `getPublicKey` has its own consent model (a
 * cooldown, an answer while locked, a prompt even for a remote account) and `getRelays` never
 * prompts; folding either in would give it the batch's consent or the batch its own. A
 * transport that receives a mixed wire batch answers those two through `handle`.
 */
export interface SignerBatchRequest {
  id: string;
  origin: RequestOrigin;
  items: SignerBatchItem[];
  receivedAt: number;
}

/** One validated item: its id and its params, typed by method. */
export interface ValidatedBatchItem {
  id: string;
  params: ValidatedParams;
}

/** A batch that passed the boundary: the frozen deep copy the user is shown, and typed items. */
export interface ValidatedBatch {
  request: SignerBatchRequest;
  items: readonly ValidatedBatchItem[];
}

/**
 * What became of one item. `ok` with the method's result, or a stable code and fixed text
 * exactly as a single request's refusal would carry them.
 */
export type BatchItemOutcome =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; code: SignerErrorCode; message: string };

/**
 * The answer to a batch that was approved and executed: an outcome per item, in the order the
 * items were given. A caller reads exactly which items were signed and which were not, and
 * why; nothing is collapsed into a count.
 */
export interface BatchResult {
  id: string;
  items: readonly BatchItemOutcome[];
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
 *
 * `cancel` names the origin as well as the id, because the id alone does not identify a
 * prompt: the queue keys entries by origin, kind and id, a NIP-46 request id is chosen by the
 * client, and two connected clients using the same id is trivially arranged. `origin` is the
 * permission key exactly as {@link PendingEntry.origin} and `permissionOrigin` spell it, so
 * the host can match what the queue matched.
 */
export interface ApprovalPort {
  present(request: SignerRequest, account: SafeAccount): Promise<ApprovalDecision>;
  /**
   * The prompt for a batch: the whole batch, every item, full content and every tag, answered
   * once. `cancel` names the batch id. A host that does not implement this cannot show a
   * batch, so a batch that needs a prompt is refused as `unsupported` rather than shown as a
   * count with a button; a batch every item of which is already allowed still signs.
   */
  presentBatch?(batch: SignerBatchRequest, account: SafeAccount): Promise<ApprovalDecision>;
  cancel(origin: string, requestId: string, reason: string): void;
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
  /** The batch this item arrived in, when it did. `requestId` is then the item's id. */
  batchId?: string;
}

export interface ActivityPort {
  record(entry: ActivityEntry): Promise<void>;
}

// ── Optional ports ──

/**
 * Names the active account, locked or not.
 *
 * Required, not optional. The permission check needs the account and runs before lock state
 * is consulted; the vault cannot name its account while locked. Were this port optional, a
 * host that left it out would turn "permissions before vault state" into "permissions when
 * unlocked", and a denied origin would learn the lock state instead of being denied. The
 * extension keeps the active account id outside the vault for exactly this reason, and this
 * is where a host plugs that in.
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
 *
 * Reject with a `SignerError` (code `rejected`, for instance) to tell the caller why. Any
 * other error is reported to the logger and reaches the caller as a fixed-text internal
 * error, so a storage path or a system message cannot travel off the device.
 */
export interface UnlockPort {
  requestUnlock(request: SignerRequest, account: SafeAccount): Promise<void>;
  /** The same, on a batch's behalf. Without it a batch that finds the vault locked is refused. */
  requestUnlockBatch?(batch: SignerBatchRequest, account: SafeAccount): Promise<void>;
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

/**
 * There is no `now` here on purpose. The core reads the vault's clock (`vault.now`) for its
 * cooldowns, activity timestamps, `created_at` and queue stamps, so the system runs on one
 * clock and faking time is done in one place.
 */
export interface SignerCoreDeps {
  vault: Vault;
  permissions: Permissions;
  approval: ApprovalPort;
  activity: ActivityPort;
  identity: IdentityPort;
  unlock?: UnlockPort;
  remote?: RemoteSignerPort;
  relays?: RelayListPort;
  logger?: SignerLogger;
}
