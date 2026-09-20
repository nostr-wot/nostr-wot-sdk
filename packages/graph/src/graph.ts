/**
 * In-memory BFS over the hydrated follow graph.
 *
 * Ported from the extension (`lib/graph.ts`, `LocalGraph`). Given the interned
 * follow map (from {@link GraphStorage}) and a root pubkey, a single BFS pass
 * fills two typed arrays indexed by node id:
 *
 * - `hops`  (`Uint32Array`)  — distance from root, stored as `hop + 1` so `0`
 *   means "not reached" using a 32-bit distance.
 * - `paths` (`Float64Array`) — count of shortest paths to each node.
 *
 * The cache is keyed by root and invalidated on crawl / root change / clear.
 */

import type { GraphStorage } from './storage';
import type { DistanceInfo } from './types';

interface BfsCache {
  rootId: number;
  hops: Uint32Array;
  paths: Float64Array;
  maxId: number;
  maxHops: number;
  revision: number;
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
    // Store hop + 1 so zero means unreachable.
    const hops = new Uint32Array(maxId + 1);
    const paths = new Float64Array(maxId + 1);

    // Root: distance 0, 1 path
    hops[rootId] = 1; // stored as hop+1
    paths[rootId] = 1;

    const queue = new Uint32Array(maxId + 1);
    queue[0] = rootId;
    let length = 1;
    for (let head = 0; head < length; head++) {
      const nodeId = queue[head];
      const distance = hops[nodeId] - 1;
      if (distance >= maxHops) continue;
      const hopStored = distance + 2;
      const followIds = this.storage.getFollowIdsSync(nodeId);
      for (let i = 0; i < followIds.length; i++) {
        const fid = followIds[i];
        if (fid > maxId) continue;
        if (hops[fid] === 0) {
          hops[fid] = hopStored;
          queue[length++] = fid;
        }
        if (hops[fid] === hopStored) paths[fid] = Math.min(Number.MAX_SAFE_INTEGER, paths[fid] + paths[nodeId]);
      }
    }

    this.cache = { rootId, hops, paths, maxId, maxHops, revision: this.storage.getRevision() };
    this.cachedRoot = rootPubkey;
  }

  /** Ensure the cache is built for `root`. */
  private ensureCache(root: string, maxHops: number): void {
    if (this.cachedRoot !== root || !this.cache || this.cache.maxHops < maxHops || this.cache.revision !== this.storage.getRevision()) {
      this.buildCache(root, maxHops);
    }
  }

  /**
   * Distance info from `root` to `pubkey`. Returns `{ hops, paths }`, or `null`
   * when unreached / unknown. Self → `{ hops: 0, paths: 1 }`.
   */
  getDistance(root: string, pubkey: string, maxHops: number = DEFAULT_MAX_HOPS): DistanceInfo | null {
    if (!Number.isSafeInteger(maxHops) || maxHops < 0) throw new RangeError("maxHops must be a non-negative safe integer");
    if (root === pubkey) return { hops: 0, paths: 1 };

    this.ensureCache(root, maxHops);
    if (!this.cache || this.cachedRoot !== root) return null;

    const toId = this.storage.getId(pubkey);
    if (toId === null || toId > this.cache.maxId) return null;

    const h = this.cache.hops[toId];
    if (h === 0 || h - 1 > maxHops) return null; // unreachable

    return { hops: h - 1, paths: this.cache.paths[toId] };
  }

  /** Follow list of `pubkey` as hex strings. */
  getFollows(pubkey: string): string[] {
    return this.storage.getFollows(pubkey);
  }
}
