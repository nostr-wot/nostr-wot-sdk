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
import type {
  AuthenticationParserOptions,
  AuthenticationProtocol,
  AuthenticationRequest,
  AuthenticationRequester,
  AuthenticationRequesterKind,
  AuthenticationScope,
} from '@nostr-wot/permissions';
import type { SafeAccount } from '@nostr-wot/accounts';
import type { AuthenticationGrantsPort, PermissionsPort, VaultPort } from './ports.js';
import type { SignerErrorCode } from './errors.js';

// ── The request ──

/**
 * The extension's NIP-07 method set, kept identical so the bridge is structural, plus one
 * NIP-07 has no spelling for: `signPqAttestation`, which signs the account's own `kind:10203`
 * post-quantum attestation. The extension does that from a privileged settings handler; here
 * it is a signing request like any other, under the `signEvent` rule for kind 10203.
 */
export type SignerMethod =
  | 'getPublicKey'
  | 'signEvent'
  | 'getRelays'
  | 'nip04Encrypt'
  | 'nip04Decrypt'
  | 'nip44Encrypt'
  | 'nip44Decrypt'
  | 'signPqAttestation';

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
 * | `nip04Encrypt` | `{ pubkey, plaintext }` |
 * | `nip44Encrypt` | `{ pubkey, plaintext, opts?: { scheme: 'pq', recipientKemKey } }` |
 * | `nip04Decrypt`, `nip44Decrypt` | `{ pubkey, ciphertext }` |
 * | `signPqAttestation` | none |
 *
 * `opts` is the extension's post-quantum opt-in: hybrid sealing to the recipient's
 * ML-KEM-1024 key (base64, from their `kind:10203`), never inferred. A decrypt takes no flag:
 * the payload says what it is.
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

/**
 * The params after validation, typed by method. Only `validateRequest` produces one.
 *
 * `scheme` on the NIP-44 methods is required, never defaulted: it decides whether the
 * account's post-quantum keys are read and which construction runs, so every consumer has
 * to say which it handled. For an encrypt it is what the caller asked for; for a decrypt it
 * is what the self-describing payload is.
 *
 * A post-quantum decrypt also carries `envelope`. A payload whose header names our envelope
 * version and which we cannot open — truncated, an algorithm byte we do not implement, base64
 * this host cannot decode — is `'unreadable'`, and it is still `scheme: 'pq'`, because it is:
 * reporting it as classic sent the caller, the activity log and anyone debugging to the NIP-44
 * code, which had never seen a payload like it.
 */
export type ValidatedParams =
  | { method: 'getPublicKey' }
  | { method: 'getRelays' }
  | { method: 'signEvent'; event: EventTemplateInput }
  | { method: 'nip04Encrypt'; pubkey: string; plaintext: string }
  | { method: 'nip44Encrypt'; pubkey: string; plaintext: string; scheme: 'classic' }
  | { method: 'nip44Encrypt'; pubkey: string; plaintext: string; scheme: 'pq'; recipientKemKey: string }
  | { method: 'nip04Decrypt'; pubkey: string; ciphertext: string }
  | { method: 'nip44Decrypt'; pubkey: string; ciphertext: string; scheme: 'classic' }
  | { method: 'nip44Decrypt'; pubkey: string; ciphertext: string; scheme: 'pq'; envelope: 'hybrid' | 'unreadable' }
  | { method: 'signPqAttestation' };

/**
 * The params of a request that is about to be executed, with the attestation's event resolved.
 *
 * `signPqAttestation` is the one method whose event this pipeline computes rather than receives:
 * the account's ML-KEM and ML-DSA public keys, the provenance tags and an ML-DSA proof of
 * possession. It is built BEFORE the user is asked, so the prompt can show the `kind:10203` in
 * full the way a `signEvent` template is shown, and that exact template is what gets signed —
 * the proof of possession is randomised, so rebuilding it after the prompt would put a
 * different event on the wire than the one that was approved.
 *
 * Everything downstream of the prompt (the signing backend, the activity entry) works on this,
 * not on {@link ValidatedParams}, so there is no path on which the attestation reaches a
 * signature without its event having been resolved and disclosed first.
 */
export type PreparedParams =
  | Exclude<ValidatedParams, { method: 'signPqAttestation' }>
  | { method: 'signPqAttestation'; event: EventTemplateInput };

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

