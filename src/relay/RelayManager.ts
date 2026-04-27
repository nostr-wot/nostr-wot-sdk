import type {
  PoolLike,
  NostrEvent,
  NostrFilter,
  SubCloser,
  RelayStatus,
  QueryBatcherOptions,
  QueryOptions,
  RelayStatsOptions,
  RelayStatsPersistence,
} from './types';
import { RelayPool } from './RelayPool';
import { QueryBatcher } from './QueryBatcher';
import { RelayStats } from './RelayStats';

const INITIAL_LIMIT = 150;
const FETCH_PAGE_SIZE = 25;

export interface RelayManagerOptions {
  /** Options for the internal QueryBatcher */
  batcherOptions?: QueryBatcherOptions;
  /** Options for the internal RelayStats */
  statsOptions?: RelayStatsOptions;
  /** Status poll interval (default: 3000ms) */
  statusPollIntervalMs?: number;
  /** Initial delay before first status poll (default: 1500ms) */
  statusPollDelayMs?: number;
  /** Max authors per relay subscription chunk (default: 150) */
  authorChunkSize?: number;
  /** Delay before auto-reconnect (default: 3000ms) */
  reconnectDelayMs?: number;
  /** Initial note limit for feed subscription (default: 150) */
  initialLimit?: number;
  /** Page size for fetchOlderNotes (default: 25) */
  fetchPageSize?: number;
}

/**
 * Abstract relay manager with feed lifecycle methods.
 *
 * Composes RelayPool, QueryBatcher, and RelayStats internally.
 * Subclasses implement four hooks to plug in app-specific storage/settings.
 *
 * @example
 * ```typescript
 * class AppRelay extends RelayManager {
 *   getRelayUrls() { return getSettings().relays; }
 *   persistRelayUrls(urls) { setSetting('relays', urls); }
 *   getTimeWindowSeconds() { return getSettings().timeWindow * 3600; }
 *   async getLatestCachedTimestamp() { return db.getLatestTimestamp(); }
 * }
 *
 * const relay = new AppRelay();
 * await relay.init(() => new SimplePool(), dbPersistence);
 * ```
 */
export abstract class RelayManager {
  protected _pool: RelayPool;
  protected _stats: RelayStats;
  protected _batcher: QueryBatcher;
  private _opts: RelayManagerOptions;

  // Active feed subscription
  private _feedSub: SubCloser | null = null;
  private _followSub: SubCloser | null = null;
  private _onEvent: ((event: NostrEvent) => void) | null = null;
  private _onStatus: ((status: RelayStatus) => void) | null = null;
  private _eoseFired = false;
  private _subStartTime = 0;

  // Status mirror (public for direct access)
  relayStatuses = new Map<string, boolean>();
  onRelayStatusChange: (() => void) | null = null;

  constructor(options?: RelayManagerOptions) {
    this._opts = options ?? {};
    this._stats = new RelayStats(options?.statsOptions);
    this._batcher = new QueryBatcher(undefined, options?.batcherOptions);

    this._pool = new RelayPool({
      urls: this.getRelayUrls(),
      batcher: this._batcher,
      prioritizeUrls: (urls) => this._stats.getPrioritizedUrls(urls),
      onRelaysChanged: (urls) => this.persistRelayUrls(urls),
      onStatusChange: (statuses) => {
        this.relayStatuses = new Map(statuses);
        this.onRelayStatusChange?.();
      },
      statusPollIntervalMs: options?.statusPollIntervalMs,
      statusPollDelayMs: options?.statusPollDelayMs,
      authorChunkSize: options?.authorChunkSize,
      reconnectDelayMs: options?.reconnectDelayMs,
    });
  }

  // ── Abstract hooks (implement in subclass) ──

  /** Return the current list of relay WebSocket URLs. */
  protected abstract getRelayUrls(): string[];

  /** Persist an updated relay URL list (e.g. to localStorage or a settings store). */
  protected abstract persistRelayUrls(urls: string[]): void;

  /** Return the feed time window in seconds (e.g. `settings.timeWindow * 3600`). */
  protected abstract getTimeWindowSeconds(): number;

