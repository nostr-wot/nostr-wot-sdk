import type {
  LocalWoTOptions,
  ScoringConfig,
  QueryOptions,
  DistanceResult,
  BatchResult,
  SyncOptions,
  StorageAdapter,
} from '../types';
import { ValidationError } from '../errors';
import {
  DEFAULT_MAX_HOPS,
  MAX_BATCH_SIZE,
  mergeScoringConfig,
  calculateTrustScore,
  isValidPubkey,
  isValidRelayUrl,
  normalizePubkey,
  chunk,
} from '../utils';
import { createStorage } from './storage';
import { RelayPool, extractFollows } from './relay';

/**
 * Storage keys
 */
const KEYS = {
  FOLLOWS_PREFIX: 'follows:',
  META_PREFIX: 'meta:',
  SYNC_DEPTH: 'sync:depth',
  SYNC_TIME: 'sync:time',
};

/**
 * LocalWoT - Compute Web of Trust locally without oracle
 */
export class LocalWoT {
  private readonly myPubkey: string;
  private readonly relayUrls: string[];
  private readonly maxHops: number;
  private readonly scoring: ScoringConfig;
  private storage: StorageAdapter;
  private pool: RelayPool | null = null;

  constructor(options: LocalWoTOptions) {
    if (!options.myPubkey) {
      throw new ValidationError('myPubkey is required', 'myPubkey');
    }
    if (!isValidPubkey(options.myPubkey)) {
      throw new ValidationError(
        'myPubkey must be a valid 64-character hex string',
        'myPubkey'
      );
    }
    if (!options.relays || options.relays.length === 0) {
      throw new ValidationError('At least one relay URL is required', 'relays');
    }
    for (const relay of options.relays) {
      if (!isValidRelayUrl(relay)) {
        throw new ValidationError(
          `Invalid relay URL: ${relay}. Must be wss:// or ws://`,
          'relays'
        );
      }
    }

    this.myPubkey = normalizePubkey(options.myPubkey);
    this.relayUrls = options.relays;
    this.maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
    this.scoring = mergeScoringConfig(options.scoring);
    this.storage = createStorage(options.storage ?? 'memory');
  }

  /**
   * Get or create relay pool
   */
  private getPool(): RelayPool {
    if (!this.pool) {
      this.pool = new RelayPool(this.relayUrls);
    }
    return this.pool;
  }

  /**
   * Get follows for a pubkey from storage
   */
  private async getFollows(pubkey: string): Promise<string[] | null> {
    const data = await this.storage.get(KEYS.FOLLOWS_PREFIX + pubkey);
    if (!data) return null;
    try {
      return JSON.parse(data) as string[];
    } catch {
      return null;
    }
  }

  /**
   * Set follows for a pubkey in storage
   */
  private async setFollows(pubkey: string, follows: string[]): Promise<void> {
    await this.storage.set(KEYS.FOLLOWS_PREFIX + pubkey, JSON.stringify(follows));
  }

  /**
   * Check if a pubkey follows another
   */
  private async doesFollow(from: string, to: string): Promise<boolean> {
    const follows = await this.getFollows(from);
    return follows?.includes(to) ?? false;
  }

  /**
   * Sync follow graph from relays
   * @param options - Sync options
   */
  async sync(options: SyncOptions = {}): Promise<void> {
    const depth = options.depth ?? 2;
    const onProgress = options.onProgress;

    const pool = this.getPool();
    const visited = new Set<string>();
    let currentLayer = new Set([this.myPubkey]);

    for (let d = 0; d < depth; d++) {
      const toFetch = Array.from(currentLayer).filter((pk) => !visited.has(pk));

      if (toFetch.length === 0) break;

      // Report progress
      if (onProgress) {
        onProgress({
          currentDepth: d + 1,
          totalDepth: depth,
          processed: 0,
          total: toFetch.length,
        });
      }

      // Fetch in batches
      const nextLayer = new Set<string>();
      const batches = chunk(toFetch, 100);
      let processed = 0;

      for (const batch of batches) {
        const events = await pool.fetchContactLists(batch);

        for (const [pubkey, event] of events) {
          visited.add(pubkey);
          const follows = extractFollows(event);
          await this.setFollows(pubkey, follows);

          // Add follows to next layer
          if (d < depth - 1) {
            for (const follow of follows) {
              if (!visited.has(follow)) {
                nextLayer.add(follow);
              }
            }
          }
        }

        // Mark pubkeys without events as having no follows
        for (const pubkey of batch) {
          if (!events.has(pubkey)) {
            visited.add(pubkey);
            await this.setFollows(pubkey, []);
          }
        }

        processed += batch.length;

        if (onProgress) {
          onProgress({
            currentDepth: d + 1,
            totalDepth: depth,
            processed,
            total: toFetch.length,
          });
        }
      }

      currentLayer = nextLayer;
    }

    // Save sync metadata
    await this.storage.set(KEYS.SYNC_DEPTH, String(depth));
    await this.storage.set(KEYS.SYNC_TIME, String(Date.now()));
  }

