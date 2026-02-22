import { createSignal, createEffect, createMemo, on, type Accessor } from 'solid-js';
import { useWoTContext } from './context';
import type { DistanceResult, QueryOptions } from '../types';

/**
 * Result from createWoT primitive
 */
export interface WoTResult {
  /**
   * Distance in hops to target, null if not in WoT
   */
  distance: Accessor<number | null>;
  /**
   * Trust score (0-1)
   */
  score: Accessor<number>;
  /**
   * Whether data is currently loading
   */
  loading: Accessor<boolean>;
  /**
   * Error if query failed
   */
  error: Accessor<Error | null>;
  /**
   * Full details (hops, paths, bridges, mutual)
   */
  details: Accessor<DistanceResult | null>;
  /**
   * Refetch data
   */
  refetch: () => void;
}

/**
 * Options for WoT primitives
 */
export interface WoTQueryOptions extends QueryOptions {
  /**
   * Skip the query (useful for conditional fetching)
   */
  skip?: boolean;
}

/**
 * Primitive to get WoT data for a pubkey
 *
 * @param pubkey - Accessor for target pubkey
 * @param options - Query options
 * @returns WoT data and loading state
 *
 * @example
 * ```tsx
 * function Profile(props: { pubkey: string }) {
 *   const wot = createWoT(() => props.pubkey);
 *
 *   return (
 *     <Show when={!wot.loading()} fallback={<Spinner />}>
 *       <Show when={wot.distance() !== null} fallback={<span>Not in your network</span>}>
 *         <span>{wot.distance()} hops away (score: {wot.score().toFixed(2)})</span>
 *       </Show>
 *     </Show>
 *   );
 * }
 * ```
 */
export function createWoT(
  pubkey: Accessor<string | undefined>,
  options?: WoTQueryOptions
): WoTResult {
  const { wot, isReady } = useWoTContext();
  const [distance, setDistance] = createSignal<number | null>(null);
  const [score, setScore] = createSignal(0);
  const [details, setDetails] = createSignal<DistanceResult | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<Error | null>(null);
  let fetchId = 0;

  const skip = options?.skip ?? false;

  const fetchData = async () => {
    const wotInstance = wot();
    const pk = pubkey();

    if (!wotInstance || !pk || skip) {
      setLoading(false);
      return;
    }

    const currentFetchId = ++fetchId;
    setLoading(true);
    setError(null);

    try {
      const [distResult, scoreResult, detailsResult] = await Promise.all([
        wotInstance.getDistance(pk, options),
        wotInstance.getTrustScore(pk),
        wotInstance.getDetails(pk, options),
      ]);

      // Only update if this is still the latest request
      if (currentFetchId === fetchId) {
        setDistance(distResult);
        setScore(scoreResult);
        setDetails(detailsResult);
        setLoading(false);
      }
    } catch (err) {
      if (currentFetchId === fetchId) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
        setLoading(false);
      }
    }
  };

  createEffect(
    on([isReady, pubkey], () => {
      if (isReady() && !skip) {
        fetchData();
      }
    })
  );

  return {
    distance,
    score,
    loading,
    error,
    details,
    refetch: fetchData,
  };
}

/**
 * Result from createIsInWoT primitive
 */
export interface IsInWoTResult {
  /**
   * Whether target is in WoT
   */
  inWoT: Accessor<boolean>;
  /**
   * Whether data is currently loading
   */
  loading: Accessor<boolean>;
  /**
   * Error if query failed
   */
  error: Accessor<Error | null>;
  /**
   * Refetch data
   */
  refetch: () => void;
}

/**
 * Primitive to check if a pubkey is in your WoT
 *
 * @param pubkey - Accessor for target pubkey
 * @param options - Query options
 * @returns Whether target is in WoT
 *
 * @example
 * ```tsx
 * function TrustBadge(props: { pubkey: string }) {
 *   const { inWoT, loading } = createIsInWoT(() => props.pubkey, { maxHops: 2 });
 *
 *   return (
 *     <Show when={!loading() && inWoT()}>
 *       <span>Trusted</span>
 *     </Show>
 *   );
 * }
 * ```
 */
export function createIsInWoT(
  pubkey: Accessor<string | undefined>,
  options?: WoTQueryOptions
): IsInWoTResult {
  const { wot, isReady } = useWoTContext();
  const [inWoT, setInWoT] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<Error | null>(null);
  let fetchId = 0;

  const skip = options?.skip ?? false;

  const fetchData = async () => {
    const wotInstance = wot();
    const pk = pubkey();

    if (!wotInstance || !pk || skip) {
      setLoading(false);
      return;
    }

    const currentFetchId = ++fetchId;
    setLoading(true);
    setError(null);

    try {
      const result = await wotInstance.isInMyWoT(pk, options);

      if (currentFetchId === fetchId) {
        setInWoT(result);
        setLoading(false);
      }
    } catch (err) {
      if (currentFetchId === fetchId) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
        setLoading(false);
      }
    }
  };

  createEffect(
    on([isReady, pubkey], () => {
      if (isReady() && !skip) {
        fetchData();
      }
    })
  );

  return {
    inWoT,
    loading,
    error,
    refetch: fetchData,
  };
}

