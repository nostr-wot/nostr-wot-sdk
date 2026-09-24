/**
 * The pipeline. Every signing, encryption and decryption request, from every transport,
 * passes through {@link SignerCore.handle}, and this is the component that decides whether
 * the caller gets a signature. It is a security control, not glue.
 *
 * Ported from the extension's `services/signing/signer.ts`, with the same order and
 * the same reasons:
 *
 *   1. Resolve the active account.
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
import { SignerError, errorMessage, type SignerErrorCode } from './errors.js';
import { ApprovalQueue } from './queue.js';
import { validateRequest } from './schema.js';
import type {
  ActivityEntry,
  ActivityPort,
  ApprovalDecision,
  ApprovalPort,
  IdentityPort,
  PendingEntry,
  RelayListPort,
  RemoteSignerPort,
  RequestOrigin,
  SignerCoreDeps,
  SignerLogger,
  SignerMethod,
  SignerRequest,
  UnlockPort,
  ValidatedParams,
  ValidatedRequest,
} from './types.js';

/**
 * The key a request's origin is stored under in permissions.
 *
 * A web origin is stored bare, so the keys the extension has already written keep
 * working. Everything else is prefixed with its kind, because an Android package name and a
 * hostname are both dotted strings and a permission granted to one must not be found by the
 * other.
 */
export function permissionOrigin(origin: RequestOrigin): string {
  return origin.kind === 'web' ? origin.identifier : `${origin.kind}:${origin.identifier}`;
}

interface Cooldown {
  expiresAt: number;
  accountId: string;
}

/** What `handle` knows about a request by the time it records the outcome. */
interface RunContext {
  account: SafeAccount | null;
}

export class SignerCore {
  readonly #vault: Vault;
  readonly #permissions: Permissions;
  readonly #approval: ApprovalPort;
  readonly #activity: ActivityPort;
  readonly #identity: IdentityPort | undefined;
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
    this.#now = deps.now ?? (() => Date.now());
    this.#queue = new ApprovalQueue({
      now: this.#now,
      onCancel: (entry, reason) => {
        try {
          this.#approval.cancel(entry.id, reason);
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

  /** Settle a pending request as rejected from the host's side, for a user closing a prompt. */
  cancel(requestId: string, reason = 'Cancelled by user'): boolean {
    return this.#queue.reject(requestId, reason);
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
   * stable `code`; a refusal is never a `null` or an empty result. Every request that passed
   * the boundary is written to the activity log, whatever happened to it.
   */
  async handle(request: SignerRequest): Promise<unknown> {
    if (this.#disposed) throw new SignerError('shutdown', 'Signer shut down');
    // Validated and copied here, and nowhere else. A malformed request is not an activity:
    // it never entered the pipeline.
    const validated = validateRequest(request);
    const context: RunContext = { account: null };
    try {
      const result = await this.#run(validated, context);
      await this.#record(validated, context.account, { decision: 'allow' });
      return result;
    } catch (error) {
      await this.#record(validated, context.account, {
        decision: 'deny',
        reason: errorMessage(error),
        code: error instanceof SignerError ? error.code : undefined,
      });
      throw error;
    }
  }

  async #run(validated: ValidatedRequest, context: RunContext): Promise<unknown> {
    const { request, params } = validated;
    const method = params.method;
    const originKey = permissionOrigin(request.origin);
    const kind = params.method === 'signEvent' ? params.event.kind : undefined;

    // 1. Resolve the active account.
    const account = await this.#activeAccount();
    if (!account) {
      throw this.#vault.isLocked()
        ? new SignerError('vault_locked', 'Vault is locked')
        : new SignerError('no_account', 'No active account');
    }
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
      // open, the answer is no, not the new account's key.
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
      await this.#assertStillActive(account);
    }

    // 5. Execute. 6. Zero: `withPrivkey` hands the backend a copy and zeroes it on every path.
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
    // Pinned to the account the user saw, never "whatever is active now".
    return this.#vault.withPrivkey(account.id, (key) => this.#execute(params, key));
  }

  /**
   * The signing backend. Computes and returns; never externalizes. `PrivateKeySigner` holds
   * the very buffer the vault handed in, so the vault's zeroing reaches it.
   */
  async #execute(params: ValidatedParams, key: Uint8Array): Promise<unknown> {
    const signer = new PrivateKeySigner(key);
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

  async #activeAccount(): Promise<SafeAccount | null> {
    if (this.#identity) return this.#identity.getActiveAccount();
    const id = await this.#vault.getActiveAccountId();
    if (!id) return null;
    const accounts = await this.#vault.listAccounts();
    return accounts.find((candidate) => candidate.id === id) ?? null;
  }

  /** The account a prompt was shown for has to be the one that is still active. */
  async #assertStillActive(shown: SafeAccount): Promise<void> {
    const current = await this.#activeAccount();
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
   * Write the outcome. A failing log must not hold a computed signature hostage, and must not
   * be silent either: the host hears about it through the logger, or not at all.
   */
  async #record(
    validated: ValidatedRequest,
    account: SafeAccount | null,
    outcome: { decision: 'allow' | 'deny'; reason?: string; code?: SignerErrorCode },
  ): Promise<void> {
    const { request, params } = validated;
    const entry: ActivityEntry = {
      requestId: request.id,
      timestamp: this.#now(),
      origin: request.origin,
      method: request.method,
      accountId: account?.id ?? null,
      pubkey: account?.pubkey ?? null,
      decision: outcome.decision,
    };
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
        requestId: request.id,
        error: errorMessage(error),
      });
    }
  }
}
