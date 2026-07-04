/**
 * `WotGraph` — the primary public entry point.
 *
 * Ties the four internal layers together: a namespaced {@link GraphStorage},
 * a BFS {@link LocalGraph}, a {@link GraphCrawler}, and the pure scoring
 * function. Consumers create one per origin/app, `load()` to rehydrate any
 * cached graph, `crawl()` to build/refresh it, then run O(1)/O(n) queries.
 */

import { RelayPool } from '@nostr-wot/relay';
import { SimplePool } from 'nostr-tools';
import { useWebSocketImplementation } from 'nostr-tools/pool';

import { GraphStorage } from './storage';
import { LocalGraph } from './graph';
import { GraphCrawler, CrawlError, type CrawlPool } from './crawl';
import { calculateScore, DEFAULT_SCORING } from './scoring';
import { createWoTSource } from './wot-source';
import type {
  CrawlOptions,
  CrawlResult,
  DistanceInfo,
  FilterByWoTOptions,
  ScoringConfig,
  WebSocketLike,
  WoTLocalSource,
} from './types';

export interface WotGraphOptions {
  /** IndexedDB partition key (e.g. the app name). */
  namespace: string;
  /** Relay URLs to crawl. */
  relays: string[];
  /** Optional shared pool; if omitted one is created from `relays`. */
  pool?: CrawlPool;
  /** Scoring overrides merged onto {@link DEFAULT_SCORING}. */
  scoring?: Partial<ScoringConfig>;
  /** WebSocket implementation forwarded to the created pool. */
  websocketImplementation?: WebSocketLike;
}

export interface WotGraphStats {
  nodes: number;
  edges: number;
  root: string | null;
  lastCrawl: number | null;
  maxDepth: number | null;
}

const DEFAULT_MAX_HOPS = 2;
const STORAGE_VERSION = 1;

export class WotGraph {
  readonly namespace: string;
  private relays: string[];
  private scoring: ScoringConfig;
  private websocketImplementation?: WebSocketLike;

  private storage: GraphStorage;
  private graph: LocalGraph;

  private pool: CrawlPool | null;
  private ownPool: RelayPool | null = null;
  private crawler: GraphCrawler | null = null;

  private root: string | null = null;
  private inFlight: Promise<CrawlResult> | null = null;
  private controller: AbortController | null = null;
  private listeners = new Set<() => void>();

  constructor(options: WotGraphOptions) {
    this.namespace = options.namespace;
    this.relays = [...options.relays];
    this.scoring = mergeScoring(options.scoring);
    this.websocketImplementation = options.websocketImplementation;
    this.pool = options.pool ?? null;

    this.storage = new GraphStorage(this.namespace);
    this.graph = new LocalGraph(this.storage);
  }

  /** Hydrate any cached graph from IndexedDB (fast path). */
  async load(): Promise<void> {
    await this.storage.open();
    this.root = this.storage.getGraphMeta().root;
    this.graph.invalidateCache();
    this.notify();
  }

