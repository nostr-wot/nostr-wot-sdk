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
   * Maximum search depth for this query
   */
  maxHops?: number;
  /**
   * Request timeout in milliseconds for this query
   */
  timeout?: number;
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
   * Number of distinct paths to target
   */
  paths: number;
  /**
   * Pubkeys that bridge to the target (first hop on paths)
   * Note: Only available from oracle API.
   */
  bridges?: string[];
  /**
   * Whether target follows source back
   * Note: Only available from oracle API.
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
