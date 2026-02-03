import type {
  WoTOptions,
  WoTFallbackOptions,
  ScoringConfig,
  QueryOptions,
  DistanceResult,
  BatchResult,
  NostrWindow,
  NostrWoTExtension,
  ExtensionConfig,
  ExtensionStatus,
  GraphStats,
} from './types';
import {
  NetworkError,
  NotFoundError,
  TimeoutError,
  ValidationError,
} from './errors';
import {
  DEFAULT_ORACLE,
  DEFAULT_MAX_HOPS,
  DEFAULT_TIMEOUT,
  MAX_BATCH_SIZE,
  mergeScoringConfig,
  calculateTrustScore,
  isValidPubkey,
  isValidOracleUrl,
  normalizePubkey,
  fetchWithTimeout,
  chunk,
} from './utils';

/**
 * WoT (Web of Trust) SDK for querying Nostr trust relationships
 *
 * When useExtension is true, the SDK will always use the extension's
 * pubkey and local data when available. This provides the best experience
 * as the extension syncs and caches the follow graph locally.
 */
export class WoT {
  private readonly oracle: string;
  private readonly fallbackPubkey: string | null;
  private readonly maxHops: number;
  private readonly timeout: number;
  private readonly scoring: ScoringConfig;
  private readonly useExtension: boolean;
  private readonly fallbackOptions: WoTFallbackOptions | null;
  private extension: NostrWoTExtension | null = null;
  private extensionChecked = false;
  private extensionPubkey: string | null = null;

  constructor(options: WoTOptions) {
    this.useExtension = options.useExtension ?? false;
    this.fallbackOptions = options.fallback ?? null;

    // When using extension, myPubkey is optional (will be fetched from extension)
    // When not using extension, myPubkey is required
    if (!this.useExtension) {
      if (!options.myPubkey) {
        throw new ValidationError('myPubkey is required when not using extension', 'myPubkey');
      }
      if (!isValidPubkey(options.myPubkey)) {
        throw new ValidationError(
          'myPubkey must be a valid 64-character hex string',
          'myPubkey'
        );
      }
      this.fallbackPubkey = normalizePubkey(options.myPubkey);
    } else {
      // Extension mode - use provided pubkey or fallback pubkey for oracle fallback
      if (options.myPubkey && isValidPubkey(options.myPubkey)) {
        this.fallbackPubkey = normalizePubkey(options.myPubkey);
      } else if (this.fallbackOptions?.myPubkey) {
        this.fallbackPubkey = normalizePubkey(this.fallbackOptions.myPubkey);
      } else {
        this.fallbackPubkey = null;
      }
    }

    const oracleUrl = options.oracle ?? this.fallbackOptions?.oracle ?? DEFAULT_ORACLE;
    if (!isValidOracleUrl(oracleUrl)) {
      throw new ValidationError('oracle must be a valid HTTPS URL', 'oracle');
    }
    this.oracle = oracleUrl;
    this.maxHops = options.maxHops ?? this.fallbackOptions?.maxHops ?? DEFAULT_MAX_HOPS;
    this.timeout = options.timeout ?? this.fallbackOptions?.timeout ?? DEFAULT_TIMEOUT;
    this.scoring = mergeScoringConfig(options.scoring ?? this.fallbackOptions?.scoring);
  }

  /**
   * Checks if browser extension is available and returns it
   */
  private async getExtension(): Promise<NostrWoTExtension | null> {
    if (!this.useExtension) return null;
    if (this.extensionChecked) return this.extension;

    this.extensionChecked = true;

    // Check if running in browser
    if (typeof window === 'undefined') return null;

    const win = window as NostrWindow;
    if (win.nostr?.wot) {
      this.extension = win.nostr.wot;
      // Get pubkey from extension's getMyPubkey()
      try {
        this.extensionPubkey = await this.extension.getMyPubkey();
      } catch {
        // Fall back to NIP-07 window.nostr.getPublicKey()
        if (win.nostr?.getPublicKey) {
          try {
            this.extensionPubkey = await win.nostr.getPublicKey();
          } catch {
            // Ignore - will use fallback pubkey
          }
        }
      }
    }

    return this.extension;
  }

  /**
   * Gets the effective pubkey (from extension or fallback)
   */
  private async getEffectivePubkey(): Promise<string> {
    // Try to get extension first
    await this.getExtension();

    // Use extension pubkey if available
    if (this.extensionPubkey) {
      return this.extensionPubkey;
    }

    // Fall back to provided pubkey
    if (this.fallbackPubkey) {
      return this.fallbackPubkey;
    }

    throw new ValidationError(
      'No pubkey available. Either install the WoT extension or provide myPubkey/fallback options.',
      'myPubkey'
    );
  }

