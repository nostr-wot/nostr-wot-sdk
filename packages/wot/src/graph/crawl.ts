/**
 * BFS crawler for kind:3 contact lists.
 *
 * Ported from the extension (`lib/sync.ts`, `GraphSync`) but with the raw
 * `WebSocket` transport replaced by `@nostr-wot/relay`'s pool. The pool handles
 * connection/reconnect across relays; this class keeps the proven crawl logic:
 *
 * - BFS by depth: fetch the root's kind:3, enqueue its follows for the next
 *   depth, and so on up to `maxDepth`.
 * - Newest-per-author: for each pubkey, take the kind:3 event with the highest
 *   `created_at` seen across relays.
 * - Rate limiting: a base delay between dispatches and a max-concurrent cap.
 * - Tolerates unreachable relays; throws `CrawlError` only when zero relays are
 *   configured to connect.
 * - Abortable via `signal` or `stop()`; a stopped crawl leaves partial data
 *   usable and reports `stoppedEarly: true`.
 */

import { newerVersion, type GraphStorage } from './storage';
import type { CrawlOptions, CrawlResult } from './types';

// Minimal relay-pool surface the crawler needs. `@nostr-wot/relay`'s `RelayPool`
// (its `subscribe(filter, { onEvent, onEose })`) is structurally assignable.
export interface CrawlSubCloser {
  close(): void;
}
export interface CrawlEvent {
  created_at: number;
  tags: string[][];
  [key: string]: unknown;
}
export interface CrawlPool {
  subscribe(
    filter: { kinds?: number[]; authors?: string[]; limit?: number; [key: string]: unknown },
    handlers: {
      onEvent: (e: CrawlEvent) => void;
      onEose?: () => void;
      onStatus?: (s: string) => void;
    },
  ): CrawlSubCloser;
  getConnectedCount?(): number;
}

export interface GraphCrawlerOptions {
  pool: CrawlPool;
  storage: GraphStorage;
  relays: string[];
  /** Base delay (ms) between fetch dispatches. Default 50. */
  baseDelayMs?: number;
  /** Authors per relay subscription. Default 100. */
  batchSize?: number;
  /** Max concurrent in-flight fetches. Default 5. */
  maxConcurrent?: number;
  /** Per-pubkey response timeout (ms). Default 10000. */
  requestTimeoutMs?: number;
}

export class CrawlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrawlError';
  }
}

const DEFAULT_MAX_DEPTH = 2;

export class GraphCrawler {
  private pool: CrawlPool;
  private storage: GraphStorage;
  private relays: string[];
  private baseDelayMs: number;
  private maxConcurrent: number;
  private requestTimeoutMs: number;
  private aborted = false;
  private batchSize: number;
  private pending = new Set<() => void>();

  constructor(options: GraphCrawlerOptions) {
    this.batchSize = options.batchSize ?? 100;
    for (const [name, value] of Object.entries({ batchSize: this.batchSize, maxConcurrent: options.maxConcurrent ?? 5 })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
    }
    this.pool = options.pool;
    this.storage = options.storage;
    this.relays = options.relays;
    this.baseDelayMs = options.baseDelayMs ?? 50;
    this.maxConcurrent = options.maxConcurrent ?? 5;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
  }

  /** Abort an in-flight crawl. */
  stop(): void {
    this.aborted = true;
    for (const finish of this.pending) finish();
  }

