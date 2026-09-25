/**
 * The pipeline. Every signing, encryption and decryption request, from every transport,
 * passes through {@link SignerCore.handle}, and this is the component that decides whether
 * the caller gets a signature. It is a security control, not glue.
 *
 * Ported from the extension's `services/signing/signer.ts`, with the same order and the same
 * reasons:
 *
 *   1. Resolve the active account, through the identity port, locked or not.
 *   2. Check permissions. A deny at any consulted level short-circuits: the request never
 *      reaches a prompt and is never routed anywhere, remote signer included.
 *   3. An `ask` enqueues an approval and presents it through the approval port.
 *   4. Unlock if required.
 *   5. Execute through the signing backend.
 *   6. Zero key material.
 *   7. Record an activity entry, respond.
 *
 * **Permissions are checked before lock state.** A denied permission is enforced whether or
 * not the key is available, and whether the account is local or remote. Reordering these
 * steps is a regression, not a refactor.
 *
 * **Only fixed text leaves.** Every rejection out of `handle` is a `SignerError`. Whatever a
 * port, a store, the vault or a cipher threw is given to the logger and to the activity
 * entry, and the caller gets a code and a sentence that names nothing on the device.
 *
 * A batch ({@link SignerCore.handleBatch}) runs the same pipeline once for many items: one
 * account, every item's permission, one prompt showing every item, one unlock, then each item
 * signed in its own key scope. The judgement calls, partial permission and partial failure,
 * are written down on `#runBatch`.
 *
 * Nothing here externalizes anything. The signing backend runs inside the vault's
 * `withPrivkey`, which zeroes the key on every path and voids a result computed under a
 * session that was locked mid-callback; a callback that published would have already put
 * the event on the wire by the time that void arrived, so the callback only computes, and the
 * caller of `handle` decides what to do with the value.
 */
import type { SafeAccount } from '@nostr-wot/accounts';
import type { Permissions } from '@nostr-wot/permissions';
import { PrivateKeySigner } from '@nostr-wot/signers';
import type { Vault } from '@nostr-wot/vault';
import { GET_PUBLIC_KEY_COOLDOWN_MS, KEY_METHODS } from './constants.js';
import { SignerError, errorMessage } from './errors.js';
import { ApprovalQueue } from './queue.js';
import { validateBatchRequest, validateRequest } from './schema.js';
import type {
  ActivityEntry,
  ActivityPort,
  ApprovalDecision,
  ApprovalPort,
  BatchItemOutcome,
  BatchResult,
  IdentityPort,
  PendingEntry,
  RelayListPort,
  RemoteSignerPort,
  RequestOrigin,
  SignerBatchRequest,
  SignerCoreDeps,
  SignerLogger,
  SignerMethod,
  SignerRequest,
  UnlockPort,
  ValidatedBatch,
  ValidatedParams,
  ValidatedRequest,
} from './types.js';

/**
 * The key a request's origin is stored under in permissions.
 *
 * A web identifier is stored as itself: the exact http(s) origin the extension already keys
 * on (`https://example.com`), or the bare hostname older stores used, which the boundary has
 * already folded. Everything else is prefixed with its kind, because an Android package name
 * and a hostname are both dotted strings and a permission granted to one must not be found
 * by the other. The boundary refuses any web identifier with a `:` that is not an exact
 * http(s) origin, so a web caller cannot spell a prefix.
 */
export function permissionOrigin(origin: RequestOrigin): string {
  return origin.kind === 'web' ? origin.identifier : `${origin.kind}:${origin.identifier}`;
}

/** The id for a log line, from an object whose every read is untrusted and may throw. */
function requestIdForLog(request: unknown): string {
  try {
    if (typeof request !== 'object' || request === null) return '';
    const id: unknown = (request as { id?: unknown }).id;
    return typeof id === 'string' ? id : '';
  } catch {
    return '';
  }
}

interface Cooldown {
  expiresAt: number;
  accountId: string;
}

/** What `handle` knows about a request by the time it reports the outcome. */
interface RunContext {
  account: SafeAccount | null;
  /** Which step a foreign error came out of, which decides the fixed text it becomes. */
  phase: 'pipeline' | 'execute';
}

