// Public types for @nostr-wot/graph.

/**
 * Trust-score configuration. Ported verbatim from the extension.
 */
export interface ScoringConfig {
  /** Base score per hop distance, e.g. `{ 1: 1.0, 2: 0.5, 3: 0.25, 4: 0.1 }`. */
  distanceWeights: Record<number, number>;
  /** Bonus per extra shortest path, keyed by hop level, e.g. `{ 2: 0.15, 3: 0.1, 4: 0.05 }`. */
  pathBonus: Record<number, number>;
  /** Maximum path bonus that can be added on top of the base score. */
  maxPathBonus: number;
}

/**
 * Result of a distance query: hops from root + count of shortest paths.
 */
export interface DistanceInfo {
  /** Number of hops from the root (0 = self). */
  hops: number;
  /** Count of shortest paths from the root (1 for self). */
  paths: number;
}

/**
 * Graph metadata persisted alongside the follow edges.
 */
export interface GraphMeta {
  /** Root pubkey the graph was last crawled from. */
  root: string | null;
  /** Timestamp (ms) of the last completed crawl. */
  lastCrawl: number | null;
  /** Max BFS depth of the last crawl. */
  maxDepth: number | null;
  /** Storage schema version. */
  version: number;
}

/**
 * Aggregate storage counts.
 */
export interface StorageStats {
  /** Nodes that have a stored follow list. */
  nodes: number;
  /** Total follow edges across all nodes. */
  edges: number;
  /** Distinct interned pubkeys. */
  uniquePubkeys: number;
}

/**
 * Progress emitted while crawling.
 */
export interface CrawlProgress {
  /** Current BFS depth being fetched. */
  depth: number;
  /** Number of pubkeys fetched so far. */
  fetched: number;
  /** Number of pubkeys queued for the next depth. */
  queued: number;
}

/**
 * Options for {@link GraphCrawler.crawl} / {@link WotGraph.crawl}.
 */
export interface CrawlOptions {
  /** Max BFS depth. Default 2. */
  maxDepth?: number;
  /** Progress callback. */
  onProgress?: (p: CrawlProgress) => void;
  /** Abort signal to cancel the crawl. */
  signal?: AbortSignal;
}

/**
 * Result of a crawl.
 */
export interface CrawlResult {
  /** Pubkeys whose kind:3 was successfully fetched. */
  fetched: number;
  /** Nodes with a stored follow list after the crawl. */
  nodes: number;
  /** Total follow edges after the crawl. */
  edges: number;
  /** Deepest BFS depth actually reached. */
  depth: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** True if the crawl was aborted/stopped before finishing. */
  stoppedEarly: boolean;
}

/**
 * Options for {@link WotGraph.filterByWoT}.
 */
export interface FilterByWoTOptions {
  /** Only keep pubkeys within this many hops. Default 2. */
  maxHops?: number;
}

/**
 * A pluggable WebSocket constructor forwarded to the underlying pool
 * (e.g. a proxy-safe implementation).
 */
export type WebSocketLike = typeof WebSocket;

/**
 * Local query source consumed by `@nostr-wot/wot`'s `WoT` class.
 * Structurally shared: `@nostr-wot/wot` declares an identical interface.
 */
export interface WoTLocalSource {
  /** Distance in hops from the root, or `null` if unreached/unknown. */
  getDistance(target: string): number | null;
  /** Whether `target` is within `maxHops` of the root. */
  isInMyWoT(target: string, maxHops?: number): boolean;
  /** Trusted subset of `pubkeys`, sorted by score descending. */
  filterByWoT(pubkeys: string[], opts?: FilterByWoTOptions): string[];
}
