import type {
  PoolLike,
  NostrEvent,
  NostrFilter,
  QueryBatcherOptions,
  QueryOptions,
} from './types';

interface PendingQuery {
  urls: string[];
  filter: NostrFilter;
  dedupKey: string;
  callbacks: Array<{
    resolve: (events: NostrEvent[]) => void;
    reject: (err: Error) => void;
  }>;
  onUpdate?: (events: NostrEvent[]) => void;
}

const DEFAULTS: Required<QueryBatcherOptions> = {
  debounceMs: 100,
  poolWaitMs: 200,
  poolWaitMaxRetries: 10,
  collectionWindowMs: 200,
  firstEventTimeoutMs: 3000,
  maxWaitMs: 5000,
};

/**
 * Debounced query batcher with progressive relay queries and filter merging.
 *
 * Batches queries within a debounce window, merges compatible filters,
 * and streams results progressively as they arrive from relays.
 */
export class QueryBatcher {
  private _pool: PoolLike | null;
  private _opts: Required<QueryBatcherOptions>;
  private _pending: PendingQuery[] = [];
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _poolWaitRetries = 0;
  private _destroyed = false;

  constructor(pool?: PoolLike, options?: QueryBatcherOptions) {
    this._pool = pool ?? null;
    this._opts = { ...DEFAULTS, ...options };
  }

  /** Set or clear the underlying pool. Flushes pending queries if pool becomes available. */
  setPool(pool: PoolLike | null): void {
    this._pool = pool;
    if (pool && this._pending.length > 0) {
      this._poolWaitRetries = 0;
      this._flush();
    }
  }

  /** Get the current pool instance. */
  getPool(): PoolLike | null {
    return this._pool;
  }

  /** Debounced query — batched with other queries within the debounce window. */
  query(urls: string[], filter: NostrFilter, opts?: QueryOptions): Promise<NostrEvent[]> {
    return new Promise((resolve, reject) => {
      if (this._destroyed) {
        reject(new Error('QueryBatcher destroyed'));
        return;
      }
      const key = this._dedupKey(urls, filter);
      const existing = this._pending.find((q) => q.dedupKey === key);
      if (existing) {
        existing.callbacks.push({ resolve, reject });
        if (opts?.onUpdate) {
          const prev = existing.onUpdate;
          existing.onUpdate = prev
            ? (events) => { prev(events); opts.onUpdate!(events); }
            : opts.onUpdate;
        }
      } else {
        this._pending.push({
          urls, filter, dedupKey: key,
          callbacks: [{ resolve, reject }],
          onUpdate: opts?.onUpdate,
        });
      }
      if (!this._timer) {
        this._timer = setTimeout(() => this._flush(), this._opts.debounceMs);
      }
    });
  }

  /** Immediate query — flushes the queue right away (for user-initiated actions). */
  queryImmediate(urls: string[], filter: NostrFilter, opts?: QueryOptions): Promise<NostrEvent[]> {
    return new Promise((resolve, reject) => {
      if (this._destroyed) {
        reject(new Error('QueryBatcher destroyed'));
        return;
      }
      const key = this._dedupKey(urls, filter);
      const existing = this._pending.find((q) => q.dedupKey === key);
      if (existing) {
        existing.callbacks.push({ resolve, reject });
        if (opts?.onUpdate) {
          const prev = existing.onUpdate;
          existing.onUpdate = prev
            ? (events) => { prev(events); opts.onUpdate!(events); }
            : opts.onUpdate;
        }
      } else {
        this._pending.push({
          urls, filter, dedupKey: key,
          callbacks: [{ resolve, reject }],
          onUpdate: opts?.onUpdate,
        });
      }
      this._flush();
    });
  }

  /** Cancel all pending queries and clear timers. */
  destroy(): void {
    this._destroyed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const failed = this._pending.splice(0);
    for (const q of failed) {
      for (const cb of q.callbacks) cb.reject(new Error('QueryBatcher destroyed'));
    }
  }

  // ── Internals ──

