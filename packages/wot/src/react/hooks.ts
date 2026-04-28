import { useState, useEffect, useCallback, useRef } from 'react';
import { useWoTContext } from './context';
import type { DistanceResult, QueryOptions } from '../types';

/**
 * Result from useWoT hook
 */
export interface UseWoTResult {
  /**
   * Distance in hops to target, null if not in WoT
   */
  distance: number | null;
  /**
   * Trust score (0-1)
   */
  score: number;
  /**
   * Whether data is currently loading
   */
  loading: boolean;
  /**
   * Error if query failed
   */
  error: Error | null;
  /**
   * Full details (hops, paths, bridges, mutual)
   */
  details: DistanceResult | null;
  /**
   * Refetch data
   */
  refetch: () => void;
}

/**
 * Options for useWoT hook
 */
export interface UseWoTOptions extends QueryOptions {
  /**
   * Skip the query (useful for conditional fetching)
   */
  skip?: boolean;
}

/**
 * Hook to get WoT data for a pubkey
 *
 * @param pubkey - Target pubkey
 * @param options - Query options
 * @returns WoT data and loading state
 *
 * @example
 * ```tsx
 * function Profile({ pubkey }) {
 *   const { distance, score, loading } = useWoT(pubkey);
 *
 *   if (loading) return <Spinner />;
 *
 *   return (
 *     <div>
 *       {distance !== null ? (
 *         <span>{distance} hops away (score: {score.toFixed(2)})</span>
 *       ) : (
 *         <span>Not in your network</span>
 *       )}
 *     </div>
 *   );
 * }
 * ```
 */
export function useWoT(pubkey: string, options?: UseWoTOptions): UseWoTResult {
  const { wot, isReady } = useWoTContext();
  const [distance, setDistance] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [details, setDetails] = useState<DistanceResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const fetchIdRef = useRef(0);

  const skip = options?.skip ?? false;

  const fetchData = useCallback(async () => {
    if (!wot || !pubkey || skip) {
      setLoading(false);
      return;
    }

    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const [distResult, scoreResult, detailsResult] = await Promise.all([
        wot.getDistance(pubkey, options),
        wot.getTrustScore(pubkey),
        wot.getDetails(pubkey, options),
      ]);

      // Only update if this is still the latest request
      if (fetchId === fetchIdRef.current) {
        setDistance(distResult);
        setScore(scoreResult);
        setDetails(detailsResult);
        setLoading(false);
      }
    } catch (err) {
      if (fetchId === fetchIdRef.current) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
        setLoading(false);
      }
    }
  }, [wot, pubkey, skip, options?.maxHops, options?.timeout]);

  useEffect(() => {
    if (isReady && !skip) {
      fetchData();
    }
  }, [isReady, fetchData, skip]);

  const refetch = useCallback(() => {
    fetchData();
  }, [fetchData]);

  return {
    distance,
    score,
    loading,
    error,
    details,
    refetch,
  };
}

/**
 * Result from useIsInWoT hook
 */
export interface UseIsInWoTResult {
  /**
   * Whether target is in WoT
   */
  inWoT: boolean;
  /**
   * Whether data is currently loading
   */
  loading: boolean;
  /**
   * Error if query failed
   */
  error: Error | null;
  /**
   * Refetch data
   */
  refetch: () => void;
}

/**
 * Hook to check if a pubkey is in your WoT
 *
 * @param pubkey - Target pubkey
 * @param options - Query options
 * @returns Whether target is in WoT
 *
 * @example
 * ```tsx
 * function TrustBadge({ pubkey }) {
 *   const { inWoT, loading } = useIsInWoT(pubkey, { maxHops: 2 });
 *
 *   if (loading) return null;
 *
 *   return inWoT ? <span>Trusted</span> : null;
 * }
 * ```
 */
export function useIsInWoT(
  pubkey: string,
  options?: UseWoTOptions
): UseIsInWoTResult {
  const { wot, isReady } = useWoTContext();
  const [inWoT, setInWoT] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const fetchIdRef = useRef(0);

  const skip = options?.skip ?? false;

  const fetchData = useCallback(async () => {
    if (!wot || !pubkey || skip) {
      setLoading(false);
      return;
    }

    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const result = await wot.isInMyWoT(pubkey, options);

      if (fetchId === fetchIdRef.current) {
        setInWoT(result);
        setLoading(false);
      }
    } catch (err) {
      if (fetchId === fetchIdRef.current) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
        setLoading(false);
      }
    }
  }, [wot, pubkey, skip, options?.maxHops, options?.timeout]);

  useEffect(() => {
    if (isReady && !skip) {
      fetchData();
    }
  }, [isReady, fetchData, skip]);

  const refetch = useCallback(() => {
    fetchData();
  }, [fetchData]);

  return {
    inWoT,
    loading,
    error,
    refetch,
  };
}

