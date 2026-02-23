import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { RelayPool } from '../RelayPool';
import { QueryBatcher } from '../QueryBatcher';
import { RelayStats } from '../RelayStats';
import type {
  PoolLike,
  QueryBatcherOptions,
  RelayPoolOptions,
  RelayStatsOptions,
  RelayStatsPersistence,
} from '../types';

export interface RelayProviderProps {
  /** Relay WebSocket URLs */
  urls: string[];
  /** Factory to create the underlying pool (e.g. `() => new SimplePool()`) */
  createPool: () => PoolLike;
  /** Options passed to RelayPool (urls and pool are set automatically) */
  poolOptions?: Partial<Omit<RelayPoolOptions, 'urls' | 'pool'>>;
  /** Options for the internal QueryBatcher */
  batcherOptions?: QueryBatcherOptions;
  /** Persistence adapter for RelayStats (e.g. IndexedDB) */
  statsPersistence?: RelayStatsPersistence;
  /** Options for RelayStats */
  statsOptions?: RelayStatsOptions;
  /** Enable relay stats tracking (default: true) */
  enableStats?: boolean;
  children: ReactNode;
}

export interface RelayContextValue {
  pool: RelayPool;
  batcher: QueryBatcher;
  stats: RelayStats | null;
  statuses: Map<string, boolean>;
  connectedCount: number;
}

const RelayContext = createContext<RelayContextValue | null>(null);

/**
 * Provides RelayPool, QueryBatcher, and RelayStats to the component tree.
 *
 * @example
 * ```tsx
 * import { RelayProvider } from 'nostr-wot-sdk/relay/react';
 * import { SimplePool } from 'nostr-tools';
 *
 * function App() {
 *   return (
 *     <RelayProvider
 *       urls={['wss://relay.damus.io', 'wss://nos.lol']}
 *       createPool={() => new SimplePool()}
 *     >
 *       <Feed />
 *     </RelayProvider>
 *   );
 * }
 * ```
 */
export function RelayProvider({
  urls,
  createPool,
  poolOptions,
  batcherOptions,
  statsPersistence,
  statsOptions,
  enableStats = true,
  children,
}: RelayProviderProps) {
  const [statuses, setStatuses] = useState<Map<string, boolean>>(new Map());
  const [connectedCount, setConnectedCount] = useState(0);

  // Stable refs so we don't recreate instances on every render
  const createPoolRef = useRef(createPool);
  createPoolRef.current = createPool;

  // Create instances once
  const { pool, batcher, stats } = useMemo(() => {
    const statsInst = enableStats ? new RelayStats(statsOptions) : null;

    const batcherInst = new QueryBatcher(undefined, batcherOptions);

    const poolInst = new RelayPool({
      urls,
      batcher: batcherInst,
      ...poolOptions,
      prioritizeUrls: statsInst
        ? (u) => statsInst.getPrioritizedUrls(u)
        : poolOptions?.prioritizeUrls,
      onStatusChange: (s) => {
        setStatuses(new Map(s));
        let count = 0;
        for (const v of s.values()) { if (v) count++; }
        setConnectedCount(count);
        poolOptions?.onStatusChange?.(s);
      },
    });

    return { pool: poolInst, batcher: batcherInst, stats: statsInst };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Intentionally empty — instances are stable for the provider lifetime

  // Initialize pool and stats
  useEffect(() => {
    pool.ensurePool(createPoolRef.current);

    if (stats) {
      stats.init(statsPersistence);
    }

    return () => {
      pool.destroy();
      batcher.destroy();
      stats?.destroy();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount

  // Sync URL changes
  useEffect(() => {
    pool.setUrls(urls);
  }, [pool, urls]);

  const value = useMemo<RelayContextValue>(
    () => ({ pool, batcher, stats, statuses, connectedCount }),
    [pool, batcher, stats, statuses, connectedCount]
  );

  return (
    <RelayContext.Provider value={value}>{children}</RelayContext.Provider>
  );
}

/** Access the full relay context. Throws if used outside RelayProvider. */
export function useRelayContext(): RelayContextValue {
  const ctx = useContext(RelayContext);
  if (!ctx) {
    throw new Error('useRelayContext must be used within a RelayProvider');
  }
  return ctx;
}

/** Access the RelayPool instance. */
export function useRelayPool(): RelayPool {
  return useRelayContext().pool;
}

/** Access the QueryBatcher instance. */
export function useQueryBatcher(): QueryBatcher {
  return useRelayContext().batcher;
}

/** Access the RelayStats instance (null if enableStats=false). */
export function useRelayStats(): RelayStats | null {
  return useRelayContext().stats;
}

/** Access current relay connection statuses. */
export function useRelayStatuses(): { statuses: Map<string, boolean>; connectedCount: number } {
  const { statuses, connectedCount } = useRelayContext();
  return { statuses, connectedCount };
}