/**
 * Result from createTrustScore primitive
 */
export interface TrustScoreResult {
  /**
   * Trust score (0-1)
   */
  score: Accessor<number>;
  /**
   * Whether data is currently loading
   */
  loading: Accessor<boolean>;
  /**
   * Error if query failed
   */
  error: Accessor<Error | null>;
  /**
   * Refetch data
   */
  refetch: () => void;
}

/**
 * Primitive to get trust score for a pubkey
 *
 * @param pubkey - Accessor for target pubkey
 * @param options - Query options
 * @returns Trust score
 *
 * @example
 * ```tsx
 * function TrustMeter(props: { pubkey: string }) {
 *   const { score, loading } = createTrustScore(() => props.pubkey);
 *
 *   return (
 *     <Show when={!loading()} fallback={<Spinner />}>
 *       <ProgressBar value={score()} />
 *     </Show>
 *   );
 * }
 * ```
 */
export function createTrustScore(
  pubkey: Accessor<string | undefined>,
  options?: WoTQueryOptions
): TrustScoreResult {
  const { wot, isReady } = useWoTContext();
  const [score, setScore] = createSignal(0);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<Error | null>(null);
  let fetchId = 0;

  const skip = options?.skip ?? false;

  const fetchData = async () => {
    const wotInstance = wot();
    const pk = pubkey();

    if (!wotInstance || !pk || skip) {
      setLoading(false);
      return;
    }

    const currentFetchId = ++fetchId;
    setLoading(true);
    setError(null);

    try {
      const result = await wotInstance.getTrustScore(pk);

      if (currentFetchId === fetchId) {
        setScore(result);
        setLoading(false);
      }
    } catch (err) {
      if (currentFetchId === fetchId) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
        setLoading(false);
      }
    }
  };

  createEffect(
    on([isReady, pubkey], () => {
      if (isReady() && !skip) {
        fetchData();
      }
    })
  );

  return {
    score,
    loading,
    error,
    refetch: fetchData,
  };
}

/**
 * Result from createBatchWoT primitive
 */
export interface BatchWoTResult {
  /**
   * Map of pubkey to result
   */
  results: Accessor<
    Map<
      string,
      {
        distance: number | null;
        score: number;
        inWoT: boolean;
      }
    >
  >;
  /**
   * Whether data is currently loading
   */
  loading: Accessor<boolean>;
  /**
   * Error if query failed
   */
  error: Accessor<Error | null>;
  /**
   * Refetch data
   */
  refetch: () => void;
}

/**
 * Primitive to batch check multiple pubkeys
 *
 * @param pubkeys - Accessor for array of target pubkeys
 * @param options - Query options
 * @returns Map of results
 *
 * @example
 * ```tsx
 * function UserList(props: { pubkeys: string[] }) {
 *   const { results, loading } = createBatchWoT(() => props.pubkeys);
 *
 *   return (
 *     <ul>
 *       <For each={props.pubkeys}>
 *         {(pk) => {
 *           const data = results().get(pk);
 *           return (
 *             <li>
 *               {data?.inWoT ? 'Trusted' : 'Unknown'}
 *             </li>
 *           );
 *         }}
 *       </For>
 *     </ul>
 *   );
 * }
 * ```
 */
export function createBatchWoT(
  pubkeys: Accessor<string[]>,
  options?: WoTQueryOptions
): BatchWoTResult {
  const { wot, isReady } = useWoTContext();
  const [results, setResults] = createSignal<
    Map<string, { distance: number | null; score: number; inWoT: boolean }>
  >(new Map());
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<Error | null>(null);
  let fetchId = 0;

  const skip = options?.skip ?? false;

  const fetchData = async () => {
    const wotInstance = wot();
    const pks = pubkeys();

    if (!wotInstance || pks.length === 0 || skip) {
      setLoading(false);
      return;
    }

    const currentFetchId = ++fetchId;
    setLoading(true);
    setError(null);

    try {
      const batchResults = await wotInstance.batchCheck(pks, options);

      if (currentFetchId === fetchId) {
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
      if (currentFetchId === fetchId) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
        setLoading(false);
      }
    }
  };

  // Use a memo to create a stable key for pubkeys array
  const pubkeysKey = createMemo(() => pubkeys().join(','));

  createEffect(
    on([isReady, pubkeysKey], () => {
      if (isReady() && !skip) {
        fetchData();
      }
    })
  );

  return {
    results,
    loading,
    error,
    refetch: fetchData,
  };
}
