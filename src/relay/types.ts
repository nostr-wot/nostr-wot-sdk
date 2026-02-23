// Minimal Nostr event — compatible with nostr-tools Event
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// Nostr filter — supports #tag syntax via index signature
export interface NostrFilter {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  search?: string;
  [key: `#${string}`]: string[] | undefined;
}

// Duck-typed subscription closer
export interface SubCloser {
  close: () => void;
}

// Duck-typed pool interface (matches SimplePool from nostr-tools)
export interface PoolLike {
  subscribeManyEose(
    relays: string[],
    filter: NostrFilter[],
    params: {
      onevent: (e: NostrEvent) => void;
      onclose?: (reasons?: string[]) => void;
      maxWait?: number;
    }
  ): SubCloser;
  subscribe(
    relays: string[],
    filter: NostrFilter[],
    params: {
      onevent: (e: NostrEvent) => void;
      oneose?: () => void;
      onclose?: (reasons?: string[]) => void;
    }
  ): SubCloser;
  subscribeMap(
    requests: { url: string; filter: NostrFilter }[],
    params: {
      onevent: (e: NostrEvent) => void;
      oneose?: () => void;
    }
  ): SubCloser;
  publish(relays: string[], event: NostrEvent): Promise<string>[];
  listConnectionStatus?(): Map<string, boolean>;
  close(relays: string[]): void;
}

// ------- QueryBatcher -------

export interface QueryBatcherOptions {
  /** Debounce delay before flushing query batch (default: 100ms) */
  debounceMs?: number;
  /** Delay between pool-wait retries (default: 200ms) */
  poolWaitMs?: number;
  /** Max retries waiting for pool initialization (default: 10) */
  poolWaitMaxRetries?: number;
  /** Window after first event before resolving (default: 200ms) */
  collectionWindowMs?: number;
  /** Timeout if no events arrive at all (default: 3000ms) */
  firstEventTimeoutMs?: number;
  /** Hard timeout for subscribeManyEose (default: 5000ms) */
  maxWaitMs?: number;
}

export interface QueryOptions {
  /** Called with progressive results as events stream in */
  onUpdate?: (events: NostrEvent[]) => void;
}

// ------- RelayPool -------

export type RelayStatus = 'connected' | 'eose' | 'disconnected';

export interface RelayPoolOptions {
  /** Initial relay URLs */
  urls: string[];
  /** Pre-existing pool instance */
  pool?: PoolLike;
  /** Status poll interval (default: 3000ms) */
  statusPollIntervalMs?: number;
  /** Initial delay before first status poll (default: 1500ms) */
  statusPollDelayMs?: number;
  /** Max authors per relay subscription chunk (default: 150) */
  authorChunkSize?: number;
  /** Delay before auto-reconnect (default: 3000ms) */
  reconnectDelayMs?: number;
  /** Custom URL prioritization (e.g. from RelayStats) */
  prioritizeUrls?: (urls: string[]) => string[];
  /** Called when relay URL list changes */
  onRelaysChanged?: (urls: string[]) => void;
  /** Called when connection statuses change */
  onStatusChange?: (statuses: Map<string, boolean>) => void;
  /** Inject an existing QueryBatcher */
  batcher?: import('./QueryBatcher').QueryBatcher;
  /** Options for the internal QueryBatcher (used if no batcher injected) */
  batcherOptions?: QueryBatcherOptions;
}

// ------- RelayStats -------

export interface RelayStatsOptions {
  /** Max exponential backoff delay (default: 30000ms) */
  maxBackoffMs?: number;
  /** Auto-persist interval; 0 to disable (default: 30000ms) */
  persistIntervalMs?: number;
}

export interface RelayMetrics {
  url: string;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  lastConnected: number;
  consecutiveFailures: number;
  backoffUntil: number;
}

export interface RelayStatsData {
  url: string;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  lastConnected: number;
  consecutiveFailures: number;
}

export interface RelayStatsPersistence {
  load(): Promise<RelayStatsData[]>;
  save(stats: RelayStatsData[]): Promise<void>;
}
