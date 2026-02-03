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
  mergeScoringConfig,
  calculateTrustScore,
  isValidPubkey,
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

    this.oracle = options.oracle ?? this.fallbackOptions?.oracle ?? DEFAULT_ORACLE;
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
      // Get pubkey from NIP-07 window.nostr.getPublicKey()
      if (win.nostr?.getPublicKey) {
        try {
          this.extensionPubkey = await win.nostr.getPublicKey();
        } catch {
          // Ignore - will use fallback pubkey
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

    try {
      const response = await fetchWithTimeout(url, {
        timeout,
        headers: {
          'Content-Type': 'application/json',
        },
      });

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
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof NetworkError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new TimeoutError(timeout);
        }
        throw new NetworkError(error.message, undefined, url);
      }

      throw new NetworkError('Unknown network error', undefined, url);
    }
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
   * @returns Trust score between 0 and 1
   */
  async getTrustScore(target: string, options?: QueryOptions): Promise<number> {
    const normalizedTarget = this.validatePubkey(target, 'target');

    // Check extension first
    const ext = await this.getExtension();
    if (ext) {
      return ext.getTrustScore(normalizedTarget);
    }

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
   *
   * Note: When using extension, this falls back to individual queries
   * since the extension doesn't have a batch API.
   */
  async batchCheck(
    targets: string[],
    options?: QueryOptions
  ): Promise<Map<string, BatchResult>> {
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new ValidationError('targets must be a non-empty array', 'targets');
    }

    const normalizedTargets = targets.map((t, i) =>
      this.validatePubkey(t, `targets[${i}]`)
    );

    const maxHops = options?.maxHops ?? this.maxHops;

    // Check extension first - extension always takes priority
    // Extension doesn't have batch API, so we query individually
    const ext = await this.getExtension();
    if (ext) {
      const results = new Map<string, BatchResult>();

      // Query each target individually using extension
      await Promise.all(
        normalizedTargets.map(async (pubkey) => {
          try {
            const [distance, score] = await Promise.all([
              ext.getDistance(pubkey),
              ext.getTrustScore(pubkey),
            ]);

            results.set(pubkey, {
              pubkey,
              distance,
              score,
              inWoT: distance !== null && distance <= maxHops,
            });
          } catch {
            results.set(pubkey, {
              pubkey,
              distance: null,
              score: 0,
              inWoT: false,
            });
          }
        })
      );

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
      // Extension returns { hops, paths }
      const result = await ext.getDetails(normalizedTarget);
      return result;
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
      const result = await this.apiRequest<DetailsResponse>(
        `/details/${myPubkey}/${normalizedTarget}?maxHops=${maxHops}`,
        options
      );
      return result;
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
}
