import { SimplePool } from "nostr-tools";

let _pool: SimplePool | null = null;

/**
 * Returns a process-wide SimplePool. Lazy-init on first call.
 * Tests / advanced users can substitute their own via `setPool`.
 */
export function getPool(): SimplePool {
  if (!_pool) _pool = new SimplePool();
  return _pool;
}

export function setPool(pool: SimplePool): void {
  _pool = pool;
}

export function resetPool(): void {
  _pool = null;
}

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://relay.primal.net",
];

/** Specialised aggregators for kind-0 lookups. purplepag.es indexes
 *  every kind-0 it sees, so it's the highest-hit-rate single relay for
 *  profile metadata. */
export const PROFILE_AGGREGATORS = ["wss://purplepag.es"];

export const DEFAULT_TIMEOUT_MS = 4000;
