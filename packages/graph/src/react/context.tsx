import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { WotGraph, type WotGraphOptions } from '../wot-graph';
import type { CrawlOptions, CrawlProgress, CrawlResult, DistanceInfo } from '../types';

export interface WotGraphProviderProps extends WotGraphOptions {
  children: ReactNode;
}

export interface WotGraphContextValue {
  graph: WotGraph;
  ready: boolean;
  crawling: boolean;
  setCrawling: (v: boolean) => void;
  /** Bumps whenever the graph changes (crawl / load / clear). */
  version: number;
}

const WotGraphContext = createContext<WotGraphContextValue | null>(null);

/**
 * Constructs and holds a {@link WotGraph}, calling `load()` on mount.
 *
 * @example
 * ```tsx
 * <WotGraphProvider namespace="myapp" relays={["wss://relay.damus.io"]}>
 *   <App />
 * </WotGraphProvider>
 * ```
 */
export function WotGraphProvider({ children, ...options }: WotGraphProviderProps) {
  const [ready, setReady] = useState(false);
  const [crawling, setCrawling] = useState(false);
  const [version, setVersion] = useState(0);

  // Instance is stable for the provider lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const graph = useMemo(() => new WotGraph(options), []);

  useEffect(() => {
    let mounted = true;
    const unsub = graph.onChange(() => {
      if (mounted) setVersion((v) => v + 1);
    });
    graph
      .load()
      .catch(() => {
        /* keep ready=true so queries can still run on an empty graph */
      })
      .finally(() => {
        if (mounted) setReady(true);
      });
    return () => {
      mounted = false;
      unsub();
      graph.stop();
      graph.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<WotGraphContextValue>(
    () => ({ graph, ready, crawling, setCrawling, version }),
    [graph, ready, crawling, version],
  );

  return <WotGraphContext.Provider value={value}>{children}</WotGraphContext.Provider>;
}

function useWotGraphContext(): WotGraphContextValue {
  const ctx = useContext(WotGraphContext);
  if (!ctx) throw new Error('useWotGraph must be used within a WotGraphProvider');
  return ctx;
}

/** The {@link WotGraph} instance plus `{ ready, crawling }` state. */
export function useWotGraph(): {
  graph: WotGraph;
  ready: boolean;
  crawling: boolean;
} {
  const { graph, ready, crawling } = useWotGraphContext();
  return { graph, ready, crawling };
}

/** `{ hops, paths } | null` for a pubkey; recomputes when the graph changes. */
export function useDistance(pubkey: string | null | undefined): DistanceInfo | null {
  const { graph, version } = useWotGraphContext();
  return useMemo(
    () => (pubkey ? graph.getDistance(pubkey) : null),
    // version participates so queries refresh after a crawl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, pubkey, version],
  );
}

/** `{ crawl, stop, progress, crawling, error }` for driving a crawl from UI. */
export function useCrawl(): {
  crawl: (rootPubkey: string, opts?: CrawlOptions) => Promise<CrawlResult | null>;
  stop: () => void;
  progress: CrawlProgress | null;
  crawling: boolean;
  error: Error | null;
} {
  const { graph, crawling, setCrawling } = useWotGraphContext();
  const [progress, setProgress] = useState<CrawlProgress | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const crawl = useCallback(
    async (rootPubkey: string, opts?: CrawlOptions): Promise<CrawlResult | null> => {
      setError(null);
      setCrawling(true);
      try {
        const result = await graph.crawl(rootPubkey, {
          ...opts,
          onProgress: (p) => {
            if (mounted.current) setProgress(p);
            opts?.onProgress?.(p);
          },
        });
        return result;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (mounted.current) setError(e);
        return null;
      } finally {
        if (mounted.current) setCrawling(false);
      }
    },
    [graph, setCrawling],
  );

  const stop = useCallback(() => graph.stop(), [graph]);

  return { crawl, stop, progress, crawling, error };
}