  async crawl(rootPubkey: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
    if (this.relays.length === 0) {
      throw new CrawlError('no relays connected');
    }

    const maxDepth = opts.maxHops === undefined ? opts.maxDepth ?? DEFAULT_MAX_DEPTH : opts.maxHops - 1;
    const bound = opts.maxHops ?? maxDepth;
    if (!Number.isSafeInteger(bound) || bound < 0) throw new RangeError("crawl depth must be a non-negative safe integer");
    const start = Date.now();
    this.aborted = false;

    const signal = opts.signal;
    const onAbort = () => this.stop();
    if (signal) {
      if (signal.aborted) this.aborted = true;
      else signal.addEventListener('abort', onAbort);
    }

    const fetched = new Set<string>();
    const failed = new Set<string>();
    const seen = new Set<string>([rootPubkey]);
    let currentLevel: string[] = [rootPubkey];
    let reachedDepth = 0;
    let stoppedEarly = false;

    try {
      for (let depth = 0; depth <= maxDepth; depth++) {
        if (currentLevel.length === 0) break;
        if (this.aborted) {
          stoppedEarly = true;
          break;
        }

        const nextSet = new Set<string>();

        const batches: string[][] = [];
        for (let i = 0; i < currentLevel.length; i += this.batchSize) batches.push(currentLevel.slice(i, i + this.batchSize));
        await this.mapLimited(batches, async (authors) => {
          const events = await this.fetchNewest(authors);
          if (this.aborted) return;
          for (const pubkey of authors) {
            const event = events.get(pubkey);
            if (!event) failed.add(pubkey);
            else {
              fetched.add(pubkey);
              reachedDepth = Math.max(reachedDepth, depth);
              const follows = (event.tags || []).filter(tag => tag[0] === 'p' && typeof tag[1] === 'string' && tag[1]).map(tag => tag[1]);
              this.storage.saveFollows(pubkey, follows, { createdAt: event.created_at, id: String(event.id ?? '') });
            }
            // A missing or older relay response must not erase the cached list.
            if (depth < maxDepth) {
              for (const follow of this.storage.getFollows(pubkey)) {
                if (!seen.has(follow)) { seen.add(follow); nextSet.add(follow); }
              }
            }
            opts.onProgress?.({ depth, fetched: fetched.size, queued: nextSet.size });
            if (this.aborted) break;
          }
        });

        if (this.aborted) {
          stoppedEarly = true;
          break;
        }

        currentLevel = Array.from(nextSet);
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      await this.storage.flush();
    }

    const stats = this.storage.stats();
    return {
      fetched: fetched.size,
      nodes: stats.nodes,
      edges: stats.edges,
      depth: reachedDepth,
      durationMs: Date.now() - start,
      stoppedEarly,
    };
  }

  /**
   * Fetch one author batch, retaining the deterministic newest kind:3 per author.
   * No global limit: a prolific author must not displace another author's list.
   */
  private fetchNewest(authors: string[]): Promise<Map<string, CrawlEvent>> {
    return new Promise((resolve, reject) => {
      const newest = new Map<string, CrawlEvent>();
      const allowed = new Set(authors);
      let settled = false;
      let sub: CrawlSubCloser | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(finish);
        try { sub?.close(); } catch { /* transport already closed */ }
        resolve(newest);
      };
      const timer = setTimeout(finish, this.requestTimeoutMs);
      this.pending.add(finish);
      try {
        sub = this.pool.subscribe({ kinds: [3], authors }, {
          onEvent: ev => {
            if (settled || !ev || ev.kind !== 3 || typeof ev.pubkey !== 'string' || !allowed.has(ev.pubkey) ||
              !Number.isSafeInteger(ev.created_at) || ev.created_at < 0 || ev.created_at > Date.now() / 1000 + 60) return;
            const prior = newest.get(ev.pubkey);
            if (!prior || newerVersion({ createdAt: ev.created_at, id: String(ev.id ?? '') }, { createdAt: prior.created_at, id: String(prior.id ?? '') })) newest.set(ev.pubkey, ev);
          },
          onEose: finish,
        });
        if (settled) sub.close();
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(finish);
        settled = true;
        reject(error);
      }
    });
  }

  /**
   * Run `worker` over `items` with a max-concurrency cap and a base delay
   * before each dispatch (preserving the crawler's per-relay rate limiting
   * intent, now applied at the pool boundary).
   */
  private async mapLimited<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
    let index = 0;
    const runNext = async (): Promise<void> => {
      while (index < items.length) {
        if (this.aborted) return;
        const item = items[index++];
        if (this.baseDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.baseDelayMs));
        }
        if (this.aborted) return;
        await worker(item);
      }
    };

    const lanes = Math.min(this.maxConcurrent, Math.max(1, items.length));
    const outcomes = await Promise.allSettled(Array.from({ length: lanes }, async () => {
      try { await runNext(); } catch (error) { this.stop(); throw error; }
    }));
    const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failure) throw failure.reason;
  }
}