/**
 * The host's answer to a prompt. One `allow` for the request, or for the whole batch.
 *
 * **There is deliberately no `excludedItems`.** A batch is approved or refused whole, so a
 * user who objects to item 41 of 64 refuses all 64. That was assessed and left out, and the
 * reasoning is here because the next person to want it will look at this type first:
 *
 * - **It is not just a decision field.** It needs a validation path (ids that are strings,
 *   in this batch, deduplicated — an unknown id has to refuse the batch, because ignoring it
 *   would silently sign the item the user excluded), its own outcome code so a caller can
 *   tell "the user removed this one, the other 63 are done" from "the batch was refused,
 *   recompose" (a wire-visible addition to `SignerError['code']`), a rule that exclude-all
 *   normalises to a deny rather than resolving with 64 refusals, and a rule that it cannot
 *   combine with `remember`: exclusion is per item, a stored permission is per method and
 *   kind, so remembering an approval of 63 kind-1 items would auto-sign the 64th next time.
 * - **The consent answer grows from one bit to N.** The core cannot see the screen and has
 *   never been able to verify what the user tapped; `allow: true` is already taken on the
 *   host's word for all 64 items, so a partial approval adds no new trust and no new
 *   capability to a hostile host (claiming an exclusion that did not happen only refuses an
 *   item; claiming none when there was one is no worse than approving a denied batch, which
 *   is already possible). What it adds is room for a *correct-looking* host to ship the
 *   wrong ids — an off-by-one on a filtered list, an id reused across a re-render, a stale
 *   closure — and sign the item the user actively unchecked. Validating unknown ids catches
 *   typos and stale ids, not an off-by-one that lands on another valid id, and nothing in
 *   this package can close that: it is the one bug shape whose result is a signature the
 *   user refused.
 * - **What it buys is one saved re-review**, of a burst the research puts at twelve items,
 *   and nothing measures how often a user objects to exactly one item. What it costs every
 *   host is a prompt that holds per-item state across re-renders and cancellation instead of
 *   answering one question.
 *
 * The cheap wins were taken instead: say the all-or-nothing rule before the list (the app's
 * prompt does), and give a refusal a machine-readable "which item", so a caller can drop the
 * offending item and recompose without spending the user's attention again. Without that
 * last piece a denied batch is re-sent identically and denied forever, which is the actual
 * user-facing defect near here — and it is smaller than `excludedItems`, not bigger.
 */
/**
 * How the pipeline treats a kind-22242 (NIP-42) or kind-27235 (NIP-98) event: a credential
 * addressed to a destination, never an ordinary signature.
 *
 * **The default is the browser extension's: every authentication request prompts, the prompt
 * must answer `authenticationScope: 'once'`, and nothing is stored.** Everything below is an
 * explicit opt-in a host configures because its requesters are not web pages.
 *
 * **Who is asking.** The pipeline never infers the requester from the event. A web host
 * either passes nothing (the validated `origin.identifier` of a `web` request is used, as the
 * extension attests it before building the request) or `originFor`, which resolves a
 * transport-attested HTTP origin. A host whose callers are a NIP-46 client, an Android
 * package, a LAN peer or itself passes `requesterFor` instead, returning the typed
 * {@link AuthenticationRequester} its transport established. One resolver or the other; a
 * host that configures both has not decided, and the constructor refuses it. A non-web
 * request with neither configured is refused as `invalid_request`, exactly as before.
 *
 * **Remembering.** With `grants` configured the pipeline reads the store before every
 * authentication prompt and writes it after an approval: a stored `deny` refuses for every
 * requester kind without a prompt; a stored `allow` skips the prompt, and a prompt may answer
 * `site` or `connected-sites`, only for a requester whose kind is in `rememberFor`. Its default
 * is every kind but `web`, so a browser host that configures `grants` gets a deny check and
 * nothing more unless it adds `'web'` on purpose. A remembered refusal (`remember: true` on a
 * `allow: false`) becomes a destination-scoped deny grant rather than a blanket kind deny in
 * the permission cascade, which is what the user was shown. A stored allow is re-read after
 * the unlock and after the signature, so a revocation landing in between refuses the result
 * (`permission_denied`).
 *
 * **The host's own path.** `self` names the requesters that ARE the host app: a `local` label
 * only in-app code can spell. A request from one of them, sent through
 * {@link SignerCore.handleSelf}, authenticates to a relay (NIP-42 only) with no destination
 * prompt and no grant written, because the question "may this caller log you in to this
 * relay" has nobody else in it. Everything else still applies: the permission cascade's deny,
 * a stored deny grant, `assertAllowed`, the unlock, every revalidation, and the activity entry,
 * which carries `consent: 'self'` so a log reader sees exactly which signatures took this path.
 * The same requester arriving through {@link SignerCore.handle} with an authentication event
 * is refused (`permission_denied`): the self path is not reachable by request, only by the
 * host calling the method, and a transport that forged the host's own origin gets nothing.
 */
export interface AuthenticationPolicy extends AuthenticationParserOptions {
  /** Resolve a transport-attested HTTP origin for a web host. Never infer it from event tags. */
  originFor?(request: SignerRequest, account: SafeAccount): Promise<string>;
  /**
   * Resolve the typed requester the host's transport attested: a client pubkey a pairing
   * proved, a package name the binder reported, a device id, the host's own label, or a web
   * origin. Required for a non-web requester to authenticate at all. Never derive it from
   * anything the request says about itself; `requesterOf(request.origin)` is the right answer
   * only for a host whose every transport establishes identity before it builds the request.
   */
  requesterFor?(request: SignerRequest, account: SafeAccount): Promise<AuthenticationRequester>;
  /** Enforce connection, frame and privileged endpoint policy. Repeated before and after signing. */
  assertAllowed?(request: SignerRequest, account: SafeAccount, authentication: Readonly<AuthenticationRequest>): Promise<void>;
  /** Stored destination grants. Without it nothing is remembered and only `once` is accepted. */
  grants?: AuthenticationGrantsPort;
  /** Requester kinds whose consent may be remembered and whose stored allow is honoured. Default: every kind but `web`. Needs `grants`. */
  rememberFor?: readonly AuthenticationRequesterKind[];
  /** The host's own requesters, for {@link SignerCore.handleSelf}. Non-web kinds only. */
  self?: SelfAuthenticationPolicy;
}