  /**
   * BFS to find shortest path between two pubkeys
   */
  private async findShortestPath(
    from: string,
    to: string,
    maxHops: number
  ): Promise<{ distance: number; paths: number; bridges: string[] } | null> {
    if (from === to) {
      return { distance: 0, paths: 1, bridges: [] };
    }

    const visited = new Set<string>([from]);
    let currentLayer = [from];
    let distance = 0;
    const bridges: string[] = [];
    let pathCount = 0;

    while (currentLayer.length > 0 && distance < maxHops) {
      distance++;
      const nextLayer: string[] = [];
      let foundInLayer = false;

      for (const pubkey of currentLayer) {
        const follows = await this.getFollows(pubkey);
        if (!follows) continue;

        for (const follow of follows) {
          if (follow === to) {
            foundInLayer = true;
            pathCount++;
            // Track first-hop bridges
            if (distance === 1) {
              bridges.push(pubkey);
            } else if (!bridges.includes(pubkey)) {
              // Track bridges (pubkeys that lead to target)
              const firstHop = currentLayer.find((pk) =>
                this.getFollows(pk).then((f) => f?.includes(pubkey))
              );
              if (firstHop && !bridges.includes(firstHop)) {
                bridges.push(firstHop);
              }
            }
          } else if (!visited.has(follow)) {
            visited.add(follow);
            nextLayer.push(follow);
          }
        }
      }

      if (foundInLayer) {
        return { distance, paths: pathCount, bridges };
      }

      currentLayer = nextLayer;
    }

    return null;
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
   */
  async getDistance(
    target: string,
    options?: QueryOptions
  ): Promise<number | null> {
    const normalizedTarget = this.validatePubkey(target, 'target');
    const maxHops = options?.maxHops ?? this.maxHops;

    const result = await this.findShortestPath(
      this.myPubkey,
      normalizedTarget,
      maxHops
    );
    return result?.distance ?? null;
  }

  /**
   * Check if target is within your Web of Trust
   */
  async isInMyWoT(target: string, options?: QueryOptions): Promise<boolean> {
    const distance = await this.getDistance(target, options);
    const maxHops = options?.maxHops ?? this.maxHops;
    return distance !== null && distance <= maxHops;
  }

  /**
   * Get computed trust score based on distance and weights
   */
  async getTrustScore(target: string, options?: QueryOptions): Promise<number> {
    const details = await this.getDetails(target, options);
    if (!details) return 0;
    return calculateTrustScore(details, this.scoring);
  }

  /**
   * Get distance between any two pubkeys
   */
  async getDistanceBetween(
    from: string,
    to: string,
    options?: QueryOptions
  ): Promise<number | null> {
    const normalizedFrom = this.validatePubkey(from, 'from');
    const normalizedTo = this.validatePubkey(to, 'to');
    const maxHops = options?.maxHops ?? this.maxHops;

    const result = await this.findShortestPath(normalizedFrom, normalizedTo, maxHops);
    return result?.distance ?? null;
  }

  /**
   * Check multiple pubkeys efficiently
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

    const results = new Map<string, BatchResult>();
    const maxHops = options?.maxHops ?? this.maxHops;

    for (const target of targets) {
      const normalizedTarget = this.validatePubkey(target, 'target');
      const details = await this.getDetails(normalizedTarget, options);

      results.set(normalizedTarget, {
        pubkey: normalizedTarget,
        distance: details?.hops ?? null,
        score: details ? calculateTrustScore(details, this.scoring) : 0,
        inWoT: details !== null && details.hops <= maxHops,
      });
    }

    return results;
  }

  /**
   * Get full distance result with bridges and path count
   */
  async getDetails(
    target: string,
    options?: QueryOptions
  ): Promise<DistanceResult | null> {
    const normalizedTarget = this.validatePubkey(target, 'target');
    const maxHops = options?.maxHops ?? this.maxHops;

    const result = await this.findShortestPath(
      this.myPubkey,
      normalizedTarget,
      maxHops
    );

    if (!result) return null;

    // Check for mutual follow
    const mutual = await this.doesFollow(normalizedTarget, this.myPubkey);

    return {
      hops: result.distance,
      paths: result.paths,
      bridges: result.bridges,
      mutual,
    };
  }

  /**
   * Clear all stored data
   */
  async clear(): Promise<void> {
    await this.storage.clear();
  }

  /**
   * Close relay connections
   */
  close(): void {
    if (this.pool) {
      this.pool.close();
      this.pool = null;
    }
  }

  /**
   * Get the current pubkey
   */
  getMyPubkey(): string {
    return this.myPubkey;
  }

  /**
   * Get sync status
   */
  async getSyncStatus(): Promise<{ depth: number; time: number } | null> {
    const depth = await this.storage.get(KEYS.SYNC_DEPTH);
    const time = await this.storage.get(KEYS.SYNC_TIME);

    if (!depth || !time) return null;

    return {
      depth: parseInt(depth, 10),
      time: parseInt(time, 10),
    };
  }
}