  /**
   * Makes an API request to the oracle
   */
  private async apiRequest<T>(
    endpoint: string,
    options: QueryOptions = {}
  ): Promise<T> {
    const timeout = options.timeout ?? this.timeout;
    const url = `${this.oracle}/api${endpoint}`;

    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        timeout,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new TimeoutError(timeout);
        }
        throw new NetworkError(error.message, undefined, url);
      }
      throw new NetworkError('Unknown network error', undefined, url);
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new NotFoundError('', `Resource not found: ${endpoint}`);
      }
      throw new NetworkError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        url
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Validates a pubkey parameter
   */
  private validatePubkey(pubkey: string, paramName: string): string {
    if (!pubkey) {
      throw new ValidationError(`${paramName} is required`, paramName);
    }
    if (!isValidPubkey(pubkey)) {
      throw new ValidationError(
        `${paramName} must be a valid 64-character hex string`,
        paramName
      );
    }
    return normalizePubkey(pubkey);
  }

  /**
   * Get shortest path length to target pubkey
   * @param target - Target pubkey (hex)
   * @param options - Query options
   * @returns Number of hops or null if not reachable
   */
  async getDistance(
    target: string,
    options?: QueryOptions
  ): Promise<number | null> {
    const normalizedTarget = this.validatePubkey(target, 'target');

    // Check extension first - extension always takes priority
    const ext = await this.getExtension();
    if (ext) {
      return ext.getDistance(normalizedTarget);
    }

    // Fall back to oracle
    const myPubkey = await this.getEffectivePubkey();
    const maxHops = options?.maxHops ?? this.maxHops;

    interface DistanceResponse {
      distance: number | null;
    }

    try {
      const result = await this.apiRequest<DistanceResponse>(
        `/distance/${myPubkey}/${normalizedTarget}?maxHops=${maxHops}`,
        options
      );
      return result.distance;
    } catch (error) {
      if (error instanceof NotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Check if target is within your Web of Trust
   * @param target - Target pubkey (hex)
   * @param options - Query options
   * @returns true if target is within maxHops
   */
  async isInMyWoT(target: string, options?: QueryOptions): Promise<boolean> {
    const normalizedTarget = this.validatePubkey(target, 'target');

    // Check extension first - extension always takes priority
    const ext = await this.getExtension();
    if (ext) {
      const maxHops = options?.maxHops ?? this.maxHops;
      return ext.isInMyWoT(normalizedTarget, maxHops);
    }

    // Fall back to oracle
    const distance = await this.getDistance(normalizedTarget, options);
    const maxHops = options?.maxHops ?? this.maxHops;

    return distance !== null && distance <= maxHops;
  }

  /**
   * Get computed trust score based on distance and weights
   * @param target - Target pubkey (hex)
   * @param options - Query options
   * @returns Trust score between 0 and 1, or 0 if not connected
   */
  async getTrustScore(target: string, options?: QueryOptions): Promise<number> {
    const normalizedTarget = this.validatePubkey(target, 'target');

    // Check extension first - extension always takes priority
    const ext = await this.getExtension();
    if (ext) {
      const score = await ext.getTrustScore(normalizedTarget);
      return score ?? 0;
    }

    // Fall back to oracle
    const details = await this.getDetails(normalizedTarget, options);

    if (!details) {
      return 0;
    }

    return calculateTrustScore(details, this.scoring);
  }

  /**
   * Get distance between any two pubkeys
   * @param from - Source pubkey (hex)
   * @param to - Target pubkey (hex)
   * @param options - Query options
   * @returns Number of hops or null if not reachable
   */
  async getDistanceBetween(
    from: string,
    to: string,
    options?: QueryOptions
  ): Promise<number | null> {
    const normalizedFrom = this.validatePubkey(from, 'from');
    const normalizedTo = this.validatePubkey(to, 'to');

    // Check extension first - extension always takes priority
    const ext = await this.getExtension();
    if (ext) {
      return ext.getDistanceBetween(normalizedFrom, normalizedTo);
    }

    // Fall back to oracle
    const maxHops = options?.maxHops ?? this.maxHops;

    interface DistanceResponse {
      distance: number | null;
    }

    try {
      const result = await this.apiRequest<DistanceResponse>(
        `/distance/${normalizedFrom}/${normalizedTo}?maxHops=${maxHops}`,
        options
      );
      return result.distance;
    } catch (error) {
      if (error instanceof NotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Check multiple pubkeys efficiently
   * @param targets - Array of target pubkeys (hex)
   * @param options - Query options
   * @returns Map of pubkey to result
   */
  async batchCheck(
    targets: string[],
    options?: QueryOptions
  ): Promise<Map<string, BatchResult>> {
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new ValidationError('targets must be a non-empty array', 'targets');
    }
    if (targets.length > MAX_BATCH_SIZE) {
      throw new ValidationError(
        `targets array exceeds maximum size of ${MAX_BATCH_SIZE}`,
        'targets'
      );
    }

    const normalizedTargets = targets.map((t, i) =>
      this.validatePubkey(t, `targets[${i}]`)
    );

    const maxHops = options?.maxHops ?? this.maxHops;

    // Check extension first - extension always takes priority
    const ext = await this.getExtension();
    if (ext) {
      const results = new Map<string, BatchResult>();

      // Use extension's batch APIs for efficiency
      const [distances, scores] = await Promise.all([
        ext.getDistanceBatch(normalizedTargets),
        ext.getTrustScoreBatch(normalizedTargets),
      ]);

      for (const pubkey of normalizedTargets) {
        const distance = distances[pubkey] ?? null;
        const score = scores[pubkey] ?? 0;

        results.set(pubkey, {
          pubkey,
          distance,
          score,
          inWoT: distance !== null && distance <= maxHops,
        });
      }

      return results;
    }

    // Fall back to oracle batch API
    const myPubkey = await this.getEffectivePubkey();
    const results = new Map<string, BatchResult>();

    // Process in batches of 50 to avoid URL length limits
    const batches = chunk(normalizedTargets, 50);

    for (const batch of batches) {
      interface BatchResponse {
        results: Array<{
          pubkey: string;
          distance: number | null;
          paths?: number;
          mutual?: boolean;
        }>;
      }

      try {
        const response = await this.apiRequest<BatchResponse>(
          `/batch/${myPubkey}?targets=${batch.join(',')}&maxHops=${maxHops}`,
          options
        );

        for (const item of response.results) {
          const inWoT = item.distance !== null && item.distance <= maxHops;
          const score =
            item.distance !== null
              ? calculateTrustScore(
                  {
                    hops: item.distance,
                    paths: item.paths ?? 1,
                  },
                  this.scoring
                )
              : 0;

          results.set(item.pubkey, {
            pubkey: item.pubkey,
            distance: item.distance,
            score,
            inWoT,
          });
        }
      } catch (error) {
        // If batch fails, fill with null results
        for (const pubkey of batch) {
          if (!results.has(pubkey)) {
            results.set(pubkey, {
              pubkey,
              distance: null,
              score: 0,
              inWoT: false,
            });
          }
        }

        // Re-throw if not a transient error
        if (!(error instanceof NetworkError)) {
          throw error;
        }
      }
    }

    return results;
  }

  /**
   * Get distance and path count details
   * @param target - Target pubkey (hex)
   * @param options - Query options
   * @returns Distance result or null if not reachable
   *
   * Note: Extension returns `{ hops, paths }`. Oracle may return
   * additional fields like `bridges` and `mutual`.
   */
  async getDetails(
    target: string,
    options?: QueryOptions
  ): Promise<DistanceResult | null> {
    const normalizedTarget = this.validatePubkey(target, 'target');

    // Check extension first - extension always takes priority
    const ext = await this.getExtension();
    if (ext) {
      return ext.getDetails(normalizedTarget);
    }

    // Fall back to oracle
    const myPubkey = await this.getEffectivePubkey();
    const maxHops = options?.maxHops ?? this.maxHops;

    interface DetailsResponse {
      hops: number;
      paths: number;
      bridges?: string[];
      mutual?: boolean;
    }

    try {
      return await this.apiRequest<DetailsResponse>(
        `/details/${myPubkey}/${normalizedTarget}?maxHops=${maxHops}`,
        options
      );
    } catch (error) {
      if (error instanceof NotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get the current pubkey (from extension or fallback)
   * Returns the extension's pubkey when available.
   */
  async getMyPubkey(): Promise<string> {
    return this.getEffectivePubkey();
  }

  /**
   * Get the current oracle URL
   */
  getOracle(): string {
    return this.oracle;
  }

  /**
   * Get the current scoring configuration
   */
  getScoringConfig(): ScoringConfig {
    return { ...this.scoring };
  }

  /**
   * Check if extension is available and being used
   */
  async isUsingExtension(): Promise<boolean> {
    const ext = await this.getExtension();
    return ext !== null;
  }

  /**
   * Get extension configuration (only available when using extension)
   * @returns Extension config or null if not using extension
   */
  async getExtensionConfig(): Promise<ExtensionConfig | null> {
    const ext = await this.getExtension();
    if (!ext) return null;

    return ext.getConfig();
  }

  // ============================================
  // Extension-only methods (require extension)
  // ============================================

  /**
   * Check if the extension is configured and ready
   * @returns Status object with configuration state, or null if not using extension
   */
  async isConfigured(): Promise<ExtensionStatus | null> {
    const ext = await this.getExtension();
    if (!ext) return null;

    return ext.isConfigured();
  }

  /**
   * Filter a list of pubkeys to only those within the Web of Trust
   * @param pubkeys - Array of pubkeys to filter
   * @param options - Query options (maxHops)
   * @returns Filtered array of pubkeys within WoT
   *
   * Note: Extension-only. Falls back to batchCheck when extension unavailable.
   */
  async filterByWoT(
    pubkeys: string[],
    options?: QueryOptions
  ): Promise<string[]> {
    if (!Array.isArray(pubkeys) || pubkeys.length === 0) {
      return [];
    }

    const normalizedPubkeys = pubkeys
      .filter((pk) => isValidPubkey(pk))
      .map((pk) => normalizePubkey(pk));

    const maxHops = options?.maxHops ?? this.maxHops;

    // Check extension first - extension has native filterByWoT
    const ext = await this.getExtension();
    if (ext) {
      return ext.filterByWoT(normalizedPubkeys, maxHops);
    }

    // Fall back to batchCheck
    const results = await this.batchCheck(normalizedPubkeys, options);
    return Array.from(results.entries())
      .filter(([, result]) => result.inWoT)
      .map(([pubkey]) => pubkey);
  }

  /**
   * Get the follow list for a pubkey
   * @param pubkey - Optional, defaults to user's pubkey
   * @returns Array of followed pubkeys
   *
   * Note: Extension-only. Returns empty array if extension unavailable.
   */
  async getFollows(pubkey?: string): Promise<string[]> {
    const ext = await this.getExtension();
    if (!ext) return [];

    const normalizedPubkey = pubkey ? this.validatePubkey(pubkey, 'pubkey') : undefined;
    return ext.getFollows(normalizedPubkey);
  }

  /**
   * Get mutual follows between the user and a target
   * @param pubkey - Target pubkey
   * @returns Array of common followed pubkeys
   *
   * Note: Extension-only. Returns empty array if extension unavailable.
   */
  async getCommonFollows(pubkey: string): Promise<string[]> {
    const ext = await this.getExtension();
    if (!ext) return [];

    const normalizedPubkey = this.validatePubkey(pubkey, 'pubkey');
    return ext.getCommonFollows(normalizedPubkey);
  }

  /**
   * Get graph statistics
   * @returns Stats object with node/edge counts and sync info
   *
   * Note: Extension-only. Returns null if extension unavailable.
   */
  async getStats(): Promise<GraphStats | null> {
    const ext = await this.getExtension();
    if (!ext) return null;

    return ext.getStats();
  }

  /**
   * Get an actual path from the user to the target
   * @param target - Target pubkey
   * @returns Array of pubkeys [user, ..., target], or null if not connected
   *
   * Note: Extension-only. Returns null if extension unavailable.
   */
  async getPath(target: string): Promise<string[] | null> {
    const ext = await this.getExtension();
    if (!ext) return null;

    const normalizedTarget = this.validatePubkey(target, 'target');
    return ext.getPath(normalizedTarget);
  }

  /**
   * Get distances for multiple pubkeys in a single call
   * @param targets - Array of target pubkeys
   * @returns Record of pubkey to hop count (null if not connected)
   */
  async getDistanceBatch(
    targets: string[]
  ): Promise<Record<string, number | null>> {
    if (!Array.isArray(targets) || targets.length === 0) {
      return {};
    }

    const normalizedTargets = targets.map((t, i) =>
      this.validatePubkey(t, `targets[${i}]`)
    );

    // Check extension first
    const ext = await this.getExtension();
    if (ext) {
      return ext.getDistanceBatch(normalizedTargets);
    }

    // Fall back to individual queries
    const results: Record<string, number | null> = {};
    await Promise.all(
      normalizedTargets.map(async (pubkey) => {
        results[pubkey] = await this.getDistance(pubkey);
      })
    );

    return results;
  }

  /**
   * Get trust scores for multiple pubkeys in a single call
   * @param targets - Array of target pubkeys
   * @returns Record of pubkey to trust score (null if not connected)
   */
  async getTrustScoreBatch(
    targets: string[]
  ): Promise<Record<string, number | null>> {
    if (!Array.isArray(targets) || targets.length === 0) {
      return {};
    }

    const normalizedTargets = targets.map((t, i) =>
      this.validatePubkey(t, `targets[${i}]`)
    );

    // Check extension first
    const ext = await this.getExtension();
    if (ext) {
      return ext.getTrustScoreBatch(normalizedTargets);
    }

    // Fall back to individual queries
    const results: Record<string, number | null> = {};
    await Promise.all(
      normalizedTargets.map(async (pubkey) => {
        const score = await this.getTrustScore(pubkey);
        results[pubkey] = score > 0 ? score : null;
      })
    );

    return results;
  }
}
