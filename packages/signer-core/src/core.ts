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
 * **`signPqAttestation` runs 4 before 3, and that is not the regression it resembles.** It is
 * the one method whose event the pipeline computes rather than receives, out of the account's
 * own post-quantum keys, so a shut vault means there is nothing to put in front of the user. The
 * vault is opened, the `kind:10203` is built, and only then is the prompt shown — carrying that
 * event, spelled as the `signEvent` it is, so a host renders it with the preview it already has.
 * Prompting first could only show a preview with the proof of possession missing, which is
 * showing the user something other than what gets signed on the one screen where that is the
 * whole point. Unlocking is not consent: the permission cascade still short-circuits a deny
 * before any unlock, the prompt still follows, and a refusal still refuses. The full reasoning,
 * and the alternative that was rejected, are at the call site in `#run`.
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
import { PrivateKeySigner } from '@nostr-wot/signers';
import { canonicalHostname, canonicalHttpOrigin, siteScopes } from '@nostr-wot/permissions';
import { PQC_KIND, buildAttestationTags } from '@nostr-wot/pq';
import { GET_PUBLIC_KEY_COOLDOWN_MS, KEY_METHODS, ORIGIN_KINDS } from './constants.js';
import { SignerError, errorMessage } from './errors.js';
import { needsPqKeys, remotePqRefusal, withPqKeys, type PqKeyScope } from './pq.js';
import { ApprovalQueue } from './queue.js';
import { disclosedBatch, disclosedRequest, validateBatchRequest, validateRequest } from './schema.js';
import type { PermissionsPort, VaultPort } from './ports.js';
import type {
  ActivityEntry,
  ActivityPort,
  ApprovalDecision,
  ApprovalPort,
  BatchItemOutcome,
  BatchResult,
  EventTemplateInput,
  IdentityPort,
  PendingEntry,
  PreparedParams,
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

/**
 * A permission key spelled as the boundary spells it, for a host that revokes by whatever
 * spelling it holds: `EXAMPLE.COM.` is `example.com`, an http(s) origin is folded the same
 * way `validateRequest` folds it, a nip46 client's hex is lowercased. Anything else is
 * returned as given.
 */
export function canonicalOriginKey(key: string): string {
  const colon = key.indexOf(':');
  const prefix = colon === -1 ? '' : key.slice(0, colon);
  if (prefix !== 'web' && (ORIGIN_KINDS as readonly string[]).includes(prefix)) {
    return prefix === 'nip46' ? `nip46:${key.slice(colon + 1).toLowerCase()}` : key;
  }
  return canonicalHttpOrigin(key) ?? canonicalHostname(key) ?? key;
}

/**
 * Whether two canonical keys name the same site. The cascade reads both the origin form
 * and the bare hostname for one site, so revoking a site has to reach every key that
 * names its host: `example.com` covers `https://example.com` and `http://example.com:8080`,
 * and each of those covers `example.com`. A key with no host (`nip55:…`) is only itself.
 */
function sameSite(a: string, b: string): boolean {
  if (a === b) return true;
  const scopes = siteScopes(b);
  return siteScopes(a).some((scope) => scopes.includes(scope));
}

/**
 * A failure inside the signing step, tagged with where it came from, so the code the
 * caller sees is attributed by provenance and not by whether the vault happens to be
 * locked when the pipeline looks. `vault`: `withPrivkey` itself refused or voided the
 * result (locked, or the session moved mid-callback), which is the lock whatever the
 * vault's state now. `callback`: the signing backend threw, and `lockedAtThrow` was read
 * synchronously in its catch, before anything else could run.
 */
class ExecuteFailure extends Error {
  constructor(
    readonly cause: unknown,
    readonly source: 'vault' | 'callback',
    readonly lockedAtThrow: boolean,
  ) {
    super(errorMessage(cause));
    this.name = 'ExecuteFailure';
  }
}

/**
 * Give the host a turn. Used between the items of a batch, and nowhere else.
 *
 * `await Promise.resolve()` does not do this, and the difference is the whole reason this
 * exists. A microtask runs before the next timer, before layout and before a touch handler, so
 * a batch whose every await is a microtask is one contiguous block of CPU however many awaits
 * it contains. Measured on the version without this: a 64-item post-quantum batch was 1.4 s of
 * unbroken work on Node arm64, and a 1 ms timer running alongside it fired exactly once, after
 * the whole batch; 64 attestations were 2.8 s. Hermes without a JIT is commonly 10 to 30 times
 * slower on this arithmetic, which is tens of seconds of a phone that does not respond to
 * anything — and batching exists precisely because iOS charges the user a gesture per
 * signature, so a batch that freezes the device defeats the reason it was built.
 *
 * A macrotask is what lets a frame, a pending timer and a gesture in between two signatures.
 * `setTimeout` is a declared host requirement of these packages and runs the queue's timeout
 * and the vault's auto-lock already. It costs a clamped millisecond or so per item, which is
 * the price of the device staying alive; the work itself is unchanged and nothing is cancelled
 * here — a host that wants to stop a batch revokes the origin, which is checked in the same
 * gap.
 */
function yieldToHost(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
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
  /**
   * The params as prepared, once an attestation's event has been built: what the prompt showed
   * and what was signed, so the activity entry records the event rather than only its kind. One
   * entry for a single request, one per item for a batch, filled in as far as the run got.
   */
  prepared: readonly PreparedParams[] | null;
}

/**
 * What the activity log is told about: a request, or one item of a batch.
 *
 * Either shape of params, because an attestation refused before its event could be built has
 * no event to record, and saying so is honest. Everything past the prompt is {@link
 * PreparedParams}; only the log accepts both.
 */
interface Recorded {
  id: string;
  origin: RequestOrigin;
  params: PreparedParams | ValidatedParams;
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

/**
 * The permission rule a request is decided by. Every method is its own rule except the
 * attestation, which is the `signEvent` rule for kind 10203: it signs a `kind:10203`, so a
 * stored deny on that kind, or on signing at all, holds for it, and a remembered approval is
 * stored where a user looking for "kind 10203" will find it.
 */
function permissionRule(params: ValidatedParams): Asked {
  switch (params.method) {
    case 'signEvent':
      return { method: 'signEvent', kind: params.event.kind };
    case 'signPqAttestation':
      return { method: 'signEvent', kind: PQC_KIND };
    default:
      return { method: params.method, kind: undefined };
  }
}

export class SignerCore {
  readonly #vault: VaultPort;
  readonly #permissions: PermissionsPort;
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
  /** Per canonical key, its latest revocation and the host's reason; what a running batch checks. */
  readonly #revocations = new Map<string, { serial: number; reason: string }>();
  #revocationSerial = 0;
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
    this.#revocations.clear();
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
   * Forget the `getPublicKey` auto-approve an origin earned, so its next call prompts again.
   *
   * `origin` is the permission key as {@link pending} reports it and {@link cancel} takes it.
   * Nothing queued is touched; this is the narrow tool, for a host that wants to re-ask
   * without cutting the caller off. Revocation wants {@link revokeOrigin}.
   */
  clearCooldown(origin: string): void {
    const target = canonicalOriginKey(origin);
    for (const key of this.#cooldowns.keys()) if (sameSite(key, target)) this.#cooldowns.delete(key);
  }

  /**
   * The one entry point for "this caller is no longer trusted": revoking a remote client,
   * disconnecting a paired device, forgetting a site.
   *
   * Two things assume an origin is still welcome, and both are undone here. The cooldown
   * would otherwise admit a revoked client's next `connect` with no prompt for up to a
   * minute after the host cut it off, which the host cannot fix from outside without
   * reimplementing a window this pipeline owns. And anything the origin has queued, a
   * prompt on screen included, would otherwise still be answerable in its favour; it is
   * rejected with `reason`, single requests and batches alike, and the approval port is
   * told to close each prompt. This is {@link onActiveAccountChanged} scoped to an origin
   * instead of an account.
   *
   * `origin` is canonicalised as the boundary canonicalises it, and every key naming the
   * same site is covered (see {@link canonicalOriginKey} and `sameSite`), so a host revokes
   * once, by whatever spelling it holds.
   *
   * A batch already approved and executing is stopped too, between items: no further
   * signature is computed for a caller the host has cut off. The items that had already been
   * signed are reported as signed and the rest carry `reason` as a `rejected` outcome, so the
   * host and the caller both learn exactly where the revocation landed; the reasoning, and
   * the opposite choice, are written on `#runBatch`. A single request inside `withPrivkey`
   * cannot be interrupted and completes; it is milliseconds of pure computation, and the
   * host, having revoked the client, is the one that no longer delivers the answer. Either
   * way the host holds the result and can drop it — what it cannot reconstruct on its own is
   * which items ran.
   *
   * Not a deny: nothing is persisted, and the origin's next request runs the cascade as
   * usual. A host that wants it refused stores a permission. Returns how many pending
   * requests were rejected.
   */
  revokeOrigin(origin: string, reason = 'Origin revoked'): number {
    const target = canonicalOriginKey(origin);
    this.clearCooldown(target);
    this.#revocations.set(target, { serial: ++this.#revocationSerial, reason });
    let rejected = 0;
    for (const key of new Set(this.#queue.pending().map((entry) => entry.origin))) {
      if (sameSite(key, target)) rejected += this.#queue.rejectPendingForOrigin(key, reason);
    }
    return rejected;
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
    const context: RunContext = { account: null, phase: 'pipeline', prepared: null };
    const recorded = (): Recorded => ({
      id: validated.request.id,
      origin: validated.request.origin,
      params: context.prepared?.[0] ?? validated.params,
    });
    try {
      const result = await this.#run(validated, context);
      await this.#record(recorded(), context.account, { decision: 'allow' });
      return result;
    } catch (error) {
      const refusal = this.#toSignerError(error, context.phase, validated.request.id);
      await this.#record(recorded(), context.account, {
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
   * the batch as a whole was refused *before* execution began: malformed, no account, a
   * denied item, refused by the user, timed out, the account switched while the prompt was
   * open, the vault locked and could not be opened. That is the whole line: nothing had been
   * computed yet, so there is nothing to report per item. Once the first item has been
   * attempted the answer is always a `BatchResult`, including when an account switch or a
   * revocation cuts the batch off partway — those items come back refused by name rather
   * than as a thrown batch-wide failure. Either way every item is written to the activity
   * log under the batch id, with the outcome it actually had. Single requests through
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
      params: context.prepared?.[index] ?? items[index]!.params,
      batchId: request.id,
    });
    const context: RunContext = { account: null, phase: 'pipeline', prepared: null };
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
    const rule = permissionRule(params);

    // 1. Resolve the active account. The identity port answers locked or not, which is what
    //    lets the permission check come next whatever the vault's state.
    const account = await this.#identity.getActiveAccount();
    if (!account) throw new SignerError('no_account', 'No active account');
    context.account = account;

    // 2. Permissions, before lock state, before routing, before anything. A deny is the end.
    const decision = await this.#permissions.check(originKey, rule.method, rule.kind, account.id);
    if (decision === 'deny') throw new SignerError('permission_denied', 'Permission denied');

    // Whether this account can do this at all. After the gate, so a denied origin learns
    // nothing about the account behind it.
    const remote = account.type === 'nip46';
    const needsKey = KEY_METHODS.has(method);
    if (needsKey && !remote && account.readOnly) {
      throw new SignerError('unsupported', 'This account has no signing key');
    }
    // A post-quantum request on a remote account is refused here, at the routing step,
    // whatever the host's ports: the bunker would answer a hybrid encrypt with classic
    // ciphertext the caller cannot tell apart, which is the downgrade the opt-in exists to
    // prevent. See `remotePqRefusal`.
    const pqRefusal = remote ? remotePqRefusal(params) : null;
    if (pqRefusal !== null) throw new SignerError('unsupported', pqRefusal);
    if (needsKey && remote && !this.#remote) {
      throw new SignerError('unsupported', 'Remote signing is not available on this host');
    }
    if (params.method === 'signEvent' && params.event.pubkey !== undefined) {
      if (params.event.pubkey !== account.pubkey) {
        throw new SignerError('author_mismatch', 'Event author does not match the active account');
      }
    }

    // ── STEP 4 BEFORE STEP 3, DELIBERATELY. DO NOT "FIX" THIS. ──
    //
    // This is the one place in the pipeline where the unlock precedes the prompt, and it looks
    // exactly like the ordering mistake this file warns about at the top. It is not one. Ruled
    // on and kept, for the reason below.
    //
    // The attestation is the only method whose event the pipeline COMPUTES rather than receives.
    // Its ML-DSA proof of possession needs the account's post-quantum secret key, which needs an
    // open vault. So the order is: permissions, unlock, build the kind:10203, show it, sign that
    // exact object.
    //
    // The alternative, rejected: prompt first and show a preview of the event-to-be. It cannot
    // include the `pop` tag, because computing it is the thing that needs the key. That means
    // showing the user something that is NOT what gets signed, on the one screen where that
    // distinction is the entire point — and this project has twice defended the rule that an
    // approval shows the full content and all tags of the actual object, never a description of
    // it. A preview with a hole in it is the blind-signing button wearing a disguise. Signing a
    // freshly built event after approval is worse still: ML-DSA signing is randomised, so the
    // `pop` on the wire would differ from any `pop` that was shown.
    //
    // What the reordering does NOT cost:
    //   - It is not consent. The approval prompt still follows, and a refusal still refuses.
    //   - A denied origin cannot cause the vault to open: the permission cascade above
    //     short-circuits a `deny` before this line is reached, as it does for every method.
    //   - An account that cannot produce the event is refused here instead of being asked,
    //     which is the same disclosure, one step earlier.
    // What it does cost is a biometric or a password before the approval screen rather than
    // after it. That is a user-experience cost, not a security one.
    //
    // `pq.test.ts` pins both halves: `a locked vault is opened first, then the built event is
    // shown, then it signs` asserts the order, and `the prompt is shown the event that will be
    // signed, spelled as the signEvent it is` asserts that what was shown is what was signed.
    let prepared: PreparedParams;
    if (params.method === 'signPqAttestation') {
      await this.#openVault(request, originKey, account);
      await this.#assertStillActive(account);
      prepared = { method: 'signPqAttestation', event: await this.#buildAttestation(account) };
      context.prepared = [prepared];
    } else {
      // Every other method arrives as exactly what will be signed; there is nothing to prepare.
      prepared = params;
    }

    // 3. Ask. The prompt shows the frozen copy: full content, every tag, exactly what is signed.
    if (decision === 'ask' && this.#needsPrompt(method, remote, originKey, account)) {
      const shown = disclosedRequest(request, prepared);
      const outcome = await this.#queue.track(
        { id: request.id, kind: 'approval', origin: originKey, accountId: account.id },
        () => this.#approval.present(shown, account),
      );
      if (!outcome.allow) {
        if (outcome.remember) await this.#remember(originKey, rule, outcome, 'deny', account);
        throw new SignerError('rejected', outcome.reason || 'Request rejected by user');
      }
      // The user approved THIS identity. If the active account moved while the prompt was
      // open, the answer is no, not the new account's key, and nothing is remembered.
      await this.#assertStillActive(account);
      if (outcome.remember) await this.#remember(originKey, rule, outcome, 'allow', account);
      if (method === 'getPublicKey') {
        this.#cooldowns.set(originKey, {
          expiresAt: this.#now() + GET_PUBLIC_KEY_COOLDOWN_MS,
          accountId: account.id,
        });
      }
    }

    // 4. Unlock if required. Only a method that needs the key, only while locked. Already done
    //    above for the attestation, whose event could not have been built otherwise.
    if (needsKey && prepared.method !== 'signPqAttestation') {
      await this.#openVault(request, originKey, account);
    }

    // On every path, prompted or not: the account this request was resolved against has to
    // be the one that is active when it executes. The key is pinned to the snapshot below,
    // so this is not about signing with the wrong key; it is that a request resolved for one
    // account is not answered once the user has moved to another, as the extension refuses.
    await this.#assertStillActive(account);

    // 5. Execute. 6. Zero: `withPrivkey` hands the backend a copy and zeroes it on every path.
    context.phase = 'execute';
    const result = await this.#executeFor(account, remote, originKey, request, params, prepared);
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
   * effect, and would turn one undecryptable message into a failed batch of ten.
   *
   * **An account switch or a revocation mid-batch is reported the same way, per item.**
   * This is a deliberate reversal of the first design, which refused the whole batch with
   * the items already signed included, on the grounds that those answer a question the user
   * is no longer asking. That reasoning does not survive the batch contract, whose entire
   * point is that a caller can tell exactly what was signed:
   *
   * - The eight signatures exist. Each was computed under an account and a permission that
   *   were valid at the moment it ran, over exactly the item the prompt showed, with the key
   *   pinned to `account.id` and its pubkey re-checked inside the scope — so none of them can
   *   be the next account's. Withholding them does not un-sign them; it makes the report
   *   false.
   * - A caller told only "the batch failed" either re-sends all ten, publishing eight
   *   near-duplicate events, or believes nothing happened when eight things did. Neither is
   *   safer than the truth.
   * - The activity log is the one place a user looks to find out what their key did.
   *   Recording ten denials when eight signatures were produced is a false record there, and
   *   that is worse than anything the collapse was protecting against.
   * - It is already what the single-request path does under revocation: a request inside
   *   `withPrivkey` completes and is answered, and the host, having cut the client off, is
   *   the one that stops delivering (see {@link revokeOrigin}). The batch path was the only
   *   place that discarded completed work.
   *
   * The opposite choice is defensible, and is recorded here so the next reader knows this one
   * was made and not missed: withhold everything, on the theory that a revoked origin should
   * get nothing further from this signer, and that handing a caller eight signatures after
   * the host stopped trusting it hands it publishable material. That is a real argument, and
   * it is the host's to act on — it can drop the result it was given — whereas only this core
   * can say which eight. The core reports the truth; the host decides delivery.
   *
   * What the stop may never be is silent or indistinguishable. The items that did not run
   * carry `account_switched`, or `rejected` with the host's own revocation reason, so a
   * caller can tell a batch cut off from outside apart from items that failed on their own,
   * and knows not to retry against a revoked origin. And no further cryptographic work is
   * done for it: the check runs between items, before the next signature, never after the
   * fact. A single request is still refused outright after execute, because there is no
   * per-item truth to report about one item — the batch is the only shape that has one.
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
      const { method, kind } = permissionRule(item.params);
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

    // An attestation item's event is this pipeline's to compute, so for a batch carrying one the
    // unlock runs before the prompt and the events are built in between, for the reason written
    // on `#run`: a batch prompt has to show every item in full, and one of these items cannot be
    // shown at all until it exists. An account that cannot produce it refuses the whole batch
    // here, before the prompt, alongside every other thing decided about the batch as the caller
    // composed it — nothing the user is shown is later removed.
    if (items.some((item) => item.params.method === 'signPqAttestation')) {
      await this.#openVaultForBatch(request, originKey, account);
      await this.#assertStillActive(account);
    }
    const prepared: PreparedParams[] = [];
    context.prepared = prepared;
    for (const item of items) {
      if (item.params.method !== 'signPqAttestation') {
        prepared.push(item.params);
        continue;
      }
      // An ML-DSA proof of possession is the most expensive thing in this package (25 ms mean,
      // 121 ms worst on Node arm64), so the build loop yields too, not only the signing one.
      if (prepared.length > 0) await yieldToHost();
      prepared.push({ method: 'signPqAttestation', event: await this.#buildAttestation(account) });
    }

    // 3. Ask once, showing the whole frozen batch. A host with no batch prompt cannot give
    //    the user every item, and a prompt that cannot is a blind-signing button; refused.
    if (asked.length > 0) {
      const approval = this.#approval;
      const presentBatch = approval.presentBatch;
      if (!presentBatch) throw new SignerError('unsupported', 'This host cannot show a batch');
      const shown = disclosedBatch(request, prepared);
      const outcome = await this.#queue.track(
        { id: request.id, kind: 'approval', origin: originKey, accountId: account.id },
        () => presentBatch.call(approval, shown, account),
      );
      if (!outcome.allow) {
        if (outcome.remember) await this.#rememberAll(originKey, asked, outcome, 'deny', account);
        throw new SignerError('rejected', outcome.reason || 'Request rejected by user');
      }
      await this.#assertStillActive(account);
      if (outcome.remember) await this.#rememberAll(originKey, asked, outcome, 'allow', account);
    }

    // 4. Unlock if required, once for the batch. Already done above when the batch carries an
    //    attestation, whose event could not have been built otherwise.
    await this.#openVaultForBatch(request, originKey, account);
    await this.#assertStillActive(account);

    // 5. Execute, each item in its own key scope. 6. Zero, on every path, per item.
    //    Between items the batch is re-checked the way the lock is: a switch, or a
    //    revocation of this origin, ends it there. No further cryptographic work is done
    //    with a key the user has moved away from or for a caller the host has cut off; the
    //    items that already ran keep their real outcome and the rest are refused by name,
    //    for the reasons written on this method. And then the thread is handed back for a
    //    turn (`yieldToHost`), so the device stays alive through a long batch: the checks
    //    above are all microtask awaits, which is not a frame. See `yieldToHost`.
    //
    //    There is no check after the last item any more, and its absence is the fix. It used
    //    to be what discarded the whole batch; with per-item truth there is no outcome left
    //    for it to change (every item has either run or been refused), and keeping it would
    //    mean a revocation landing during the last signature threw away the other nine.
    context.phase = 'execute';
    const revokedBefore = this.#revocationSerial;
    const runs: ItemRun[] = [];
    // The one refusal that ends the batch instead of one item. Set at most once: from there
    // on every remaining item is refused with it and nothing is computed.
    let stopped: SignerError | null = null;
    for (const [index, item] of items.entries()) {
      if (index > 0 && !stopped) {
        stopped = await this.#stillWanted(account, originKey, revokedBefore);
        if (!stopped) await yieldToHost();
      }
      if (stopped) {
        runs.push({ id: item.id, ok: false, error: stopped, refusal: stopped });
        continue;
      }
      try {
        runs.push({ id: item.id, ok: true, result: await this.#signLocally(account, prepared[index]!) });
      } catch (error) {
        runs.push({ id: item.id, ok: false, error, refusal: this.#toSignerError(error, 'execute', item.id) });
      }
    }
    return runs;
  }

  /**
   * Step 4, on its own so the attestation can run it before the prompt (see `#run`). A no-op
   * when the vault is already open.
   */
  async #openVault(request: SignerRequest, originKey: string, account: SafeAccount): Promise<void> {
    if (!this.#vault.isLocked()) return;
    if (!this.#unlock) throw new SignerError('vault_locked', 'Vault is locked');
    const unlock = this.#unlock;
    await this.#queue.track(
      { id: request.id, kind: 'unlock', origin: originKey, accountId: account.id },
      () => unlock.requestUnlock(request, account),
    );
    // The port said it unlocked; the vault is the authority on whether it did.
    if (this.#vault.isLocked()) throw new SignerError('vault_locked', 'Vault is locked');
  }

  /** The same on a batch's behalf: one unlock for the whole batch, through the batch port. */
  async #openVaultForBatch(batch: SignerBatchRequest, originKey: string, account: SafeAccount): Promise<void> {
    if (!this.#vault.isLocked()) return;
    const unlock = this.#unlock;
    const requestUnlockBatch = unlock?.requestUnlockBatch;
    if (!unlock || !requestUnlockBatch) throw new SignerError('vault_locked', 'Vault is locked');
    await this.#queue.track(
      { id: batch.id, kind: 'unlock', origin: originKey, accountId: account.id },
      () => requestUnlockBatch.call(unlock, batch, account),
    );
    if (this.#vault.isLocked()) throw new SignerError('vault_locked', 'Vault is locked');
  }

  /**
   * The `kind:10203` for this account: its ML-KEM and ML-DSA public keys, the provenance tags
   * and an ML-DSA proof of possession, at the vault's clock.
   *
   * Built before the prompt, in the post-quantum scope alone — no private key is read here, and
   * the secp256k1 signature comes later, over exactly this template. `derived` asserts one
   * mnemonic restores these keys, which only a 24-word seed can; imported keys are `independent`
   * and claim no seed strength, exactly as the extension tags them, so a relay reader can tell
   * the two provenances apart.
   *
   * A failure is wrapped the way the signing step's failures are, so an account that cannot hold
   * post-quantum keys is refused with the extension's `unsupported` text and a vault that closed
   * mid-derivation is reported as the lock, rather than both becoming `internal`.
   */
  async #buildAttestation(account: SafeAccount): Promise<EventTemplateInput> {
    try {
      return await withPqKeys(this.#vault, account, async (scope) => ({
        kind: PQC_KIND,
        content: '',
        tags: buildAttestationTags({
          pubkey: account.pubkey,
          kem: scope.keys.kem.publicKey,
          dsa: scope.keys.dsa.publicKey,
          origin: scope.source === 'derived' ? 'derived' : 'independent',
          dsaSecretKey: scope.keys.dsa.secretKey,
        }),
        created_at: Math.floor(this.#now() / 1000),
      }));
    } catch (error) {
      if (error instanceof SignerError) throw error;
      throw new ExecuteFailure(error, 'callback', this.#vault.isLocked());
    }
  }

  /** The execute step, by method and by where the key lives. */
  async #executeFor(
    account: SafeAccount,
    remote: boolean,
    originKey: string,
    request: SignerRequest,
    params: ValidatedParams,
    prepared: PreparedParams,
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
    return this.#signLocally(account, prepared);
  }

  /**
   * One key scope: the key is copied in, checked against the identity, used, zeroed. A
   * failure comes out as an {@link ExecuteFailure} that says whether the vault or the
   * signing backend threw; a `SignerError` passes through as itself.
   *
   * A request that needs the account's post-quantum keys opens a second scope inside the
   * first, `withPqKeys`, and only then: a classic request never reads the seed phrase or
   * the imported keys, so the path everyone uses today does exactly what it did.
   */
  async #signLocally(account: SafeAccount, params: PreparedParams): Promise<unknown> {
    try {
      // Pinned to the account the user saw, never "whatever is active now".
      return await this.#vault.withPrivkey(account.id, async (key) => {
        // The identity port is the host's, and it is what the user was shown and what
        // `getPublicKey` answers. Nothing else in the chain checks that its pubkey is the one
        // this key derives to under this id. If it is not, the user approved as one identity
        // and the signature would be another's, so the key is not used at all.
        if ((await new PrivateKeySigner(key).getPublicKey()) !== account.pubkey) {
          throw new SignerError('author_mismatch', 'Event author does not match the active account');
        }
        try {
          // The attestation's post-quantum scope was opened before the prompt, to build the
          // event the user approved; by here it is an ordinary event to sign.
          const pq = params.method !== 'signPqAttestation' && needsPqKeys(params);
          if (!pq) return await this.#execute(params, new PrivateKeySigner(key));
          return await withPqKeys(this.#vault, account, (scope) => this.#executePq(params, key, scope));
        } catch (error) {
          if (error instanceof SignerError) throw error;
          throw new ExecuteFailure(error, 'callback', this.#vault.isLocked());
        }
      });
    } catch (error) {
      if (error instanceof SignerError || error instanceof ExecuteFailure) throw error;
      throw new ExecuteFailure(error, 'vault', true);
    }
  }

  /**
   * The signing backend. Computes and returns; never externalizes. `PrivateKeySigner` holds
   * the very buffer the vault handed in, so the vault's zeroing reaches it.
   */
  async #execute(params: PreparedParams, signer: PrivateKeySigner): Promise<unknown> {
    switch (params.method) {
      // The attestation signs the template that was built for it and shown at the prompt: the
      // same tags, the same proof of possession, the same second. Rebuilding it here would sign
      // something other than what was approved, because the proof of possession is randomised.
      case 'signPqAttestation':
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
        if (params.scheme === 'pq') throw new SignerError('unsupported', 'nip44Encrypt with a post-quantum scheme needs the post-quantum keys');
        return signer.nip44Encrypt(params.pubkey, params.plaintext);
      case 'nip44Decrypt':
        if (params.scheme === 'pq') throw new SignerError('unsupported', 'nip44Decrypt of a post-quantum payload needs the post-quantum keys');
        // The signer routes on the envelope too; with no ML-KEM key configured this is the
        // classic NIP-44 path and nothing else.
        return signer.nip44Decrypt(params.pubkey, params.ciphertext);
      default:
        // `getPublicKey` and `getRelays` were answered before the key was ever read.
        throw new SignerError('unsupported', `${params.method} does not use the key`);
    }
  }

  /**
   * The post-quantum backend, inside both scopes: the private key for the classic half of
   * the hybrid, and the account's ML-KEM key for the rest. The signer is built with the KEM
   * key so its own routing applies.
   *
   * The attestation is not here: its post-quantum half ran before the prompt, in
   * `#buildAttestation`, and the private-key half is an ordinary `signEvent`.
   */
  async #executePq(params: PreparedParams, key: Uint8Array, scope: PqKeyScope): Promise<unknown> {
    const signer = new PrivateKeySigner(key, { pqKem: scope.keys.kem });
    switch (params.method) {
      case 'nip44Encrypt':
        if (params.scheme !== 'pq') throw new SignerError('unsupported', 'classic nip44Encrypt does not use the post-quantum keys');
        return signer.nip44Encrypt(params.pubkey, params.plaintext, { scheme: 'pq', recipientKemKey: params.recipientKemKey });
      case 'nip44Decrypt': {
        if (params.scheme !== 'pq') throw new SignerError('unsupported', 'classic nip44Decrypt does not use the post-quantum keys');
        // The boundary routed this here because the payload's header names our envelope. If it
        // is not one we can open, say that: the alternative, which is what used to happen, was
        // to hand it to the classic path, where it failed under a `classic` label — in the
        // caller's error and in the activity entry — for a payload NIP-44 had never seen. The
        // text names the framing, which anyone holding the ciphertext can already read, and no
        // key-dependent outcome, so it is not an oracle.
        if (params.envelope !== 'hybrid') {
          throw new SignerError('operation_failed', 'This post-quantum payload is not a readable hybrid envelope');
        }
        return signer.nip44Decrypt(params.pubkey, params.ciphertext);
      }
      default:
        throw new SignerError('unsupported', `${params.method} does not use the post-quantum keys`);
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

  /**
   * Between the items of a batch: is the account still the one shown, and has the origin
   * survived since execution began? Answers with the refusal instead of throwing it, because
   * the caller has to keep the outcomes of the items that already ran and refuse only the
   * ones that have not — a throw from here is what used to collapse the whole batch into ten
   * denials of which eight were false. See the 'Partial failure' note on `#runBatch`.
   *
   * `null` means carry on.
   */
  async #stillWanted(shown: SafeAccount, originKey: string, revokedBefore: number): Promise<SignerError | null> {
    const current = await this.#identity.getActiveAccount();
    if (!current || current.id !== shown.id || current.pubkey !== shown.pubkey) {
      return new SignerError('account_switched', 'Account switched');
    }
    if (this.#revocationSerial !== revokedBefore) {
      for (const [key, { serial, reason }] of this.#revocations) {
        if (serial > revokedBefore && sameSite(key, originKey)) return new SignerError('rejected', reason);
      }
    }
    return null;
  }

  /** Persist a prompt's decision, scoped to the event kind unless the host said otherwise. */
  async #remember(
    originKey: string,
    { method, kind }: Asked,
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
    if (error instanceof ExecuteFailure) {
      // Attributed by where it came from, not by the vault's state now. See the class.
      if (error.source === 'vault' || error.lockedAtThrow) return new SignerError('vault_locked', 'Vault is locked');
      return new SignerError('operation_failed', 'Operation failed');
    }
    if (phase === 'execute') {
      // A remote port's failure, or anything else not from the key scope: the lock is the
      // best explanation available when the vault is locked, and fixed text either way.
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
      case 'signPqAttestation':
        entry.kind = PQC_KIND;
        // The event this pipeline built and the user approved, when the run got that far. An
        // attestation refused before it could be built has the kind and nothing to show, which
        // is honest: there was no event.
        if ('event' in params) entry.event = params.event;
        break;
      case 'nip04Encrypt':
        entry.theirPubkey = params.pubkey;
        break;
      case 'nip44Encrypt':
        entry.theirPubkey = params.pubkey;
        entry.scheme = params.scheme;
        break;
      case 'nip04Decrypt':
        entry.theirPubkey = params.pubkey;
        entry.ciphertext = params.ciphertext;
        break;
      case 'nip44Decrypt':
        entry.theirPubkey = params.pubkey;
        entry.ciphertext = params.ciphertext;
        entry.scheme = params.scheme;
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
