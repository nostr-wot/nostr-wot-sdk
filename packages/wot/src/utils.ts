/**
 * Default oracle URL.
 *
 * This host runs nostr-wot-oracle: it answers `GET /` with
 * `{"service":"nostr-wot-oracle","version":"0.3.1",...}` and its own endpoint
 * list. nostr-wot's README names it the project's public instance, and the
 * browser extension defaults to the same host. Every wire shape in this package
 * is therefore that server's, taken from its `docs/API.md` and `src/api/http.rs`.
 */
export const DEFAULT_ORACLE = 'https://wot-oracle.mappingbitcoin.com';

/**
 * Default max hops for WoT queries.
 *
 * Matches nostr-wot-oracle's own `MAX_HOPS_DEFAULT` (src/config.rs), so an
 * unconfigured client asks for the depth the server would have chosen anyway.
 */
export const DEFAULT_MAX_HOPS = 3;

/**
 * Shallowest depth nostr-wot-oracle answers.
 *
 * `validate_max_hops` (src/api/http.rs) refuses anything outside `1..=5` with a
 * 400 and code `INVALID_MAX_HOPS`, so a value below this is a failed request
 * rather than a shallower search.
 */
export const ORACLE_MIN_HOPS = 1;

/**
 * Deepest depth nostr-wot-oracle answers: `MAX_HOPS_LIMIT` in src/config.rs.
 */
export const ORACLE_MAX_HOPS = 5;

/**
 * Targets nostr-wot-oracle accepts in one `POST /distance/batch`.
 *
 * `batch_distance` (src/api/http.rs) refuses a longer list with code
 * `TOO_MANY_TARGETS`, so a larger caller list is split to this bound.
 */
export const ORACLE_MAX_BATCH_TARGETS = 100;

/**
 * Brings a requested depth into the range nostr-wot-oracle accepts.
 *
 * A rejected `max_hops` is a 400, not a shallower or deeper answer, so it is
 * clamped before it is sent. Depth 0 is answerable at depth 1 and filtered by
 * the caller, and anything past `ORACLE_MAX_HOPS` is discarded by the caller
 * regardless.
 */
export function clampMaxHops(value: number): number {
  const asked = Number.isFinite(value) ? Math.trunc(value) : DEFAULT_MAX_HOPS;
  return Math.min(Math.max(asked, ORACLE_MIN_HOPS), ORACLE_MAX_HOPS);
}

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