  /** Return the most recent cached event timestamp, or null if unavailable. */
  protected abstract getLatestCachedTimestamp(): Promise<number | null>;

  // ── Initialization ──

  /**
   * Initialize the pool and stats. Call once on app startup.
   * @param createPool Factory to create the underlying pool (e.g. `() => new SimplePool()`)
   * @param statsPersistence Optional persistence adapter for relay stats
   */
  async init(
    createPool: () => PoolLike,
    statsPersistence?: RelayStatsPersistence
  ): Promise<void> {
    this._pool.setUrls(this.getRelayUrls());
    this._pool.ensurePool(createPool);
    this._batcher.setPool(this._pool.getPool());
    await this._stats.init(statsPersistence);
  }

  // ── Pool access ──

  /** Get the underlying pool instance (e.g. SimplePool). */
  getPool(): PoolLike | null {
    return this._pool.getPool();
  }

  /** Get current relay URLs from the abstract hook. */
  getUrls(): string[] {
    return this.getRelayUrls();
  }

  /** Get the number of connected relays. */
  getConnectedCount(): number {
    return this._pool.getConnectedCount();
  }

  /** Get per-relay connection statuses. */
  getStatuses(): Map<string, boolean> {
    return this._pool.getStatuses();
  }

  /** Get the internal QueryBatcher. */
  getBatcher(): QueryBatcher {
    return this._batcher;
  }

  /** Get the internal RelayStats. */
  getStats(): RelayStats {
    return this._stats;
  }

  /** Force a status poll. */
  refreshStatuses(): void {
    this._pool.refreshStatuses();
  }

  // ── Feed lifecycle ──

  /**
   * Start the main feed subscription.
   * Uses `getTimeWindowSeconds()` and `getLatestCachedTimestamp()` to compute `since`.
   * Fires `onStatus('connected')` immediately, `onStatus('eose')` when relays finish,
   * and auto-reconnects on disconnect.
   */
  async initFeed(
    onEvent: (event: NostrEvent) => void,
    onStatus: (status: RelayStatus) => void
  ): Promise<void> {
    this._onEvent = onEvent;
    this._onStatus = onStatus;

    if (this._pool.getPool() && this._feedSub) {
      this._onStatus?.('connected');
      return;
    }

    await this._connectFeed();
  }

  private async _connectFeed(): Promise<void> {
    if (!this._pool.getPool()) return;

    let cachedLatest: number | null = null;
    try {
      cachedLatest = await this.getLatestCachedTimestamp();
    } catch {
      // Not available
    }

    const timeWindowSince = Math.floor(Date.now() / 1000) - this.getTimeWindowSeconds();
    const since = cachedLatest
      ? Math.max(cachedLatest - 60, timeWindowSince)
      : timeWindowSince;

    this._eoseFired = false;
    this._subStartTime = Date.now();

    const limit = this._opts.initialLimit ?? INITIAL_LIMIT;

    this._feedSub = this._pool.subscribe(
      { kinds: [1], since, limit },
      {
        onEvent: (event) => {
          this._onEvent?.(event);
        },
        onStatus: (status) => {
          if (status === 'eose' && !this._eoseFired) {
            this._eoseFired = true;
            const elapsed = Date.now() - this._subStartTime;
            for (const url of this.getUrls()) {
              this._stats.recordSuccess(url, elapsed);
            }
            this._onStatus?.('eose');
          } else if (status === 'disconnected') {
            this._onStatus?.('disconnected');
            const delay = this._opts.reconnectDelayMs ?? 3000;
            setTimeout(() => this.reconnect(), delay);
          }
        },
      }
    );

    this._onStatus?.('connected');
  }

  /**
   * Fetch older notes for backward pagination.
   * Uses `getTimeWindowSeconds()` for default `since`.
   */
  async fetchOlderNotes(
    until: number,
    limit?: number,
    customSince?: number
  ): Promise<NostrEvent[]> {
    if (!this._pool.getPool()) return [];

    const since = customSince ?? Math.floor(Date.now() / 1000) - this.getTimeWindowSeconds();
    const pageSize = limit ?? this._opts.fetchPageSize ?? FETCH_PAGE_SIZE;

    const startTime = Date.now();
    try {
      const events = await this._pool.query({ kinds: [1], since, until, limit: pageSize });
      const elapsed = Date.now() - startTime;
      for (const url of this.getUrls()) {
        this._stats.recordSuccess(url, elapsed);
      }
      return events;
    } catch {
      for (const url of this.getUrls()) {
        this._stats.recordFailure(url, 'query failed');
      }
      return [];
    }
  }

