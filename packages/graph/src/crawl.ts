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

import type { GraphStorage } from './storage';
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

  constructor(options: GraphCrawlerOptions) {
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
  }

  async crawl(rootPubkey: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
    if (this.relays.length === 0) {
      throw new CrawlError('no relays connected');
    }

    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
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

        await this.mapLimited(currentLevel, async (pubkey) => {
          if (this.aborted) return;
          const follows = await this.fetchNewest(pubkey);
          if (this.aborted) return;

          if (follows === null) {
            failed.add(pubkey);
          } else {
            fetched.add(pubkey);
            reachedDepth = Math.max(reachedDepth, depth);
            this.storage.saveFollows(pubkey, follows);
            if (depth < maxDepth) {
              for (const f of follows) {
                if (!seen.has(f)) {
                  seen.add(f);
                  nextSet.add(f);
                }
              }
            }
          }

          opts.onProgress?.({ depth, fetched: fetched.size, queued: nextSet.size });
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
   * Fetch a single pubkey's newest kind:3 follow list across relays.
   * Resolves to the follow pubkeys, or `null` if no event arrived.
   */
  private fetchNewest(pubkey: string): Promise<string[] | null> {
    return new Promise((resolve) => {
      let newestAt = 0;
      let follows: string[] | null = null;
      let settled = false;
      let sub: CrawlSubCloser | null = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          sub?.close();
        } catch {
          /* ignore */
        }
        resolve(follows);
      };

      const timer = setTimeout(finish, this.requestTimeoutMs);

      sub = this.pool.subscribe(
        { kinds: [3], authors: [pubkey], limit: 1 },
        {
          onEvent: (ev: CrawlEvent) => {
            if (ev && ev.created_at > newestAt) {
              newestAt = ev.created_at;
              follows = (ev.tags || [])
                .filter((tag) => tag[0] === 'p' && tag[1])
                .map((tag) => tag[1]);
            }
          },
          onEose: finish,
        },
      );

      // Guard: a synchronous mock that resolved before assigning `sub` above.
      if (settled) {
        try {
          sub?.close();
        } catch {
          /* ignore */
        }
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
    await Promise.all(Array.from({ length: lanes }, () => runNext()));
  }
}
