/**
 * Default oracle URL
 */
export const DEFAULT_ORACLE = 'https://wot-oracle.mappingbitcoin.com';

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
 * Validates an oracle URL (HTTP or HTTPS)
 */
export function isValidOracleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
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
 * Chunks an array into smaller arrays
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
