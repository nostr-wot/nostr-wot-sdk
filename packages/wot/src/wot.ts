import type {
  WoTOptions,
  WoTFallbackOptions,
  WoTLocalSource,
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
  ORACLE_MAX_BATCH_TARGETS,
  ORACLE_MAX_HOPS,
  clampMaxHops,
  isValidPubkey,
  isValidOracleUrl,
  normalizePubkey,
  fetchWithTimeout,
  chunk,
} from './utils';

/**
 * `bfs::DistanceResult` as nostr-wot-oracle serializes it, from `src/graph/bfs.rs`.
 *
 * `hops` is an `Option<u32>`, `path_count` a `u64` and `mutual_follow` a `bool`,
 * all always present; `bridges` is skipped when absent.
 */
interface OracleDistance {
  from: string;
  to: string;
  hops: number | null;
  path_count: number;
  mutual_follow: boolean;
  bridges?: string[];
}

/** `BatchDistanceResponse` from `src/api/http.rs`. */
interface OracleBatchDistance {
  from: string;
  results: OracleDistance[];
}

/**
 * WoT (Web of Trust) SDK for querying Nostr trust relationships
 *
 * Queries are answered by the oracle API, which computes hop distance
 * over the public kind-3 follow graph.
 *
 * The wire shapes below are nostr-wot-oracle's, taken from that repository's
 * `docs/API.md` table, `src/api/http.rs` and `src/graph/bfs.rs`, not from this
 * client's assumptions. `DEFAULT_ORACLE` runs that server, and the two had
 * drifted so far that no request this client sent reached a route:
 *
 * | | this client sent or read | nostr-wot-oracle serves |
 * |---|---|---|
 * | distance | `GET /api/distance/FROM/TO?maxHops=` | `GET /distance?from=&to=&max_hops=` |
 * | distance field | `distance` | `hops` |
 * | details | `GET /api/details/FROM/TO` | no such route; `/distance` carries the detail |
 * | path count | `paths` | `path_count` |
 * | mutual follow | `mutual` | `mutual_follow` |
 * | batch | `GET /api/batch/FROM?targets=a,b` | `POST /distance/batch` with a JSON body |
 * | batch target key | `pubkey` | `to` |
 * | `max_hops` | never sent | accepted, 1..5, server default 3 |
 *
 * Every one of those failed silently. A field the oracle does not send reads as
 * `undefined` rather than raising, and a path it does not route answers 404,
 * which this client converted into "not reachable": the honest answer for an
 * absent route and an absent answer looked identical. A 404 is now raised,
 * because nostr-wot-oracle reports "no route found within the depth searched" as
 * `hops: null` on a 200 and never as a 404, so a 404 means this client is not
 * talking to the server it thinks it is. Each row is pinned by a test in
 * `test/oracle-contract.test.ts`.
 */
export class WoT {
  private readonly oracle: string;
  private readonly fallbackPubkey: string | null;
  private readonly maxHops: number;
  private readonly timeout: number;
  private readonly fallbackOptions: WoTFallbackOptions | null;
  private readonly source: WoTLocalSource | null;

