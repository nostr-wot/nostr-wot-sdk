import type {
  PoolLike,
  NostrEvent,
  NostrFilter,
  SubCloser,
  RelayStatus,
  RelayPoolOptions,
  QueryOptions,
} from './types';
import { QueryBatcher } from './QueryBatcher';

const DEFAULTS = {
  statusPollIntervalMs: 3000,
  statusPollDelayMs: 1500,
  authorChunkSize: 150,
  reconnectDelayMs: 3000,
};

/**
 * Pool lifecycle management, subscriptions, publishing, and status tracking.
 *
 * Pool-agnostic: accepts any `PoolLike` implementation (e.g. SimplePool from nostr-tools).
 * Integrates with QueryBatcher for debounced, merged relay queries.
 */
export class RelayPool {
  private _pool: PoolLike | null;
  private _urls: string[];
  private _opts: typeof DEFAULTS & RelayPoolOptions;
  private _batcher: QueryBatcher;
  private _ownsBatcher: boolean;

  // Active subscriptions
  private _activeSubs: SubCloser[] = [];

  // Status tracking
  private _statuses = new Map<string, boolean>();
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _pollDelayTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RelayPoolOptions) {
    this._urls = [...options.urls];
    this._pool = options.pool ?? null;
    this._opts = { ...DEFAULTS, ...options };

    if (options.batcher) {
      this._batcher = options.batcher;
      this._ownsBatcher = false;
    } else {
      this._batcher = new QueryBatcher(this._pool ?? undefined, options.batcherOptions);
      this._ownsBatcher = true;
    }

    // Wire pool into batcher if provided
    if (this._pool) {
      this._batcher.setPool(this._pool);
    }
  }

  /** Get the underlying pool instance. */
  getPool(): PoolLike | null {
    return this._pool;
  }

  /** Get current relay URLs. */
  getUrls(): string[] {
    return [...this._urls];
  }

  /** Update relay URLs. Triggers `onRelaysChanged` callback. */
  setUrls(urls: string[]): void {
    this._urls = [...urls];
    this._opts.onRelaysChanged?.(this._urls);
  }

  /** Count of currently connected relays. */
  getConnectedCount(): number {
    let count = 0;
    for (const v of this._statuses.values()) {
      if (v) count++;
    }
    return count;
  }

  /** Current per-relay connection statuses. */
  getStatuses(): Map<string, boolean> {
    return new Map(this._statuses);
  }

  /** Get the integrated QueryBatcher. */
  getBatcher(): QueryBatcher {
    return this._batcher;
  }

  /**
   * Ensure pool is initialized. Safe to call multiple times.
   * @param createPool Factory function to create a pool instance.
   */
  ensurePool(createPool: () => PoolLike): void {
    if (!this._pool) {
      this._pool = createPool();
      this._batcher.setPool(this._pool);
    }
  }

  /**
   * Subscribe to events matching a filter. Returns a closer handle.
   * Automatically uses prioritized URLs.
   */
  subscribe(
    filter: NostrFilter,
    handlers: {
      onEvent: (e: NostrEvent) => void;
      onStatus?: (s: RelayStatus) => void;
      onEose?: () => void;
    }
  ): SubCloser {
    if (!this._pool) throw new Error('Pool not initialized');

    const urls = this._getPrioritizedUrls();
    let eoseFired = false;

    const sub = this._pool.subscribe(urls, [filter] as any, {
      onevent: (event: NostrEvent) => {
        handlers.onEvent(event);
      },
      oneose: () => {
        if (eoseFired) return;
        eoseFired = true;
        handlers.onStatus?.('eose');
        handlers.onEose?.();
      },
      onclose: () => {
        handlers.onStatus?.('disconnected');
      },
    });

    handlers.onStatus?.('connected');
    this._activeSubs.push(sub);
    this._startStatusPolling();

    return {
      close: () => {
        sub.close();
        const idx = this._activeSubs.indexOf(sub);
        if (idx >= 0) this._activeSubs.splice(idx, 1);
      },
    };
  }

  /**
   * Subscribe to notes from specific authors, chunking large pubkey lists.
   */
  subscribeAuthors(
    pubkeys: string[],
    filter: Omit<NostrFilter, 'authors'>,
    onEvent: (e: NostrEvent) => void,
    onEose?: () => void
  ): SubCloser {
    if (!this._pool || pubkeys.length === 0) {
      return { close: () => {} };
    }

    const urls = this._getPrioritizedUrls();
    const chunk = this._opts.authorChunkSize;

    if (pubkeys.length <= chunk) {
      const fullFilter = { ...filter, authors: pubkeys } as NostrFilter;
      const sub = this._pool.subscribe(urls, [fullFilter] as any, {
        onevent: (event: NostrEvent) => onEvent(event),
        oneose: () => onEose?.(),
      });
      this._activeSubs.push(sub);
      return {
        close: () => {
          sub.close();
          const idx = this._activeSubs.indexOf(sub);
          if (idx >= 0) this._activeSubs.splice(idx, 1);
        },
      };
    }

    // For large follow lists, use subscribeMap with chunked filters
    const filters: NostrFilter[] = [];
    for (let i = 0; i < pubkeys.length; i += chunk) {
      filters.push({ ...filter, authors: pubkeys.slice(i, i + chunk) } as NostrFilter);
    }
    const requests = urls.flatMap((url) =>
      filters.map((f) => ({ url, filter: f }))
    );

    let eoseFired = false;
    const sub = this._pool.subscribeMap(requests, {
      onevent: (event: NostrEvent) => onEvent(event),
      oneose: () => {
        if (!eoseFired) {
          eoseFired = true;
          onEose?.();
        }
      },
    });

    this._activeSubs.push(sub);
    return {
      close: () => {
        sub.close();
        const idx = this._activeSubs.indexOf(sub);
        if (idx >= 0) this._activeSubs.splice(idx, 1);
      },
    };
  }

  /** Batched query — debounced, merged with other concurrent queries. */
  query(filter: NostrFilter, opts?: QueryOptions): Promise<NostrEvent[]> {
    return this._batcher.query(this._getPrioritizedUrls(), filter, opts);
  }

  /** Immediate query — flushes the batch queue right away. */
  queryImmediate(filter: NostrFilter, opts?: QueryOptions): Promise<NostrEvent[]> {
    return this._batcher.queryImmediate(this._getPrioritizedUrls(), filter, opts);
  }

  /** Publish an event to all configured relays. Resolves when at least one relay accepts. */
  async publish(event: NostrEvent): Promise<void> {
    if (!this._pool) throw new Error('Pool not initialized');
    const promises = this._pool.publish(this._urls, event);
    // Race to first success without Promise.any (ES2021+)
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let remaining = promises.length;
      for (const p of promises) {
        p.then(() => {
          if (!settled) { settled = true; resolve(); }
        }).catch(() => {
          remaining--;
          if (remaining === 0 && !settled) {
            reject(new Error('All relays rejected publish'));
          }
        });
      }
    });
  }

  /**
   * Fetch a user's NIP-65 relay list (kind 10002).
   * Falls back to kind 3 contacts relay JSON.
   */
  async fetchUserRelays(pubkey: string): Promise<string[]> {
    if (!this._pool) return [];

    try {
      // Try NIP-65 relay list metadata (kind 10002)
      const events = await this._batcher.query(
        this._urls,
        { kinds: [10002], authors: [pubkey] }
      );

      if (events.length > 0) {
        events.sort((a, b) => b.created_at - a.created_at);
        const relayTags = events[0].tags.filter((t) => t[0] === 'r');
        const relayUrls = relayTags
          .map((t) => t[1])
          .filter((u) => u && u.startsWith('wss://'));
        if (relayUrls.length > 0) return relayUrls;
      }

      // Fallback: kind 3 contacts with relay JSON in content
      const k3 = await this._batcher.query(
        this._urls,
        { kinds: [3], authors: [pubkey] }
      );
      if (k3.length > 0) {
        k3.sort((a, b) => b.created_at - a.created_at);
        const content = k3[0].content;
        if (content) {
          try {
            const relayMap = JSON.parse(content);
            const parsed = Object.keys(relayMap).filter((u) => u.startsWith('wss://'));
            if (parsed.length > 0) return parsed;
          } catch {
            // content not valid JSON
          }
        }
      }
    } catch {
      // query failed
    }
    return [];
  }

  /** Add a relay URL. Returns false if already present. */
  addRelay(url: string): boolean {
    if (this._urls.includes(url)) return false;
    this._urls.push(url);
    this._opts.onRelaysChanged?.(this._urls);
    return true;
  }

  /** Remove a relay URL. Returns false if not found or last relay. */
  removeRelay(url: string): boolean {
    const filtered = this._urls.filter((u) => u !== url);
    if (filtered.length === this._urls.length) return false;
    if (filtered.length === 0) return false;
    this._urls = filtered;
    this._opts.onRelaysChanged?.(this._urls);
    return true;
  }

  /** Close all subscriptions and reconnect. */
  reconnect(): void {
    for (const sub of this._activeSubs) {
      sub.close();
    }
    this._activeSubs = [];
    this._statuses.clear();
    this._opts.onStatusChange?.(new Map(this._statuses));
  }

  /** Force a status refresh. */
  refreshStatuses(): void {
    if (!this._pool) return;
    try {
      const statuses = this._pool.listConnectionStatus?.();
      if (statuses instanceof Map) {
        const urls = this._urls;
        const next = new Map<string, boolean>();
        for (const url of urls) {
          const withSlash = url.endsWith('/') ? url : url + '/';
          const found = statuses.get(url) ?? statuses.get(withSlash);
          next.set(url, found === true);
        }
        let changed = next.size !== this._statuses.size;
        if (!changed) {
          for (const [k, v] of next) {
            if (this._statuses.get(k) !== v) { changed = true; break; }
          }
        }
        if (changed) {
          this._statuses = next;
          this._opts.onStatusChange?.(new Map(this._statuses));
        }
      }
    } catch {
      // listConnectionStatus not available
    }
  }

  /** Tear down pool, subscriptions, and timers. */
  destroy(): void {
    this._stopStatusPolling();
    for (const sub of this._activeSubs) {
      sub.close();
    }
    this._activeSubs = [];
    if (this._pool) {
      this._pool.close(this._urls);
      this._pool = null;
    }
    if (this._ownsBatcher) {
      this._batcher.destroy();
    }
    this._statuses.clear();
  }

  // ── Internals ──

  private _getPrioritizedUrls(): string[] {
    return this._opts.prioritizeUrls
      ? this._opts.prioritizeUrls(this._urls)
      : this._urls;
  }

  private _startStatusPolling(): void {
    if (this._pollTimer) return; // already polling
    this._pollDelayTimer = setTimeout(
      () => this.refreshStatuses(),
      this._opts.statusPollDelayMs
    );
    this._pollTimer = setInterval(
      () => this.refreshStatuses(),
      this._opts.statusPollIntervalMs
    );
  }

  private _stopStatusPolling(): void {
    if (this._pollDelayTimer) {
      clearTimeout(this._pollDelayTimer);
      this._pollDelayTimer = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }
}
