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