/**
 * Result from useTrustScore hook
 */
export interface UseTrustScoreResult {
  /**
   * Trust score (0-1)
   */
  score: number;
  /**
   * Whether data is currently loading
   */
  loading: boolean;
  /**
   * Error if query failed
   */
  error: Error | null;
  /**
   * Refetch data
   */
  refetch: () => void;
}

/**
 * Hook to get trust score for a pubkey
 *
 * @param pubkey - Target pubkey
 * @param options - Query options
 * @returns Trust score
 *
 * @example
 * ```tsx
 * function TrustMeter({ pubkey }) {
 *   const { score, loading } = useTrustScore(pubkey);
 *
 *   if (loading) return <Spinner />;
 *
 *   return <ProgressBar value={score} />;
 * }
 * ```
 */
export function useTrustScore(
  pubkey: string,
  options?: UseWoTOptions
): UseTrustScoreResult {
  const { wot, isReady } = useWoTContext();
  const [score, setScore] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const fetchIdRef = useRef(0);

  const skip = options?.skip ?? false;

  const fetchData = useCallback(async () => {
    if (!wot || !pubkey || skip) {
      setLoading(false);
      return;
    }

    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const result = await wot.getTrustScore(pubkey);

      if (fetchId === fetchIdRef.current) {
        setScore(result);
        setLoading(false);
      }
    } catch (err) {
      if (fetchId === fetchIdRef.current) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
        setLoading(false);
      }
    }
  }, [wot, pubkey, skip]);

  useEffect(() => {
    if (isReady && !skip) {
      fetchData();
    }
  }, [isReady, fetchData, skip]);

  const refetch = useCallback(() => {
    fetchData();
  }, [fetchData]);

  return {
    score,
    loading,
    error,
    refetch,
  };
}

/**
 * Result from useBatchWoT hook
 */
export interface UseBatchWoTResult {
  /**
   * Map of pubkey to result
   */
  results: Map<
    string,
    {
      distance: number | null;
      score: number;
      inWoT: boolean;
    }
  >;
  /**
   * Whether data is currently loading
   */
  loading: boolean;
  /**
   * Error if query failed
   */
  error: Error | null;
  /**
   * Refetch data
   */
  refetch: () => void;
}

/**
 * Hook to batch check multiple pubkeys
 *
 * @param pubkeys - Array of target pubkeys
 * @param options - Query options
 * @returns Map of results
 *
 * @example
 * ```tsx
 * function UserList({ pubkeys }) {
 *   const { results, loading } = useBatchWoT(pubkeys);
 *
 *   return (
 *     <ul>
 *       {pubkeys.map(pk => {
 *         const data = results.get(pk);
 *         return (
 *           <li key={pk}>
 *             {data?.inWoT ? 'Trusted' : 'Unknown'}
 *           </li>
 *         );
 *       })}
 *     </ul>
 *   );
 * }
 * ```
 */
export function useBatchWoT(
  pubkeys: string[],
  options?: UseWoTOptions
): UseBatchWoTResult {
  const { wot, isReady } = useWoTContext();
  const [results, setResults] = useState<UseBatchWoTResult['results']>(
    new Map()
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const fetchIdRef = useRef(0);

  const skip = options?.skip ?? false;
  const pubkeysKey = pubkeys.join(',');

  const fetchData = useCallback(async () => {
    if (!wot || pubkeys.length === 0 || skip) {
      setLoading(false);
      return;
    }

    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const batchResults = await wot.batchCheck(pubkeys, options);

      if (fetchId === fetchIdRef.current) {
        const mapped = new Map<
          string,
          { distance: number | null; score: number; inWoT: boolean }
        >();
        for (const [pk, result] of batchResults) {
          mapped.set(pk, {
            distance: result.distance,
            score: result.score,
            inWoT: result.inWoT,
          });
        }
        setResults(mapped);
        setLoading(false);
      }
    } catch (err) {
      if (fetchId === fetchIdRef.current) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
        setLoading(false);
      }
    }
  }, [wot, pubkeysKey, skip, options?.maxHops, options?.timeout]);

  useEffect(() => {
    if (isReady && !skip) {
      fetchData();
    }
  }, [isReady, fetchData, skip]);

  const refetch = useCallback(() => {
    fetchData();
  }, [fetchData]);

  return {
    results,
    loading,
    error,
    refetch,
  };
}
