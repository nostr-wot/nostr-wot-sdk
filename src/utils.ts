import type { ScoringConfig, DistanceResult } from './types';

/**
 * Default scoring configuration
 */
export const DEFAULT_SCORING: ScoringConfig = {
  distanceWeights: {
    1: 1.0,
    2: 0.5,
    3: 0.25,
    4: 0.1,
  },
  mutualBonus: 0.5,
  pathBonus: 0.1,
  maxPathBonus: 0.5,
};

/**
 * Default oracle URL
 */
export const DEFAULT_ORACLE = 'https://nostr-wot.com';

/**
 * Default max hops for WoT queries
 */
export const DEFAULT_MAX_HOPS = 3;

/**
 * Default timeout in milliseconds
 */
export const DEFAULT_TIMEOUT = 5000;

/**
 * Validates a hex pubkey
 */
export function isValidPubkey(pubkey: string): boolean {
  return /^[0-9a-f]{64}$/i.test(pubkey);
}

/**
 * Validates an oracle URL (must be HTTPS)
 */
export function isValidOracleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validates a relay URL (must be WSS or WS)
 */
export function isValidRelayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'wss:' || parsed.protocol === 'ws:';
  } catch {
    return false;
  }
}

/**
 * Maximum allowed batch size for array inputs
 */
export const MAX_BATCH_SIZE = 10000;

/**
 * Normalizes a pubkey to lowercase hex
 */
export function normalizePubkey(pubkey: string): string {
  return pubkey.toLowerCase();
}

/**
 * Merges scoring configuration with defaults
 */
export function mergeScoringConfig(
  partial?: Partial<ScoringConfig>
): ScoringConfig {
  if (!partial) return { ...DEFAULT_SCORING };

  return {
    distanceWeights: {
      ...DEFAULT_SCORING.distanceWeights,
      ...partial.distanceWeights,
    },
    mutualBonus: partial.mutualBonus ?? DEFAULT_SCORING.mutualBonus,
    pathBonus: partial.pathBonus ?? DEFAULT_SCORING.pathBonus,
    maxPathBonus: partial.maxPathBonus ?? DEFAULT_SCORING.maxPathBonus,
  };
}

/**
 * Calculates trust score based on distance result and scoring config
 *
 * Formula:
 * score = baseScore × distanceWeight × (1 + bonuses)
 *
 * where:
 *   baseScore = 1 / (hops + 1)
 *   bonuses = mutualBonus (if mutual) + min(pathBonus × (paths - 1), maxPathBonus)
 *
 * Note: `mutual` is optional (only available from oracle, not extension)
 */
export function calculateTrustScore(
  result: DistanceResult,
  scoring: ScoringConfig
): number {
  const { hops, paths, mutual } = result;
  const { distanceWeights, mutualBonus, pathBonus, maxPathBonus } = scoring;

  // Base score decreases with distance
  const baseScore = 1 / (hops + 1);

  // Get distance weight (default to lowest defined weight for distant hops)
  const maxDefinedHop = Math.max(...Object.keys(distanceWeights).map(Number));
  const distanceWeight =
    distanceWeights[hops] ?? distanceWeights[maxDefinedHop] ?? 0.1;

  // Calculate bonuses
  let bonuses = 0;

  // Mutual follow bonus (only if mutual info is available)
  if (mutual === true) {
    bonuses += mutualBonus;
  }

  // Path count bonus (more paths = more trust)
  if (paths > 1) {
    const pathCountBonus = Math.min(pathBonus * (paths - 1), maxPathBonus);
    bonuses += pathCountBonus;
  }

  // Final score (clamped to 0-1)
  const score = baseScore * distanceWeight * (1 + bonuses);
  return Math.min(1, Math.max(0, score));
}

/**
 * Creates a fetch request with timeout
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {}
): Promise<Response> {
  const { timeout = DEFAULT_TIMEOUT, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Delays execution for specified milliseconds
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chunks an array into smaller arrays
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Creates a deferred promise
 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
