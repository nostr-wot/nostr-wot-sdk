/**
 * Configuration for trust score calculation (used by extension)
 */
export interface ScoringConfig {
  /**
   * Score multiplier per hop distance
   * Key is the number of hops, value is the multiplier
   */
  distanceWeights: Record<number, number>;
  /**
   * Bonus value for mutual follows
   */
  mutualBonus: number;
  /**
   * Bonus value per additional path
   */
  pathBonus: number;
  /**
   * Maximum total path bonus
   */
  maxPathBonus: number;
}

/**
 * Fallback options when extension is not available
 */
export interface WoTFallbackOptions {
  /**
   * Oracle API URL
   * @default 'https://nostr-wot.com'
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
   * Oracle API URL (used when extension is not available)
   * @default 'https://nostr-wot.com'
   */
  oracle?: string;
  /**
   * Your pubkey in hex format
   * Optional - will be fetched from extension when available
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
   * Fallback configuration when extension is not available.
   * Recommended to provide myPubkey here for oracle fallback.
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
 * Distance result from extension (simpler)
 */
export interface ExtensionDistanceResult {
  /**
   * Number of hops to target
   */
  hops: number;
  /**
   * Number of distinct paths to target
   */
  paths: number;
}

/**
 * Full distance result with additional details (from oracle)
 */
export interface DistanceResult extends ExtensionDistanceResult {
  /**
   * Pubkeys that bridge to the target (first hop on paths)
   * Note: Only available from oracle API, not from extension
   */
  bridges?: string[];
  /**
   * Whether target follows source back
   * Note: Only available from oracle API, not from extension
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
   * Trust score (0-1)
   */
  score: number;
  /**
   * Whether in WoT within maxHops
   */
  inWoT: boolean;
}

/**
 * Nostr event structure (kind 3 - contact list)
 */
export interface NostrContactEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: 3;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Extension configuration returned by getConfig()
 */
export interface ExtensionConfig {
  /**
   * Default maximum search depth
   */
  maxHops: number;
  /**
   * Request timeout in milliseconds
   */
  timeout: number;
  /**
   * Trust score calculation configuration
   */
  scoring: Partial<ScoringConfig>;
}

/**
 * Extension status returned by isConfigured()
 */
export interface ExtensionStatus {
  /**
   * Whether the extension is configured and ready
   */
  configured: boolean;
  /**
   * Operating mode
   */
  mode: 'remote' | 'local' | 'hybrid';
  /**
   * Whether local graph data is available
   */
  hasLocalGraph: boolean;
}

/**
 * Graph statistics returned by getStats()
 */
export interface GraphStats {
  /**
   * Number of nodes (pubkeys) in the graph
   */
  nodes: number;
  /**
   * Number of edges (follow relationships) in the graph
   */
  edges: number;
  /**
   * Timestamp of last sync, or null if never synced
   */
  lastSync: number | null;
  /**
   * Human-readable size of the graph data
   */
  size: string;
}

/**
 * Extension WoT interface (window.nostr.wot)
 * Based on https://github.com/nostr-wot/nostr-wot-extension
 */
export interface NostrWoTExtension {
  // === Core Methods ===

  /**
   * Get shortest path length to target pubkey
   * @returns Number of hops, or null if not connected
   */
  getDistance(target: string): Promise<number | null>;

  /**
   * Check if target is within your Web of Trust
   * @param target - Target pubkey to check
   * @param maxHops - Optional max hops (uses extension config default if not specified)
   * @returns true if target is within maxHops
   */
  isInMyWoT(target: string, maxHops?: number): Promise<boolean>;

  /**
   * Get distance between any two pubkeys
   * @returns Number of hops between the pubkeys, or null if not connected
   */
  getDistanceBetween(from: string, to: string): Promise<number | null>;

  /**
   * Get computed trust score based on distance and path count
   * @returns Trust score between 0 and 1, or null if not connected
   */
  getTrustScore(target: string): Promise<number | null>;

  /**
   * Get distance and path count details
   * @returns Object with hops and paths count, or null if not connected
   */
  getDetails(target: string): Promise<ExtensionDistanceResult | null>;

  /**
   * Get current extension configuration
   * @returns Configuration object with maxHops, timeout, and scoring
   */
  getConfig(): Promise<ExtensionConfig>;

  // === Batch Operations ===

  /**
   * Get distances for multiple pubkeys in a single call
   * @param targets - Array of target pubkeys
   * @param includePaths - When true, includes path count for each target
   * @returns Map of pubkey to hop count (or { hops, paths } if includePaths is true)
   */
  getDistanceBatch(
    targets: string[],
    includePaths?: false
  ): Promise<Record<string, number | null>>;
  getDistanceBatch(
    targets: string[],
    includePaths: true
  ): Promise<Record<string, { hops: number; paths: number } | null>>;
  getDistanceBatch(
    targets: string[],
    includePaths?: boolean
  ): Promise<Record<string, number | { hops: number; paths: number } | null>>;

  /**
   * Get trust scores for multiple pubkeys in a single call
   * @returns Map of pubkey to trust score (null if not connected)
   */
  getTrustScoreBatch(targets: string[]): Promise<Record<string, number | null>>;

  /**
   * Filter a list of pubkeys to only those within the Web of Trust
   * @param pubkeys - Array of pubkeys to filter
   * @param maxHops - Optional max hops override
   * @returns Filtered array of pubkeys within WoT
   */
  filterByWoT(pubkeys: string[], maxHops?: number): Promise<string[]>;

  // === User Info ===

  /**
   * Get the configured user's pubkey
   * @returns User's pubkey or null if not configured
   */
  getMyPubkey(): Promise<string | null>;

  /**
   * Check if the extension is configured and ready
   * @returns Status object with configuration state
   */
  isConfigured(): Promise<ExtensionStatus>;

  // === Graph Queries ===

  /**
   * Get the follow list for a pubkey
   * @param pubkey - Optional, defaults to user's pubkey
   * @returns Array of followed pubkeys
   */
  getFollows(pubkey?: string): Promise<string[]>;

  /**
   * Get mutual follows between the user and a target
   * @returns Array of common followed pubkeys
   */
  getCommonFollows(pubkey: string): Promise<string[]>;

  /**
   * Get graph statistics
   * @returns Stats object with node/edge counts and sync info
   */
  getStats(): Promise<GraphStats>;

  // === Path Info ===

  /**
   * Get an actual path from the user to the target
   * @returns Array of pubkeys [user, ..., target], or null if not connected
   */
  getPath(target: string): Promise<string[] | null>;
}

/**
 * Window with nostr extension
 */
export interface NostrWindow extends Window {
  nostr?: {
    wot?: NostrWoTExtension;
    getPublicKey?: () => Promise<string>;
  };
}