/** The requesters that are the host app itself. See {@link AuthenticationPolicy}. */
export interface SelfAuthenticationPolicy {
  /** At least one, none of them `web`: a website is never the host. */
  requesters: readonly AuthenticationRequester[];
}

export interface ApprovalContext {
  /** Show destination, method and protocol. For legacy-login, warn that the client uses the wrong standard and should contact its developers. */
  authentication: Readonly<AuthenticationRequest>;
  /** The requester's grant key, as `authenticationRequesterKey` spells it: the origin for a page, `kind:identifier` otherwise. */
  requester: string;
  /**
   * The scopes the pipeline will accept from this prompt. `['once']` unless the host
   * configured `grants` and this requester's kind is in `rememberFor`; `connected-sites`
   * only for a relay. A prompt should offer exactly these and nothing else.
   */
  scopes: readonly AuthenticationScope[];
}

export interface ApprovalDecision {
  allow: boolean;
  /**
   * Required for authentication. `once` is always accepted; `site` and `connected-sites`
   * only when they appear in {@link ApprovalContext.scopes}, which is the host's own
   * configuration reflected back. Anything else refuses the request.
   */
  authenticationScope?: AuthenticationScope;
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
 * **The `method` a prompt is shown may not be the one the caller sent.** `signPqAttestation`
 * arrives with no params and is presented as the `signEvent` it is, carrying the `kind:10203`
 * this pipeline built for it: a host that switches on `request.method` reaches its existing
 * event preview, and no host needs a case for a method name to avoid showing the user a
 * button with nothing behind it. The permission rule is `signEvent` for kind 10203 too, so
 * what the prompt says and what a remembered decision stores are the same thing. The activity
 * log keeps the method the caller actually asked for.
 *
 * `cancel` names the origin as well as the id, because the id alone does not identify a
 * prompt: the queue keys entries by origin, kind and id, a NIP-46 request id is chosen by the
 * client, and two connected clients using the same id is trivially arranged. `origin` is the
 * permission key exactly as {@link PendingEntry.origin} and `permissionOrigin` spell it, so
 * the host can match what the queue matched.
 */
export interface ApprovalPort {
  present(request: SignerRequest, account: SafeAccount, context?: ApprovalContext): Promise<ApprovalDecision>;
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
  /** For a NIP-44 method: the classic construction, or the post-quantum hybrid. */
  scheme?: 'classic' | 'pq';
  /** The batch this item arrived in, when it did. `requestId` is then the item's id. */
  batchId?: string;
  /** For a NIP-42 or NIP-98 event that parsed: what it authenticated to, and what let it. */
  authentication?: AuthenticationActivity;
}

/**
 * What authorised an authentication signature.
 *
 * - `once`, `site`, `connected-sites`: a prompt the user answered, at that scope.
 * - `grant`: a stored allow, read from `AuthenticationPolicy.grants`; no prompt was shown.
 * - `self`: the host's own path, {@link SignerCore.handleSelf}; no prompt, nothing stored.
 */
export type AuthenticationConsent = AuthenticationScope | 'grant' | 'self';

/**
 * The authentication half of an activity entry, so a log reader can tell a relay login from a
 * note without re-parsing the event, and can see which of them took the self path or rode a
 * stored grant. Present whenever the event parsed; `consent` only when the run got as far as
 * deciding, so a refused request shows its destination and no consent.
 */
export interface AuthenticationActivity {
  protocol: AuthenticationProtocol;
  /** The canonical destination: the relay URL for NIP-42, the service origin for NIP-98. */
  destination: string;
  method?: string;
  /** The requester's grant key. */
  requester: string;
  consent?: AuthenticationConsent;
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
  /**
   * Key material, as an INTERFACE. It was the `Vault` class, whose `#private` field makes its
   * type nominal, so no host facade could ever satisfy it — see `ports.ts` for the TS2740 that
   * cost the extension its migration. `@nostr-wot/vault`'s `Vault` satisfies this.
   */
  vault: VaultPort;
  /** Authorization, as an INTERFACE, for the same reason. `Permissions` satisfies it. */
  permissions: PermissionsPort;
  approval: ApprovalPort;
  activity: ActivityPort;
  identity: IdentityPort;
  unlock?: UnlockPort;
  remote?: RemoteSignerPort;
  relays?: RelayListPort;
  authentication?: AuthenticationPolicy;
  logger?: SignerLogger;
}