/** What the activity log is told about: a request, or one item of a batch. */
interface Recorded {
  id: string;
  origin: RequestOrigin;
  params: ValidatedParams;
  batchId?: string;
}

/** One item's run, before it is reported: the raw error is kept for the on-device log. */
type ItemRun =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: unknown; refusal: SignerError };

/** A permission rule a batch consulted and found unset: what `remember` persists. */
interface Asked {
  method: SignerMethod;
  kind: number | undefined;
}

export class SignerCore {
  readonly #vault: Vault;
  readonly #permissions: Permissions;
  readonly #approval: ApprovalPort;
  readonly #activity: ActivityPort;
  readonly #identity: IdentityPort;
  readonly #unlock: UnlockPort | undefined;
  readonly #remote: RemoteSignerPort | undefined;
  readonly #relays: RelayListPort | undefined;
  readonly #logger: SignerLogger | undefined;
  readonly #now: () => number;
  readonly #queue: ApprovalQueue;
  /** Per origin key: the `getPublicKey` auto-approve period and the account it was earned for. */
  readonly #cooldowns = new Map<string, Cooldown>();
  #disposed = false;

  constructor(deps: SignerCoreDeps) {
    this.#vault = deps.vault;
    this.#permissions = deps.permissions;
    this.#approval = deps.approval;
    this.#activity = deps.activity;
    this.#identity = deps.identity;
    this.#unlock = deps.unlock;
    this.#remote = deps.remote;
    this.#relays = deps.relays;
    this.#logger = deps.logger;
    // One clock: the vault's. See `SignerCoreDeps`.
    this.#now = deps.vault.now;
    this.#queue = new ApprovalQueue({
      now: this.#now,
      onCancel: (entry, reason) => {
        try {
          this.#approval.cancel(entry.origin, entry.id, reason);
        } catch (error) {
          this.#logger?.warn('approval port failed to cancel', {
            requestId: entry.id,
            error: errorMessage(error),
          });
        }
      },
    });
  }

  /** Everything waiting, for a host that draws a badge or a list. */
  pending(): readonly PendingEntry[] {
    return this.#queue.pending();
  }

  /**
   * Settle a pending request as rejected from the host's side, for a user closing a prompt.
   * `origin` is the entry's permission key as {@link pending} reports it: request ids are
   * only unique within one origin.
   */
  cancel(origin: string, requestId: string, reason = 'Cancelled by user'): boolean {
    return this.#queue.reject(origin, requestId, reason);
  }

  /** Reject everything pending and refuse further requests. */
  dispose(): void {
    this.#disposed = true;
    this.#cooldowns.clear();
    this.#queue.dispose();
  }

  /**
   * Invalidate everything that assumed the previous account.
   *
   * Every code path that changes the active account must call this: switching, removing the
   * active account, creating one. Rejects everything queued for the previous account, so a
   * caller can never receive the new account's identity or signature from a prompt that was
   * shown for the old one, and clears every `getPublicKey` cooldown, so a caller cannot be
   * handed the new account's pubkey off a cooldown the old one earned.
   */
  async onActiveAccountChanged(previousId: string | null, nextId: string | null): Promise<void> {
    this.#cooldowns.clear();
    if (previousId && previousId !== nextId) {
      this.#queue.rejectPendingForAccount(previousId, 'Account switched');
    }
  }

  /**
   * Run one request through the pipeline and answer it.
   *
   * Resolves with the method's result: a hex pubkey, a signed event, a relay map, a
   * ciphertext or a plaintext. Rejects with a {@link SignerError} for every refusal, with a
   * stable `code` and fixed text; a refusal is never a `null` or an empty result. Every
   * request that passed the boundary is written to the activity log, whatever happened to it.
   */
  async handle(request: SignerRequest): Promise<unknown> {
    if (this.#disposed) throw new SignerError('shutdown', 'Signer shut down');
    // Validated and copied here, and nowhere else. A malformed request is not an activity:
    // it never entered the pipeline.
    let validated: ValidatedRequest;
    try {
      validated = validateRequest(request);
    } catch (error) {
      throw this.#toSignerError(error, 'pipeline', requestIdForLog(request));
    }
    const context: RunContext = { account: null, phase: 'pipeline' };
    const recorded: Recorded = { id: validated.request.id, origin: validated.request.origin, params: validated.params };
    try {
      const result = await this.#run(validated, context);
      await this.#record(recorded, context.account, { decision: 'allow' });
      return result;
    } catch (error) {
      const refusal = this.#toSignerError(error, context.phase, validated.request.id);
      await this.#record(recorded, context.account, {
        decision: 'deny',
        // The original text, for the log on the device. The caller gets `refusal.message`.
        reason: errorMessage(error),
        code: refusal.code,
      });
      throw refusal;
    }
  }

  /**
   * Run a batch through the pipeline: one approval, an outcome per item.
   *
   * Resolves with a {@link BatchResult} once the batch as a whole was allowed to execute,
   * with every item's own result or refusal in it. Rejects with a {@link SignerError} when
   * the batch as a whole was refused: malformed, no account, a denied item, refused by the
   * user, timed out, the account switched, the vault locked and could not be opened. Either
   * way every item is written to the activity log under the batch id. Single requests through
   * {@link handle} are unchanged; this is an addition to the contract.
   */
  async handleBatch(batch: SignerBatchRequest): Promise<BatchResult> {
    if (this.#disposed) throw new SignerError('shutdown', 'Signer shut down');
    let validated: ValidatedBatch;
    try {
      validated = validateBatchRequest(batch);
    } catch (error) {
      throw this.#toSignerError(error, 'pipeline', requestIdForLog(batch));
    }
    const { request, items } = validated;
    const view = (index: number): Recorded => ({
      id: items[index]!.id,
      origin: request.origin,
      params: items[index]!.params,
      batchId: request.id,
    });
    const context: RunContext = { account: null, phase: 'pipeline' };
    try {
      const runs = await this.#runBatch(validated, context);
      const outcomes: BatchItemOutcome[] = [];
      for (const [index, run] of runs.entries()) {
        if (run.ok) {
          await this.#record(view(index), context.account, { decision: 'allow' });
          outcomes.push({ id: run.id, ok: true, result: run.result });
        } else {
          await this.#record(view(index), context.account, {
            decision: 'deny',
            reason: errorMessage(run.error),
            code: run.refusal.code,
          });
          outcomes.push({ id: run.id, ok: false, code: run.refusal.code, message: run.refusal.message });
        }
      }
      return { id: request.id, items: outcomes };
    } catch (error) {
      const refusal = this.#toSignerError(error, context.phase, request.id);
      for (let index = 0; index < items.length; index++) {
        await this.#record(view(index), context.account, {
          decision: 'deny',
          reason: errorMessage(error),
          code: refusal.code,
        });
      }
      throw refusal;
    }
  }

  async #run(validated: ValidatedRequest, context: RunContext): Promise<unknown> {
    const { request, params } = validated;
    const method = params.method;
    const originKey = permissionOrigin(request.origin);
    const kind = params.method === 'signEvent' ? params.event.kind : undefined;

    // 1. Resolve the active account. The identity port answers locked or not, which is what
    //    lets the permission check come next whatever the vault's state.
    const account = await this.#identity.getActiveAccount();
    if (!account) throw new SignerError('no_account', 'No active account');
    context.account = account;

    // 2. Permissions, before lock state, before routing, before anything. A deny is the end.
    const decision = await this.#permissions.check(originKey, method, kind, account.id);
    if (decision === 'deny') throw new SignerError('permission_denied', 'Permission denied');

    // Whether this account can do this at all. After the gate, so a denied origin learns
    // nothing about the account behind it.
    const remote = account.type === 'nip46';
    const needsKey = KEY_METHODS.has(method);
    if (needsKey && !remote && account.readOnly) {
      throw new SignerError('unsupported', 'This account has no signing key');
    }
    if (needsKey && remote && !this.#remote) {
      throw new SignerError('unsupported', 'Remote signing is not available on this host');
    }
    if (params.method === 'signEvent' && params.event.pubkey !== undefined) {
      if (params.event.pubkey !== account.pubkey) {
        throw new SignerError('author_mismatch', 'Event author does not match the active account');
      }
    }

    // 3. Ask. The prompt shows the frozen copy: full content, every tag, exactly what is signed.
    if (decision === 'ask' && this.#needsPrompt(method, remote, originKey, account)) {
      const outcome = await this.#queue.track(
        { id: request.id, kind: 'approval', origin: originKey, accountId: account.id },
        () => this.#approval.present(request, account),
      );
      if (!outcome.allow) {
        if (outcome.remember) await this.#remember(originKey, method, kind, outcome, 'deny', account);
        throw new SignerError('rejected', outcome.reason || 'Request rejected by user');
      }
      // The user approved THIS identity. If the active account moved while the prompt was
      // open, the answer is no, not the new account's key, and nothing is remembered.
      await this.#assertStillActive(account);
      if (outcome.remember) await this.#remember(originKey, method, kind, outcome, 'allow', account);
      if (method === 'getPublicKey') {
        this.#cooldowns.set(originKey, {
          expiresAt: this.#now() + GET_PUBLIC_KEY_COOLDOWN_MS,
          accountId: account.id,
        });
      }
    }

    // 4. Unlock if required. Only a method that needs the key, only while locked.
    if (needsKey && this.#vault.isLocked()) {
      if (!this.#unlock) throw new SignerError('vault_locked', 'Vault is locked');
      const unlock = this.#unlock;
      await this.#queue.track(
        { id: request.id, kind: 'unlock', origin: originKey, accountId: account.id },
        () => unlock.requestUnlock(request, account),
      );
      // The port said it unlocked; the vault is the authority on whether it did.
      if (this.#vault.isLocked()) throw new SignerError('vault_locked', 'Vault is locked');
    }

    // On every path, prompted or not: the account this request was resolved against has to
    // be the one that is active when it executes. The key is pinned to the snapshot below,
    // so this is not about signing with the wrong key; it is that a request resolved for one
    // account is not answered once the user has moved to another, as the extension refuses.
    await this.#assertStillActive(account);

    // 5. Execute. 6. Zero: `withPrivkey` hands the backend a copy and zeroes it on every path.
    context.phase = 'execute';
    const result = await this.#executeFor(account, remote, originKey, request, params);
    // And once more after execute, as the extension asserts the session after signing. The
    // execute window is real: a switch landing inside withPrivkey, or during a remote round
    // trip, would otherwise hand back a result computed for an account the user has left.
    // The key was pinned, so it is not the wrong key; it is an answer to a question the user
    // is no longer asking, and it is refused rather than returned or logged as allowed.
    await this.#assertStillActive(account);
    return result;
  }


  /**
   * The batch pipeline. Same steps, same order, same reasons as {@link #run}; what differs
   * is written here because each difference is a judgement call, not an accident.
   *
   * **Partial permission.** The cascade is consulted per item: a batch of kinds 1, 7 and
   * 1059 reads the rule for each. A `deny` on any item refuses the whole batch, before any
   * prompt, as `permission_denied`. Not "drop the denied item and ask about the rest": a
   * stored deny is the user's standing answer to that origin and kind, and a prompt that
   * shows the denied item would re-ask a question already answered while one that hides it
   * would have the user approve a batch without knowing what was in it. Either is worse
   * than telling the caller no. Everything decided before the prompt is decided about the
   * batch as the caller composed it (a deny, an author mismatch, an account that cannot
   * sign), and the caller recomposes; nothing the user is shown is later removed.
   *
   * An `allow` on an item means it needs no prompt of its own, not that it is hidden: the
   * prompt shows every item, allowed ones included, because the user is approving what
   * will be signed, and `remember` persists only the rules that were actually unset.
   *
   * **Partial failure.** After approval the batch is best-effort per item, and the result
   * says which. Each item is signed in its own `withPrivkey` scope, so a lock landing
   * mid-batch voids the item it landed in (the vault's own contract) and refuses the items
   * after it, while the items already handed back, computed under a live session, are
   * returned as signed. Eight of ten sign, the vault locks: the caller gets eight
   * signatures and two `vault_locked` outcomes, by id, and retries two. An atomic batch
   * would throw the eight away for no gain in safety, since a signature is not a side
   * effect, and would turn one undecryptable message into a failed batch of ten. What is
   * never partial is the account: a switch anywhere between the prompt and the end of the
   * last item refuses the whole batch, items already signed included, because those are
   * answers to a question the user is no longer asking, exactly as a single request is
   * refused after execute.
   *
   * **The queue.** A batch is one entry, so it counts once toward the per-origin cap. The
   * cap blunts prompt spam, and a batch is one prompt; its size is bounded on its own at
   * the boundary. Counting items would make the cap of five refuse the twelve-event burst
   * batching exists for.
   */
  async #runBatch(validated: ValidatedBatch, context: RunContext): Promise<ItemRun[]> {
    const { request, items } = validated;
    const originKey = permissionOrigin(request.origin);

    // 1. Resolve the active account, locked or not.
    const account = await this.#identity.getActiveAccount();
    if (!account) throw new SignerError('no_account', 'No active account');
    context.account = account;

    // 2. Permissions, per item, before lock state, before anything. Each distinct rule is
    //    read once; the first deny is the end, and the rules after it are not consulted.
    const consulted = new Set<string>();
    const asked: Asked[] = [];
    for (const item of items) {
      const method = item.params.method;
      const kind = item.params.method === 'signEvent' ? item.params.event.kind : undefined;
      const rule = `${method}\u0000${kind ?? ''}`;
      if (consulted.has(rule)) continue;
      consulted.add(rule);
      const decision = await this.#permissions.check(originKey, method, kind, account.id);
      if (decision === 'deny') throw new SignerError('permission_denied', 'Permission denied');
      if (decision === 'ask') asked.push({ method, kind });
    }

    // Whether this account can sign a batch at all. After the gate, so a denied origin learns
    // nothing about the account behind it. A remote account cannot: the remote port takes one
    // request, and the bunker runs its own approval per request, so the one-gesture property
    // a batch exists for does not survive the relay. The transport sends single requests.
    if (account.type === 'nip46') {
      throw new SignerError('unsupported', 'Batches are not available for a remote account');
    }
    if (account.readOnly) throw new SignerError('unsupported', 'This account has no signing key');
    for (const item of items) {
      if (item.params.method === 'signEvent' && item.params.event.pubkey !== undefined) {
        if (item.params.event.pubkey !== account.pubkey) {
          throw new SignerError('author_mismatch', 'Event author does not match the active account');
        }
      }
    }

    // 3. Ask once, showing the whole frozen batch. A host with no batch prompt cannot give
    //    the user every item, and a prompt that cannot is a blind-signing button; refused.
    if (asked.length > 0) {
      const approval = this.#approval;
      const presentBatch = approval.presentBatch;
      if (!presentBatch) throw new SignerError('unsupported', 'This host cannot show a batch');
      const outcome = await this.#queue.track(
        { id: request.id, kind: 'approval', origin: originKey, accountId: account.id },
        () => presentBatch.call(approval, request, account),
      );
      if (!outcome.allow) {
        if (outcome.remember) await this.#rememberAll(originKey, asked, outcome, 'deny', account);
        throw new SignerError('rejected', outcome.reason || 'Request rejected by user');
      }
      await this.#assertStillActive(account);
      if (outcome.remember) await this.#rememberAll(originKey, asked, outcome, 'allow', account);
    }

    // 4. Unlock if required, once for the batch.
    if (this.#vault.isLocked()) {
      const unlock = this.#unlock;
      const requestUnlockBatch = unlock?.requestUnlockBatch;
      if (!unlock || !requestUnlockBatch) throw new SignerError('vault_locked', 'Vault is locked');
      await this.#queue.track(
        { id: request.id, kind: 'unlock', origin: originKey, accountId: account.id },
        () => requestUnlockBatch.call(unlock, request, account),
      );
      if (this.#vault.isLocked()) throw new SignerError('vault_locked', 'Vault is locked');
    }
    await this.#assertStillActive(account);

    // 5. Execute, each item in its own key scope. 6. Zero, on every path, per item.
    context.phase = 'execute';
    const runs: ItemRun[] = [];
    for (const item of items) {
      try {
        runs.push({ id: item.id, ok: true, result: await this.#signLocally(account, item.params) });
      } catch (error) {
        runs.push({ id: item.id, ok: false, error, refusal: this.#toSignerError(error, 'execute', item.id) });
      }
    }
    // Every item's outcome sits behind this check; none is returned unless it passes.
    await this.#assertStillActive(account);
    return runs;
  }

  /** The execute step, by method and by where the key lives. */
  async #executeFor(
    account: SafeAccount,
    remote: boolean,
    originKey: string,
    request: SignerRequest,
    params: ValidatedParams,
  ): Promise<unknown> {
    switch (params.method) {
      case 'getPublicKey':
        return account.pubkey;
      case 'getRelays':
        return this.#relays ? await this.#relays.getRelays(account) : {};
      default:
        break;
    }
    if (remote) {
      const port = this.#remote as RemoteSignerPort;
      return this.#queue.track(
        { id: request.id, kind: 'remote', origin: originKey, accountId: account.id },
        (signal) => port.execute(account, request, params, signal),
      );
    }
    return this.#signLocally(account, params);
  }

  /** One key scope: the key is copied in, checked against the identity, used, zeroed. */
  async #signLocally(account: SafeAccount, params: ValidatedParams): Promise<unknown> {
    // Pinned to the account the user saw, never "whatever is active now".
    return this.#vault.withPrivkey(account.id, async (key) => {
      const signer = new PrivateKeySigner(key);
      // The identity port is the host's, and it is what the user was shown and what
      // `getPublicKey` answers. Nothing else in the chain checks that its pubkey is the one
      // this key derives to under this id. If it is not, the user approved as one identity
      // and the signature would be another's, so the key is not used at all.
      if ((await signer.getPublicKey()) !== account.pubkey) {
        throw new SignerError('author_mismatch', 'Event author does not match the active account');
      }
      return this.#execute(params, signer);
    });
  }

  /**
   * The signing backend. Computes and returns; never externalizes. `PrivateKeySigner` holds
   * the very buffer the vault handed in, so the vault's zeroing reaches it.
   */
  async #execute(params: ValidatedParams, signer: PrivateKeySigner): Promise<unknown> {
    switch (params.method) {
      case 'signEvent': {
        const { event } = params;
        // A fresh, unfrozen template: `finalizeEvent` fills id, pubkey and sig in place, and
        // the validated copy stays exactly what the user was shown.
        return signer.signEvent({
          kind: event.kind,
          content: event.content,
          tags: event.tags.map((tag) => [...tag]),
          created_at: event.created_at ?? Math.floor(this.#now() / 1000),
        });
      }
      case 'nip04Encrypt':
        return signer.nip04Encrypt(params.pubkey, params.plaintext);
      case 'nip04Decrypt':
        return signer.nip04Decrypt(params.pubkey, params.ciphertext);
      case 'nip44Encrypt':
        return signer.nip44Encrypt(params.pubkey, params.plaintext);
      case 'nip44Decrypt':
        return signer.nip44Decrypt(params.pubkey, params.ciphertext);
      default:
        // `getPublicKey` and `getRelays` were answered before the key was ever read.
        throw new SignerError('unsupported', `${params.method} does not use the key`);
    }
  }

  /**
   * Whether an `ask` needs the user this time.
   *
   * `getRelays` never prompts: the extension answers it without one, and a relay list is not
   * a secret. A remote account does not prompt locally for signing or crypto, because the
   * bunker runs its own approval; `getPublicKey` on a remote account still does, since the
   * pubkey is answered locally. And a `getPublicKey` inside the cooldown earned for this
   * same account is answered without one.
   */
  #needsPrompt(method: SignerMethod, remote: boolean, originKey: string, account: SafeAccount): boolean {
    if (method === 'getRelays') return false;
    if (remote && method !== 'getPublicKey') return false;
    if (method === 'getPublicKey') {
      const cooldown = this.#cooldowns.get(originKey);
      if (cooldown) {
        if (cooldown.accountId === account.id && this.#now() < cooldown.expiresAt) return false;
        this.#cooldowns.delete(originKey);
      }
    }
    return true;
  }

  /**
   * The account a request was resolved for has to be the one that is still active. Run after
   * approval, before execute and after execute, so a switch landing anywhere in between
   * refuses the request rather than answering it.
   */
  async #assertStillActive(shown: SafeAccount): Promise<void> {
    const current = await this.#identity.getActiveAccount();
    if (!current || current.id !== shown.id || current.pubkey !== shown.pubkey) {
      throw new SignerError('account_switched', 'Account switched');
    }
  }

  /** Persist a prompt's decision, scoped to the event kind unless the host said otherwise. */
  async #remember(
    originKey: string,
    method: SignerMethod,
    kind: number | undefined,
    outcome: ApprovalDecision,
    decision: 'allow' | 'deny',
    account: SafeAccount,
  ): Promise<void> {
    const rememberedKind = outcome.rememberKind !== false && kind !== undefined ? kind : null;
    await this.#permissions.save(originKey, method, rememberedKind, decision, account.id);
  }

  /**
   * Persist a batch prompt's decision for every rule the batch found unset, each once. Rules
   * that were already `allow` were not asked and are not rewritten.
   */
  async #rememberAll(
    originKey: string,
    asked: readonly Asked[],
    outcome: ApprovalDecision,
    decision: 'allow' | 'deny',
    account: SafeAccount,
  ): Promise<void> {
    const saved = new Set<string>();
    for (const { method, kind } of asked) {
      const rememberedKind = outcome.rememberKind !== false && kind !== undefined ? kind : null;
      const rule = `${method}\u0000${rememberedKind ?? ''}`;
      if (saved.has(rule)) continue;
      saved.add(rule);
      await this.#permissions.save(originKey, method, rememberedKind, decision, account.id);
    }
  }

  /**
   * What the caller is told.
   *
   * A `SignerError` is ours and carries fixed text, so it passes. Anything else came out of a
   * port, a store, the vault or a cipher, and its message may name a file, a path, a quota or
   * a buffer length: it goes to the logger, on the device, and the caller gets a sentence
   * that names nothing. A failure inside the signing step while the vault turns out to be
   * locked is reported as the lock, which is what it was.
   */
  #toSignerError(error: unknown, phase: RunContext['phase'], requestId: string): SignerError {
    if (error instanceof SignerError) return error;
    this.#logger?.warn('request failed', { requestId, phase, error: errorMessage(error) });
    if (phase === 'execute') {
      if (this.#vault.isLocked()) return new SignerError('vault_locked', 'Vault is locked');
      return new SignerError('operation_failed', 'Operation failed');
    }
    return new SignerError('internal', 'Internal signer error');
  }

  /**
   * Write the outcome. A failing log must not hold a computed signature hostage, and must not
   * be silent either: the host hears about it through the logger, or not at all.
   */
  async #record(
    recorded: Recorded,
    account: SafeAccount | null,
    outcome: { decision: 'allow' | 'deny'; reason?: string; code?: SignerError['code'] },
  ): Promise<void> {
    const { params } = recorded;
    const entry: ActivityEntry = {
      requestId: recorded.id,
      timestamp: this.#now(),
      origin: recorded.origin,
      method: params.method,
      accountId: account?.id ?? null,
      pubkey: account?.pubkey ?? null,
      decision: outcome.decision,
    };
    if (recorded.batchId !== undefined) entry.batchId = recorded.batchId;
    if (outcome.reason !== undefined) entry.reason = outcome.reason;
    if (outcome.code !== undefined) entry.code = outcome.code;
    switch (params.method) {
      case 'signEvent':
        entry.kind = params.event.kind;
        entry.event = params.event;
        break;
      case 'nip04Encrypt':
      case 'nip44Encrypt':
        entry.theirPubkey = params.pubkey;
        break;
      case 'nip04Decrypt':
      case 'nip44Decrypt':
        entry.theirPubkey = params.pubkey;
        entry.ciphertext = params.ciphertext;
        break;
      default:
        break;
    }
    try {
      await this.#activity.record(entry);
    } catch (error) {
      this.#logger?.warn('activity entry not recorded', {
        requestId: recorded.id,
        error: errorMessage(error),
      });
    }
  }
}
