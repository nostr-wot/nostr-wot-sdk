/**
 * In-memory BFS over the hydrated follow graph.
 *
 * Ported from the extension (`lib/graph.ts`, `LocalGraph`). Given the interned
 * follow map (from {@link GraphStorage}) and a root pubkey, a single BFS pass
 * fills two typed arrays indexed by node id:
 *
 * - `hops`  (`Uint8Array`)  — distance from root, stored as `hop + 1` so `0`
 *   means "not reached" (255 max).
 * - `paths` (`Uint32Array`) — count of shortest paths to each node.
 *
 * The cache is keyed by root and invalidated on crawl / root change / clear.
 */

import type { GraphStorage } from './storage';
import type { DistanceInfo } from './types';

interface BfsCache {
  rootId: number;
  hops: Uint8Array;
  paths: Uint32Array;
  maxId: number;
}

const DEFAULT_MAX_HOPS = 6;

export class LocalGraph {
  private storage: GraphStorage;
  private cache: BfsCache | null = null;
  private cachedRoot: string | null = null;

  constructor(storage: GraphStorage) {
    this.storage = storage;
  }

  /** Invalidate the precomputed cache (called on crawl / root change / clear). */
  invalidateCache(): void {
    this.cache = null;
    this.cachedRoot = null;
  }

  /**
   * Precompute hops and paths from a root pubkey using a single BFS pass.
   * Results stored in typed arrays indexed by node id for O(1) lookup.
   */
  private buildCache(rootPubkey: string, maxHops: number = DEFAULT_MAX_HOPS): void {
    const rootId = this.storage.getId(rootPubkey);
    if (rootId === null) {
      this.cache = null;
      this.cachedRoot = null;
      return;
    }

    const maxId = this.storage.getMaxId();
    // Uint8Array: 0 = unreachable, 1-255 = hop distance. Store hop+1 so 0 means "not reached".
    const hops = new Uint8Array(maxId + 1);
    const paths = new Uint32Array(maxId + 1);

    // Root: distance 0, 1 path
    hops[rootId] = 1; // stored as hop+1
    paths[rootId] = 1;

    let frontier: number[] = [rootId];
    let hop = 0;

    while (frontier.length > 0 && hop < maxHops) {
      hop++;
      const hopStored = hop + 1;
      const nextFrontier: number[] = [];

      for (let f = 0; f < frontier.length; f++) {
        const nodeId = frontier[f];
        const nodePaths = paths[nodeId];
        const followIds = this.storage.getFollowIdsSync(nodeId);

        for (let i = 0; i < followIds.length; i++) {
          const fid = followIds[i];
          if (fid > maxId) continue; // safety guard

          if (hops[fid] === 0) {
            // First discovery
            hops[fid] = hopStored;
            paths[fid] = nodePaths;
            nextFrontier.push(fid);
          } else if (hops[fid] === hopStored) {
            // Same-level rediscovery -- accumulate paths
            paths[fid] += nodePaths;
          }
          // If hops[fid] < hopStored, it was found at a closer level -- ignore
        }
      }

      frontier = nextFrontier;
    }

    this.cache = { rootId, hops, paths, maxId };
    this.cachedRoot = rootPubkey;
  }

  /** Ensure the cache is built for `root`. */
  private ensureCache(root: string, maxHops: number): void {
    if (this.cachedRoot !== root || !this.cache) {
      this.buildCache(root, maxHops);
    }
  }

  /**
   * Distance info from `root` to `pubkey`. Returns `{ hops, paths }`, or `null`
   * when unreached / unknown. Self → `{ hops: 0, paths: 1 }`.
   */
  getDistance(root: string, pubkey: string, maxHops: number = DEFAULT_MAX_HOPS): DistanceInfo | null {
    if (root === pubkey) return { hops: 0, paths: 1 };

    this.ensureCache(root, maxHops);
    if (!this.cache || this.cachedRoot !== root) return null;

    const toId = this.storage.getId(pubkey);
    if (toId === null || toId > this.cache.maxId) return null;

    const h = this.cache.hops[toId];
    if (h === 0) return null; // unreachable

    return { hops: h - 1, paths: this.cache.paths[toId] };
  }

  /** Follow list of `pubkey` as hex strings. */
  getFollows(pubkey: string): string[] {
    return this.storage.getFollows(pubkey);
  }
}
