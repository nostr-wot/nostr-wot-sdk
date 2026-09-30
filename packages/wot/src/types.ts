/**
 * Fallback options when the primary oracle is not configured
 */
export interface WoTFallbackOptions {
  /**
   * Oracle API URL
   * @default 'https://wot-oracle.mappingbitcoin.com'
   */
  oracle?: string;
  /**
   * Your pubkey in hex format (required for oracle mode)
   */
  myPubkey: string;
  /**
   * Default maximum search depth
   * @default 3
   */
  maxHops?: number;
  /**
   * Request timeout in milliseconds
   * @default 5000
   */
  timeout?: number;
}

/**
 * A local Web-of-Trust query source that answers distance/membership queries
 * without the remote Oracle. `@nostr-wot/graph`'s `WotGraph.asWoTSource()`
 * returns a structurally-compatible object.
 */
export interface WoTLocalSource {
  /** Distance in hops to `target`, or `null` if unreached/unknown. */
  getDistance(target: string): number | null;
  /** Whether `target` is within `maxHops`. */
  isInMyWoT(target: string, maxHops?: number): boolean;
  /** Trusted subset of `pubkeys`, sorted by score descending. */
  filterByWoT(pubkeys: string[], opts?: { maxHops?: number }): string[];
}

/**
 * Options for WoT constructor
 */
export interface WoTOptions {
  /**
   * Oracle API URL
   * @default 'https://wot-oracle.mappingbitcoin.com'
   */
  oracle?: string;
  /**
   * Your pubkey in hex format (required for oracle queries)
   */
  myPubkey?: string;
  /**
   * Default maximum search depth
   * @default 3
   */
  maxHops?: number;
  /**
   * Request timeout in milliseconds
   * @default 5000
   */
  timeout?: number;
  /**
   * Fallback configuration. Recommended to provide myPubkey here for
   * oracle queries.
   */
  fallback?: WoTFallbackOptions;
  /**
   * Optional local query source (e.g. from `@nostr-wot/graph`). When provided,
   * `getDistance`, `isInMyWoT`, and `filterByWoT` resolve from it instead of
   * the Oracle. Additive: all other methods still use the Oracle.
   */
  source?: WoTLocalSource;
}

/**
 * Options for query methods
 */
export interface QueryOptions {
  /**
   * Maximum search depth for this query.
   *
   * Clamped to the 1..5 the Oracle accepts before it is sent, because a value
   * outside that range is refused with a 400 rather than answered at a
   * different depth.
   */
  maxHops?: number;
  /**
   * Request timeout in milliseconds for this query
   */
  timeout?: number;
  /**
   * Ask the Oracle for the `bridges` on a details query.
   *
   * Off by default, matching the Oracle's own `include_bridges`, since it is
   * extra graph work for a field most callers do not read.
   */
  includeBridges?: boolean;
}

/**
 * Options for getDistanceBatch
 */
export interface DistanceBatchOptions {
  /**
   * Include path count in results
   */
  includePaths?: boolean;
}

/**
 * Full distance result with additional details (from oracle)
 */
export interface DistanceResult {
  /**
   * Number of hops to target
   */
  hops: number;
  /**
   * Number of shortest directed paths to the target, from the Oracle's
   * `path_count`. It counts shortest paths whether or not bridges were
   * requested, and saturates rather than overflowing.
   */
  paths: number;
  /**
   * The Oracle's `bridges`: the meeting nodes of its bidirectional search, which
   * its documentation is explicit are "not the entire path or disjoint-path
   * certificates".
   *
   * Present only when the query passed `includeBridges`, since the Oracle omits
   * the field unless it was asked for.
   */
  bridges?: string[];
  /**
   * Whether target follows source back, from the Oracle's `mutual_follow`.
   */
  mutual?: boolean;
}

/**
 * Result for batch check operation
 */
export interface BatchResult {
  /**
   * Target pubkey
   */
  pubkey: string;
  /**
   * Distance in hops, null if not reachable
   */
  distance: number | null;
  /**
   * Whether in WoT within maxHops
   */
  inWoT: boolean;
}