  constructor(options: WoTOptions = {}) {
    this.fallbackOptions = options.fallback ?? null;
    this.source = options.source ?? null;

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
    // A self-hosted oracle can sit under a path on a shared host, so the base is
    // a prefix rather than just an origin. Trailing slashes are dropped so that
    // joining a route onto it cannot produce a doubled separator.
    this.oracle = oracleUrl.replace(/\/+$/, '');
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
   * Makes an API request to the oracle.
   *
   * `create_router` mounts `/distance`, `/distance/batch`, `/follows`,
   * `/common-follows`, `/path`, `/mutes`, `/trust` and `/stats` at the root, so
   * there is no `/api` prefix to add. Passing `body` makes the request the POST
   * that `/distance/batch` is.
   */
  private async apiRequest<T>(
    endpoint: string,
    params: Record<string, string> = {},
    options: QueryOptions = {},
    body?: unknown
  ): Promise<T> {
    const timeout = options.timeout ?? this.timeout;
    const target = new URL(`${this.oracle}/${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      target.searchParams.set(key, value);
    }
    const url = target.href;

    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        timeout,
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
        // nostr-wot-oracle reports an unreached target as `hops: null` on a 200,
        // never as a 404, so a 404 is a route this server does not serve. It is
        // raised rather than read as an answer about the graph.
        throw new NotFoundError(
          '',
          `Oracle has no route ${endpoint}: ${url} is not a nostr-wot-oracle endpoint`
        );
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
   * Reads `hops` from a `bfs::DistanceResult`.
   *
   * The field is `hops`, not `distance`; the oracle has never sent a `distance`
   * member, so reading one yielded `undefined` for every answer.
   *
   * `null` is the oracle saying no route was found within the depth it searched,
   * which its documentation is careful is "not proof of no connection across
   * Nostr". It stays `null` rather than becoming a distance of zero.
   */
  private readHops(result: OracleDistance): number | null {
    const hops = result.hops ?? null;
    if (hops === null) {
      return null;
    }
    if (!Number.isInteger(hops) || hops < 0 || hops > ORACLE_MAX_HOPS) {
      throw new NetworkError(
        `Oracle sent an out-of-range hop count: ${String(hops)}`,
        undefined,
        this.oracle
      );
    }
    return hops;
  }

  /**
   * Reads `path_count` from a `bfs::DistanceResult`.
   *
   * docs/API.md: "Counts saturate at the maximum unsigned 64-bit integer rather
   * than overflowing", and that maximum is well past `Number.MAX_SAFE_INTEGER`,
   * so refusing an unsafe integer would refuse a documented answer. It is clamped
   * instead. `path_count` is a non-optional `u64`, so a missing or non-numeric
   * one is a server this client is not talking to.
   */
  private readPathCount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new NetworkError(
        `Oracle sent an invalid path_count: ${String(value)}`,
        undefined,
        this.oracle
      );
    }
    return Math.min(value, Number.MAX_SAFE_INTEGER);
  }

  /**
   * `GET /distance`: `from`, `to`, optional `max_hops` (1..5, default 3) and
   * `include_bridges` (docs/API.md). Answers with `bfs::DistanceResult`.
   */
  private async fetchDistance(
    from: string,
    to: string,
    options?: QueryOptions
  ): Promise<OracleDistance> {
    const params: Record<string, string> = {
      from,
      to,
      max_hops: String(clampMaxHops(options?.maxHops ?? this.maxHops)),
    };
    // `include_bridges` defaults to false on the server and the field is skipped
    // when absent, so it is sent only when the caller asked for bridges.
    if (options?.includeBridges) {
      params.include_bridges = 'true';
    }
    return this.apiRequest<OracleDistance>('distance', params, options);
  }

  /**
   * Get shortest path length to target pubkey
   * @param target - Target pubkey (hex)
   * @param options - Query options
   * @returns Number of hops, or null when no route was found within `maxHops`
   * @throws NotFoundError when the configured oracle does not serve `/distance`
   */
  async getDistance(
    target: string,
    options?: QueryOptions
  ): Promise<number | null> {
    const normalizedTarget = this.validatePubkey(target, 'target');

    // Local source short-circuits the Oracle when provided.
    if (this.source) {
      return this.source.getDistance(normalizedTarget);
    }

    const myPubkey = this.getEffectivePubkey();

    return this.readHops(
      await this.fetchDistance(myPubkey, normalizedTarget, options)
    );
  }

  /**
   * Check if target is within your Web of Trust
   * @param target - Target pubkey (hex)
   * @param options - Query options
   * @returns true if target is within maxHops
   */
  async isInMyWoT(target: string, options?: QueryOptions): Promise<boolean> {
    const normalizedTarget = this.validatePubkey(target, 'target');
    const maxHops = options?.maxHops ?? this.maxHops;

    if (this.source) {
      return this.source.isInMyWoT(normalizedTarget, maxHops);
    }

    const distance = await this.getDistance(normalizedTarget, options);

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

    return this.readHops(
      await this.fetchDistance(normalizedFrom, normalizedTo, options)
    );
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

    // `batch_distance` refuses a request carrying more than ORACLE_MAX_BATCH_TARGETS
    // targets with code TOO_MANY_TARGETS. The body is a POST, so the old chunk of 50
    // "to avoid URL length limits" no longer describes the bound that applies.
    const batches = chunk(normalizedTargets, ORACLE_MAX_BATCH_TARGETS);

    for (const batch of batches) {
      // Only the request is guarded. Reading the answer is deliberately outside
      // the catch: a malformed body is not a transient failure, and swallowing
      // one as "no distance" is the class of silence this client is being fixed
      // for.
      let response: OracleBatchDistance;
      try {
        // `POST /distance/batch` takes `BatchDistanceRequest` as a JSON body and
        // answers with `from` plus ordered `results`, duplicates preserved.
        response = await this.apiRequest<OracleBatchDistance>(
          'distance/batch',
          {},
          options,
          {
            from: myPubkey,
            targets: batch,
            max_hops: clampMaxHops(maxHops),
          }
        );
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
        continue;
      }

      for (const item of response.results) {
        // The endpoints are `from` and `to`. `bfs::DistanceResult` has no
        // `pubkey` member, so keying by one filed every result under
        // "undefined" and no target was ever found in the map.
        if (typeof item?.to !== 'string') {
          throw new NetworkError(
            'Oracle batch result is missing its target pubkey',
            undefined,
            this.oracle
          );
        }
        const distance = this.readHops(item);
        const inWoT = distance !== null && distance <= maxHops;

        results.set(item.to, {
          pubkey: item.to,
          distance,
          inWoT,
        });
      }
    }

    return results;
  }

  /**
   * Get distance and path count details
   *
   * nostr-wot-oracle has no `/details` route: its endpoint list is `/health`,
   * `/ready`, `/stats`, `/distance`, `/distance/batch`, `/path`, `/follows`,
   * `/common-follows`, `/mutes` and `/trust`. `GET /distance` already carries the
   * detail, so this asks that route and renames its fields onto
   * {@link DistanceResult}: `path_count` to `paths`, `mutual_follow` to `mutual`.
   *
   * @param target - Target pubkey (hex)
   * @param options - Query options; pass `includeBridges` to ask for `bridges`
   * @returns Details, or null when no route was found within `maxHops`
   * @throws NotFoundError when the configured oracle does not serve `/distance`
   */
  async getDetails(
    target: string,
    options?: QueryOptions
  ): Promise<DistanceResult | null> {
    const normalizedTarget = this.validatePubkey(target, 'target');

    const myPubkey = this.getEffectivePubkey();

    const response = await this.fetchDistance(
      myPubkey,
      normalizedTarget,
      options
    );

    const hops = this.readHops(response);
    if (hops === null) {
      return null;
    }

    const result: DistanceResult = {
      hops,
      paths: this.readPathCount(response.path_count),
      mutual: response.mutual_follow,
    };
    if (response.bridges !== undefined) {
      result.bridges = response.bridges;
    }
    return result;
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

    if (this.source) {
      const maxHops = options?.maxHops ?? this.maxHops;
      return this.source.filterByWoT(normalizedPubkeys, { maxHops });
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