  private _flush(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    const batch = this._pending.splice(0);
    if (batch.length === 0) return;

    const pool = this._pool;
    if (!pool) {
      // Pool not ready — re-queue and retry
      this._pending.unshift(...batch);
      this._poolWaitRetries++;
      if (this._poolWaitRetries > this._opts.poolWaitMaxRetries) {
        const failed = this._pending.splice(0);
        for (const q of failed) {
          for (const cb of q.callbacks) cb.reject(new Error('Pool not initialized'));
        }
        this._poolWaitRetries = 0;
        return;
      }
      this._timer = setTimeout(() => this._flush(), this._opts.poolWaitMs);
      return;
    }
    this._poolWaitRetries = 0;

    // Group by relay URL set
    const groups = new Map<string, PendingQuery[]>();
    for (const q of batch) {
      const key = [...q.urls].sort().join(',');
      const arr = groups.get(key);
      if (arr) {
        arr.push(q);
      } else {
        groups.set(key, [q]);
      }
    }

    for (const [, queries] of groups) {
      this._executeGroup(pool, queries);
    }
  }

  private async _executeGroup(pool: PoolLike, queries: PendingQuery[]): Promise<void> {
    const urls = queries[0].urls;

    // Single query — execute directly with progressive query
    if (queries.length === 1) {
      const q = queries[0];
      try {
        const events = await this._progressiveQuery(pool, urls, q.filter, q.onUpdate ? (allEvents) => {
          const deduped = this._dedup(allEvents);
          q.onUpdate!(deduped);
        } : undefined);
        for (const cb of q.callbacks) cb.resolve(events);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        for (const cb of q.callbacks) cb.reject(err);
      }
      return;
    }

    // Multiple queries — try to merge compatible filters
    const { merged, queryMap } = this._mergeFilters(queries);
    const hasAnyOnUpdate = queries.some((q) => q.onUpdate);

    const allEvents: NostrEvent[] = [];
    try {
      const results = await Promise.all(
        merged.map((filter, mergedIdx) => {
          const originalIndices = queryMap.get(mergedIdx) || [];
          const needsUpdate = hasAnyOnUpdate && originalIndices.some((qi) => queries[qi].onUpdate);

          return this._progressiveQuery(pool, urls, filter, needsUpdate ? (completedEvents) => {
            for (const qi of originalIndices) {
              const q = queries[qi];
              if (!q.onUpdate) continue;
              const matching = completedEvents.filter((ev) => this._eventMatchesFilter(ev, q.filter));
              const deduped = this._dedup(matching);
              q.onUpdate(deduped);
            }
          } : undefined);
        })
      );
      for (const events of results) {
        allEvents.push(...events);
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      for (const q of queries) {
        for (const cb of q.callbacks) cb.reject(err);
      }
      return;
    }

    // Route events back to callers by matching against original filters
    for (let qi = 0; qi < queries.length; qi++) {
      const matchingEvents = allEvents.filter((ev) =>
        this._eventMatchesFilter(ev, queries[qi].filter)
      );
      const deduped = this._dedup(matchingEvents);
      for (const cb of queries[qi].callbacks) cb.resolve(deduped);
    }
  }

  /**
   * Progressive relay query.
   * Phase 1: After first event, wait collectionWindowMs then resolve with collected events.
   * Phase 2: Keep listening. When onclose fires, call onAllComplete with all events.
   */
  private _progressiveQuery(
    pool: PoolLike,
    urls: string[],
    filter: NostrFilter,
    onAllComplete?: (events: NostrEvent[]) => void
  ): Promise<NostrEvent[]> {
    return new Promise<NostrEvent[]>((resolve) => {
      const events: NostrEvent[] = [];
      let resolved = false;
      let collectionTimer: ReturnType<typeof setTimeout> | null = null;
      let firstEventTimer: ReturnType<typeof setTimeout> | null = null;

      const doResolve = () => {
        if (resolved) return;
        resolved = true;
        if (collectionTimer) clearTimeout(collectionTimer);
        if (firstEventTimer) clearTimeout(firstEventTimer);
        resolve([...events]);
      };

      // Safety: if no events arrive within timeout, resolve with []
      firstEventTimer = setTimeout(() => {
        firstEventTimer = null;
        if (!resolved) doResolve();
      }, this._opts.firstEventTimeoutMs);

      // SimplePool expects NostrFilter[] but the source code passes a single filter
      // with `as any`. We do the same for PoolLike compatibility — consumers typically
      // pass SimplePool which accepts both forms.
      pool.subscribeManyEose(urls, [filter] as any, {
        onevent: (event: NostrEvent) => {
          events.push(event);

          // On first event, start the collection window
          if (events.length === 1 && !resolved) {
            if (firstEventTimer) {
              clearTimeout(firstEventTimer);
              firstEventTimer = null;
            }
            collectionTimer = setTimeout(() => {
              collectionTimer = null;
              doResolve();
            }, this._opts.collectionWindowMs);
          }
        },
        onclose: () => {
          if (collectionTimer) clearTimeout(collectionTimer);
          if (firstEventTimer) clearTimeout(firstEventTimer);
          doResolve();

          if (events.length > 0 && onAllComplete) {
            onAllComplete([...events]);
          }
        },
        maxWait: this._opts.maxWaitMs,
      });
    });
  }

  /** Deduplicate events by id. */
  private _dedup(events: NostrEvent[]): NostrEvent[] {
    const seen = new Set<string>();
    const result: NostrEvent[] = [];
    for (const ev of events) {
      if (!seen.has(ev.id)) {
        seen.add(ev.id);
        result.push(ev);
      }
    }
    return result;
  }

  /**
   * Merge compatible filters:
   * 1. Multi-kind author merge: {kinds, authors} (no limit/since/until/tags)
   * 2. Same-kind author merge: {kinds:[K], authors, limit?}
   * 3. IDs merge: {ids}
   * 4. Everything else stays separate
   */
  private _mergeFilters(queries: PendingQuery[]): {
    merged: NostrFilter[];
    queryMap: Map<number, number[]>;
  } {
    const merged: NostrFilter[] = [];
    const queryMap = new Map<number, number[]>();

    const multiKindGroups = new Map<string, { kinds: Set<number>; authors: Set<string>; queryIndices: number[] }>();
    const kindAuthorGroups = new Map<number, { authors: string[]; queryIndices: number[] }>();
    const idGroup: { ids: string[]; queryIndices: number[] } = { ids: [], queryIndices: [] };
    const unmergeable: { filter: NostrFilter; queryIndex: number }[] = [];

    for (let i = 0; i < queries.length; i++) {
      const f = queries[i].filter;

      if (this._isMultiKindMergeable(f)) {
        const authorKey = [...f.authors!].sort().join(',');
        const existing = multiKindGroups.get(authorKey);
        if (existing) {
          for (const k of f.kinds!) existing.kinds.add(k);
          for (const a of f.authors!) existing.authors.add(a);
          existing.queryIndices.push(i);
        } else {
          multiKindGroups.set(authorKey, {
            kinds: new Set(f.kinds!),
            authors: new Set(f.authors!),
            queryIndices: [i],
          });
        }
      } else if (this._isKindAuthorWithLimit(f)) {
        const kind = f.kinds![0];
        const existing = kindAuthorGroups.get(kind);
        if (existing) {
          existing.authors.push(...f.authors!);
          existing.queryIndices.push(i);
        } else {
          kindAuthorGroups.set(kind, {
            authors: [...f.authors!],
            queryIndices: [i],
          });
        }
      } else if (this._isIdsOnlyFilter(f)) {
        idGroup.ids.push(...f.ids!);
        idGroup.queryIndices.push(i);
      } else {
        unmergeable.push({ filter: f, queryIndex: i });
      }
    }

    // Merge multi-kind groups with overlapping authors
    const mkGroups = [...multiKindGroups.values()];
    let didMerge = true;
    while (didMerge) {
      didMerge = false;
      for (let i = 0; i < mkGroups.length; i++) {
        for (let j = i + 1; j < mkGroups.length; j++) {
          let overlaps = false;
          for (const a of mkGroups[j].authors) {
            if (mkGroups[i].authors.has(a)) { overlaps = true; break; }
          }
          if (overlaps) {
            for (const k of mkGroups[j].kinds) mkGroups[i].kinds.add(k);
            for (const a of mkGroups[j].authors) mkGroups[i].authors.add(a);
            mkGroups[i].queryIndices.push(...mkGroups[j].queryIndices);
            mkGroups.splice(j, 1);
            didMerge = true;
            break;
          }
        }
        if (didMerge) break;
      }
    }

    for (const group of mkGroups) {
      const idx = merged.length;
      merged.push({ kinds: [...group.kinds], authors: [...group.authors] });
      queryMap.set(idx, group.queryIndices);
    }

    for (const [kind, group] of kindAuthorGroups) {
      const uniqueAuthors = [...new Set(group.authors)];
      const idx = merged.length;
      merged.push({ kinds: [kind], authors: uniqueAuthors });
      queryMap.set(idx, group.queryIndices);
    }

    if (idGroup.ids.length > 0) {
      const uniqueIds = [...new Set(idGroup.ids)];
      const idx = merged.length;
      merged.push({ ids: uniqueIds });
      queryMap.set(idx, idGroup.queryIndices);
    }

    for (const item of unmergeable) {
      const idx = merged.length;
      merged.push(item.filter);
      queryMap.set(idx, [item.queryIndex]);
    }

    return { merged, queryMap };
  }

  /** Has kinds + authors, NO limit/since/until/tag filters */
  private _isMultiKindMergeable(f: NostrFilter): boolean {
    if (!Array.isArray(f.kinds) || f.kinds.length === 0) return false;
    if (!Array.isArray(f.authors) || f.authors.length === 0) return false;
    if (f.limit || f.since || f.until) return false;
    for (const key of Object.keys(f)) {
      if (key !== 'kinds' && key !== 'authors') return false;
    }
    return true;
  }

  /** {kinds:[K], authors:[...]} with optional limit */
  private _isKindAuthorWithLimit(f: NostrFilter): boolean {
    const keys = Object.keys(f).filter((k) => k !== 'limit');
    if (keys.length !== 2) return false;
    return (
      Array.isArray(f.kinds) &&
      f.kinds.length === 1 &&
      Array.isArray(f.authors) &&
      f.authors.length > 0 &&
      !f.since &&
      !f.until
    );
  }

  /** {ids:[...]} only */
  private _isIdsOnlyFilter(f: NostrFilter): boolean {
    const keys = Object.keys(f);
    return keys.length === 1 && keys[0] === 'ids' && Array.isArray(f.ids);
  }

  /** Canonical dedup key: sorted URLs + sorted canonical filter JSON */
  private _dedupKey(urls: string[], filter: NostrFilter): string {
    const urlPart = [...urls].sort().join(',');
    const sortedKeys = Object.keys(filter).sort();
    const canonical: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      const v = (filter as Record<string, unknown>)[k];
      canonical[k] = Array.isArray(v) ? [...v].sort() : v;
    }
    return urlPart + '|' + JSON.stringify(canonical);
  }

  /** Check if an event matches a given filter */
  private _eventMatchesFilter(ev: NostrEvent, filter: NostrFilter): boolean {
    if (filter.ids && !filter.ids.includes(ev.id)) return false;
    if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
    if (filter.authors && !filter.authors.includes(ev.pubkey)) return false;
    if (filter.since && ev.created_at < filter.since) return false;
    if (filter.until && ev.created_at > filter.until) return false;

    // Tag filters (#e, #p, #t, etc.)
    for (const key of Object.keys(filter)) {
      if (key.startsWith('#') && key.length === 2) {
        const tagName = key[1];
        const values = (filter as Record<string, unknown>)[key] as string[] | undefined;
        if (!values) continue;
        const hasMatch = ev.tags.some(
          (t) => t[0] === tagName && values.includes(t[1])
        );
        if (!hasMatch) return false;
      }
    }

    return true;
  }
}
