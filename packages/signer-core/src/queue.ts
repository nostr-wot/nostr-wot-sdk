/**
 * The pending map: what is waiting, on whom, and for how long.
 *
 * Ported from the extension's `services/signing/approvalQueue.ts` with the session
 * storage, the badge and the popup removed; a host that wants any of those reads
 * {@link ApprovalQueue.pending} and draws them itself. What stays is the part that decides
 * whether a request may wait at all, and when it stops waiting.
 *
 * Three kinds of entry, and the distinction is load-bearing for the per-origin cap: an
 * `approval` needs the user, so a pile of them is prompt spam and is capped tight; an
 * `unlock` marker and a `remote` entry are waiting on something else and do not count toward
 * that cap. They are still bounded, by the in-flight caps, because a queue that can grow
 * without limit is a denial of service waiting for a caller.
 */
import {
  MAX_IN_FLIGHT_GLOBAL,
  MAX_IN_FLIGHT_PER_ORIGIN,
  MAX_PENDING_PER_ORIGIN,
  REQUEST_TIMEOUT_MS,
} from './constants.js';
import { SignerError, type SignerErrorCode } from './errors.js';
import type { PendingEntry, PendingKind } from './types.js';

export interface ApprovalQueueOptions {
  /** Told whenever an entry is settled from outside the work itself: timeout, switch, disposal. */
  onCancel?: (entry: PendingEntry, reason: string) => void;
  timeoutMs?: number;
  maxPendingPerOrigin?: number;
  maxInFlightPerOrigin?: number;
  maxInFlightGlobal?: number;
  now?: () => number;
}

/** What {@link ApprovalQueue.track} takes: an entry without the timestamp it stamps itself. */
export type TrackInput = Omit<PendingEntry, 'queuedAt'>;

interface Tracked {
  entry: PendingEntry;
  /** Settle from outside. Idempotent: the first settlement wins and the rest are dropped. */
  fail(code: SignerErrorCode, reason: string): void;
}

/**
 * Namespaced by origin. A NIP-46 request id is chosen by the client, so two origins can hold
 * the same id at once; keying by id alone would let one caller's id collide with, or cancel,
 * another's.
 */
function key(origin: string, id: string, kind: PendingKind): string {
  return `${origin}\u0000${kind}\u0000${id}`;
}

export class ApprovalQueue {
  readonly #entries = new Map<string, Tracked>();
  readonly #onCancel: ((entry: PendingEntry, reason: string) => void) | undefined;
  readonly #timeoutMs: number;
  readonly #maxPendingPerOrigin: number;
  readonly #maxInFlightPerOrigin: number;
  readonly #maxInFlightGlobal: number;
  readonly #now: () => number;
  #disposed = false;

  constructor(options: ApprovalQueueOptions = {}) {
    this.#onCancel = options.onCancel;
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#maxPendingPerOrigin = options.maxPendingPerOrigin ?? MAX_PENDING_PER_ORIGIN;
    this.#maxInFlightPerOrigin = options.maxInFlightPerOrigin ?? MAX_IN_FLIGHT_PER_ORIGIN;
    this.#maxInFlightGlobal = options.maxInFlightGlobal ?? MAX_IN_FLIGHT_GLOBAL;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Everything waiting, oldest first. Copies, so a host cannot reach the live entries. */
  pending(): readonly PendingEntry[] {
    return [...this.#entries.values()].map((tracked) => ({ ...tracked.entry }));
  }

  /** How many prompts an origin has open: the number the per-origin cap is measured against. */
  actionableCount(origin: string): number {
    let count = 0;
    for (const { entry } of this.#entries.values()) {
      if (entry.kind === 'approval' && entry.origin === origin) count += 1;
    }
    return count;
  }

  /**
   * Run `work` as a pending entry, for as long as it takes or until something ends it first.
   *
   * Rejects up front, before `work` starts, when the queue is disposed, when the origin is at
   * a cap, or when this request already has an entry of this kind. Otherwise resolves with
   * what `work` returns, or rejects with what it throws, with a `timeout`, or with whatever
   * {@link reject}, {@link rejectPendingForAccount} or {@link dispose} settled it with. A
   * result that arrives after any of those is dropped: the caller was already told no.
   *
   * `signal` aborts on every external settlement, for work that can stop early.
   */
  track<T>(input: TrackInput, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#disposed) return Promise.reject(new SignerError('shutdown', 'Signer shut down'));
    const id = key(input.origin, input.id, input.kind);
    if (this.#entries.has(id)) {
      return Promise.reject(new SignerError('invalid_request', 'Request is already pending'));
    }
    if (input.kind === 'approval' && this.actionableCount(input.origin) >= this.#maxPendingPerOrigin) {
      return Promise.reject(
        new SignerError('too_many_pending', 'Too many pending requests from this origin'),
      );
    }
    if (
      this.#entries.size >= this.#maxInFlightGlobal ||
      this.#originCount(input.origin) >= this.#maxInFlightPerOrigin
    ) {
      return Promise.reject(new SignerError('too_many_pending', 'Too many pending requests'));
    }

    const entry: PendingEntry = { ...input, queuedAt: this.#now() };
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#entries.delete(id);
        finish();
      };
      const fail = (code: SignerErrorCode, reason: string): void => {
        if (settled) return;
        controller.abort();
        settle(() => reject(new SignerError(code, reason)));
        this.#onCancel?.(entry, reason);
      };
      const timer = setTimeout(() => fail('timeout', 'Request timed out'), this.#timeoutMs);
      // Where the runtime has it, so a pending prompt cannot keep a Node process alive.
      (timer as unknown as { unref?: () => void }).unref?.();
      this.#entries.set(id, { entry, fail });

      let started: Promise<T>;
      try {
        started = work(controller.signal);
      } catch (error) {
        settle(() => reject(error));
        return;
      }
      started.then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
  }

  /**
   * Settle one request's entries, every kind, as rejected. `false` when nothing was pending.
   * Scoped to the origin, since request ids are only unique within one.
   */
  reject(origin: string, requestId: string, reason: string): boolean {
    return (
      this.#rejectWhere((entry) => entry.origin === origin && entry.id === requestId, 'rejected', reason) > 0
    );
  }

  /**
   * Reject everything queued for an account, whatever kind. Called on an account switch, so a
   * caller can never receive the new account's identity or signature from a prompt that was
   * queued, and shown to the user, for the old one. Returns how many were rejected.
   */
  rejectPendingForAccount(accountId: string, reason: string): number {
    if (!accountId) return 0;
    return this.#rejectWhere((entry) => entry.accountId === accountId, 'account_switched', reason);
  }

  /** Reject everything and refuse further work. */
  dispose(): void {
    this.#disposed = true;
    this.#rejectWhere(() => true, 'shutdown', 'Signer shut down');
  }

  #originCount(origin: string): number {
    let count = 0;
    for (const { entry } of this.#entries.values()) if (entry.origin === origin) count += 1;
    return count;
  }

  #rejectWhere(match: (entry: PendingEntry) => boolean, code: SignerErrorCode, reason: string): number {
    // Snapshot first: settling removes from the map being walked.
    const matching = [...this.#entries.values()].filter(({ entry }) => match(entry));
    for (const tracked of matching) tracked.fail(code, reason);
    return matching.length;
  }
}