  /**
   * Fetch older notes from specific authors (for following tab pagination).
   * Automatically chunks large pubkey lists.
   */
  async fetchOlderFollowingNotes(
    pubkeys: string[],
    until: number,
    limit?: number,
    customSince?: number
  ): Promise<NostrEvent[]> {
    if (!this._pool.getPool() || pubkeys.length === 0) return [];

    const since = customSince ?? Math.floor(Date.now() / 1000) - this.getTimeWindowSeconds();
    const pageSize = limit ?? this._opts.fetchPageSize ?? FETCH_PAGE_SIZE;
    const chunkSize = this._opts.authorChunkSize ?? 150;

    try {
      const allEvents: NostrEvent[] = [];
      for (let i = 0; i < pubkeys.length; i += chunkSize) {
        const chunk = pubkeys.slice(i, i + chunkSize);
        const events = await this._pool.query(
          { kinds: [1], authors: chunk, since, until, limit: pageSize }
        );
        allEvents.push(...events);
      }
      return allEvents;
    } catch {
      return [];
    }
  }

  /**
   * Subscribe to notes from followed authors.
   * Uses `getTimeWindowSeconds()` for `since`. Auto-chunks large pubkey lists.
   */
  subscribeFollowing(
    pubkeys: string[],
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void
  ): void {
    if (!this._pool.getPool() || pubkeys.length === 0) return;

    if (this._followSub) {
      this._followSub.close();
      this._followSub = null;
    }

    const since = Math.floor(Date.now() / 1000) - this.getTimeWindowSeconds();

    this._followSub = this._pool.subscribeAuthors(
      pubkeys,
      { kinds: [1], since, limit: 200 },
      onEvent,
      onEose
    );
  }

  // ── Querying ──

  /** Batched query — debounced, merged with concurrent queries. */
  query(filter: NostrFilter, opts?: QueryOptions): Promise<NostrEvent[]> {
    return this._pool.query(filter, opts);
  }

  /** Immediate query — bypasses the debounce window. */
  queryImmediate(filter: NostrFilter, opts?: QueryOptions): Promise<NostrEvent[]> {
    return this._pool.queryImmediate(filter, opts);
  }

  // ── Publishing ──

  /** Publish an event to all configured relays. */
  async publish(event: NostrEvent): Promise<void> {
    return this._pool.publish(event);
  }

  // ── Relay management ──

  /** Fetch a user's NIP-65 relay list. */
  fetchUserRelays(pubkey: string): Promise<string[]> {
    return this._pool.fetchUserRelays(pubkey);
  }

  /** Add a relay URL. Persists via `persistRelayUrls`. Returns false if already present. */
  addRelay(url: string): boolean {
    const result = this._pool.addRelay(url);
    if (result) this.reconnect();
    return result;
  }

  /** Remove a relay URL. Persists via `persistRelayUrls`. Returns false if not found or last relay. */
  removeRelay(url: string): boolean {
    const result = this._pool.removeRelay(url);
    if (result) this.reconnect();
    return result;
  }

  /** Close all subscriptions and re-establish the feed. */
  reconnect(): void {
    if (this._feedSub) {
      this._feedSub.close();
      this._feedSub = null;
    }
    this._pool.reconnect();
    this._pool.setUrls(this.getRelayUrls());
    this._connectFeed();
  }

  /** Tear down everything. */
  destroy(): void {
    if (this._followSub) {
      this._followSub.close();
      this._followSub = null;
    }
    if (this._feedSub) {
      this._feedSub.close();
      this._feedSub = null;
    }
    this._pool.destroy();
    this._batcher.destroy();
    this._stats.destroy();
    this.relayStatuses.clear();
  }
}
