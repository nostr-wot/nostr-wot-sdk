import type {
  WoTOptions,
  WoTFallbackOptions,
  QueryOptions,
  DistanceResult,
  DistanceBatchOptions,
  BatchResult,
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
  isValidPubkey,
  isValidOracleUrl,
  normalizePubkey,
  fetchWithTimeout,
  chunk,
} from './utils';

/**
 * WoT (Web of Trust) SDK for querying Nostr trust relationships
 *
 * Queries are answered by the oracle API, which computes hop distance
 * over the public kind-3 follow graph.
 */
export class WoT {
  private readonly oracle: string;
  private readonly fallbackPubkey: string | null;
  private readonly maxHops: number;
  private readonly timeout: number;
  private readonly fallbackOptions: WoTFallbackOptions | null;

  constructor(options: WoTOptions = {}) {
    this.fallbackOptions = options.fallback ?? null;

    // Use provided pubkey or fallback pubkey for oracle queries
    if (options.myPubkey && isValidPubkey(options.myPubkey)) {
      this.fallbackPubkey = normalizePubkey(options.myPubkey);
    } else if (this.fallbackOptions?.myPubkey) {
      this.fallbackPubkey = normalizePubkey(this.fallbackOptions.myPubkey);
    } else {
      this.fallbackPubkey = null;
    }

    const oracleUrl = options.oracle ?? this.fallbackOptions?.oracle ?? DEFAULT_ORACLE;
    if (!isValidOracleUrl(oracleUrl)) {
      throw new ValidationError('oracle must be a valid HTTPS URL', 'oracle');
    }
    this.oracle = oracleUrl;
    this.maxHops = options.maxHops ?? this.fallbackOptions?.maxHops ?? DEFAULT_MAX_HOPS;
    this.timeout = options.timeout ?? this.fallbackOptions?.timeout ?? DEFAULT_TIMEOUT;
  }

  /**
   * Gets the effective pubkey for oracle queries
   */
  private getEffectivePubkey(): string {
    if (this.fallbackPubkey) {
      return this.fallbackPubkey;
    }

    throw new ValidationError(
      'No pubkey available. Provide myPubkey or fallback options.',
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

    const myPubkey = this.getEffectivePubkey();
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

    const distance = await this.getDistance(normalizedTarget, options);
    const maxHops = options?.maxHops ?? this.maxHops;

    return distance !== null && distance <= maxHops;
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

    const myPubkey = this.getEffectivePubkey();
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

          results.set(item.pubkey, {
            pubkey: item.pubkey,
            distance: item.distance,
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
   */
  async getDetails(
    target: string,
    options?: QueryOptions
  ): Promise<DistanceResult | null> {
    const normalizedTarget = this.validatePubkey(target, 'target');

    const myPubkey = this.getEffectivePubkey();
    const maxHops = options?.maxHops ?? this.maxHops;

    interface DetailsResponse {
      hops: number;
      paths: number;
      bridges?: string[];
      mutual?: boolean;
    }

    try {
      const response = await this.apiRequest<DetailsResponse>(
        `/details/${myPubkey}/${normalizedTarget}?maxHops=${maxHops}`,
        options
      );
      return response;
    } catch (error) {
      if (error instanceof NotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get the current pubkey used for oracle queries
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
   * Filter a list of pubkeys to only those within the Web of Trust
   * @param pubkeys - Array of pubkeys to filter
   * @param options - Query options (maxHops)
   * @returns Filtered array of pubkeys within WoT
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

    if (normalizedPubkeys.length === 0) {
      return [];
    }

    const results = await this.batchCheck(normalizedPubkeys, options);
    return Array.from(results.entries())
      .filter(([, result]) => result.inWoT)
      .map(([pubkey]) => pubkey);
  }

  /**
   * Get distances for multiple pubkeys in a single call
   * @param targets - Array of target pubkeys
   * @param options - Options object or boolean for backwards compatibility
   *   - `{ includePaths: true }` - Include path counts
   *   - `true` (legacy) - Same as `{ includePaths: true }`
   * @returns Record of pubkey to result based on options
   */
  async getDistanceBatch(
    targets: string[],
    options?: false | undefined
  ): Promise<Record<string, number | null>>;
  async getDistanceBatch(
    targets: string[],
    options: true | { includePaths: true }
  ): Promise<Record<string, { hops: number; paths: number } | null>>;
  async getDistanceBatch(
    targets: string[],
    options?: boolean | DistanceBatchOptions
  ): Promise<Record<string, number | { hops: number; paths?: number } | null>>;
  async getDistanceBatch(
    targets: string[],
    options: boolean | DistanceBatchOptions = false
  ): Promise<Record<string, number | { hops: number; paths?: number } | null>> {
    if (!Array.isArray(targets) || targets.length === 0) {
      return {};
    }

    const normalizedTargets = targets.map((t, i) =>
      this.validatePubkey(t, `targets[${i}]`)
    );

    // Normalize options: boolean `true` means { includePaths: true }
    const opts: DistanceBatchOptions =
      typeof options === 'boolean'
        ? { includePaths: options }
        : options || {};

    const { includePaths } = opts;

    if (includePaths) {
      const results: Record<string, { hops: number; paths?: number } | null> = {};
      await Promise.all(
        normalizedTargets.map(async (pubkey) => {
          const details = await this.getDetails(pubkey);
          if (!details) {
            results[pubkey] = null;
            return;
          }
          results[pubkey] = { hops: details.hops, paths: details.paths };
        })
      );
      return results;
    }

    const results: Record<string, number | null> = {};
    await Promise.all(
      normalizedTargets.map(async (pubkey) => {
        results[pubkey] = await this.getDistance(pubkey);
      })
    );
    return results;
  }
}