  /**
   * Build/refresh the graph by crawling kind:3 from `rootPubkey`.
   * Concurrent calls return the same in-flight promise (idempotent).
   */
  crawl(rootPubkey: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
    // Synchronous single-flight guard: a second crawl() while one is in flight
    // returns the same promise (idempotent — React strict-mode safe).
    if (this.inFlight) return this.inFlight;

    this.controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) this.controller.abort();
      else opts.signal.addEventListener('abort', () => this.controller?.abort(), { once: true });
    }
    this.root = rootPubkey;

    const run = (async (): Promise<CrawlResult> => {
      try {
        await this.storage.open();
        const pool = this.resolvePool();
        this.crawler = new GraphCrawler({ pool, storage: this.storage, relays: this.relays });
        const result = await this.crawler.crawl(rootPubkey, {
          maxDepth: opts.maxDepth,
          onProgress: opts.onProgress,
          signal: this.controller!.signal,
        });
        await this.storage.setMeta('root', rootPubkey);
        await this.storage.setMeta('lastCrawl', Date.now());
        await this.storage.setMeta('maxDepth', opts.maxDepth ?? DEFAULT_MAX_HOPS);
        await this.storage.setMeta('version', STORAGE_VERSION);
        this.graph.invalidateCache();
        this.notify();
        return result;
      } finally {
        this.inFlight = null;
        this.crawler = null;
        this.controller = null;
      }
    })();

    this.inFlight = run;
    return run;
  }

  /** Distance info from the crawled root, or `null` if unreached/unknown. */
  getDistance(pubkey: string): DistanceInfo | null {
    if (!this.root) return null;
    return this.graph.getDistance(this.root, pubkey);
  }

  /** Trust score 0..1 via {@link calculateScore}. */
  getScore(pubkey: string): number {
    const info = this.getDistance(pubkey);
    return calculateScore(info ? info.hops : null, info ? info.paths : null, this.scoring);
  }

  /** Whether `pubkey` is within `maxHops` of the root. */
  isInWoT(pubkey: string, maxHops: number = DEFAULT_MAX_HOPS): boolean {
    const info = this.getDistance(pubkey);
    return info !== null && info.hops <= maxHops;
  }

  /** Trusted subset of `pubkeys`, sorted by score descending. */
  filterByWoT(pubkeys: string[], opts?: FilterByWoTOptions): string[] {
    const maxHops = opts?.maxHops ?? DEFAULT_MAX_HOPS;
    const scored: Array<{ pubkey: string; score: number }> = [];
    for (const pubkey of pubkeys) {
      const info = this.getDistance(pubkey);
      if (info !== null && info.hops <= maxHops) {
        scored.push({ pubkey, score: calculateScore(info.hops, info.paths, this.scoring) });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.pubkey);
  }

  /** Follow list of `pubkey` as hex strings. */
  getFollows(pubkey: string): string[] {
    return this.graph.getFollows(pubkey);
  }

  /** Aggregate stats + crawl meta. */
  stats(): WotGraphStats {
    const s = this.storage.stats();
    const meta = this.storage.getGraphMeta();
    return {
      nodes: s.nodes,
      edges: s.edges,
      root: meta.root,
      lastCrawl: meta.lastCrawl,
      maxDepth: meta.maxDepth,
    };
  }

  /** True if the last crawl is older than `ttlMs` (or never happened). */
  isStale(ttlMs: number): boolean {
    const last = this.storage.getGraphMeta().lastCrawl;
    if (last === null) return true;
    return Date.now() - last > ttlMs;
  }

  /** Wipe this namespace. */
  async clear(): Promise<void> {
    await this.storage.clear();
    this.root = null;
    this.graph.invalidateCache();
    this.notify();
  }

  /** Abort an in-flight crawl. Partial data stays usable. */
  stop(): void {
    this.controller?.abort();
    this.crawler?.stop();
  }

  /** Adapter for `@nostr-wot/wot`'s `WoT` class. */
  asWoTSource(): WoTLocalSource {
    return createWoTSource(this);
  }

  /** The root pubkey the graph is currently answering queries from. */
  getRoot(): string | null {
    return this.root;
  }

  /** Subscribe to graph changes (crawl / load / clear). Returns an unsubscribe. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Release the pool/storage this instance owns. */
  destroy(): void {
    this.storage.close();
    if (this.ownPool) {
      this.ownPool.destroy();
      this.ownPool = null;
    }
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  private resolvePool(): CrawlPool {
    if (this.pool) return this.pool;
    if (this.relays.length === 0) throw new CrawlError('no relays connected');
    if (this.websocketImplementation) {
      useWebSocketImplementation(this.websocketImplementation);
    }
    const rp = new RelayPool({ urls: this.relays });
    rp.ensurePool(() => new SimplePool());
    this.ownPool = rp;
    // RelayPool.subscribe(filter, { onEvent, onEose }) is structurally compatible.
    this.pool = rp as unknown as CrawlPool;
    return this.pool;
  }
}

function mergeScoring(overrides?: Partial<ScoringConfig>): ScoringConfig {
  if (!overrides) return { ...DEFAULT_SCORING };
  return {
    distanceWeights: { ...DEFAULT_SCORING.distanceWeights, ...overrides.distanceWeights },
    pathBonus: { ...DEFAULT_SCORING.pathBonus, ...overrides.pathBonus },
    maxPathBonus: overrides.maxPathBonus ?? DEFAULT_SCORING.maxPathBonus,
  };
}
