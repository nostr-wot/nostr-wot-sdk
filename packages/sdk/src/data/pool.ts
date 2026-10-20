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

const BUILTIN_DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://relay.primal.net",
];

/** Specialised aggregators for kind-0 lookups. purplepag.es indexes
 *  every kind-0 it sees, so it's the highest-hit-rate single relay for
 *  profile metadata. */
const BUILTIN_PROFILE_AGGREGATORS = ["wss://purplepag.es"];

let _defaultRelays = [...BUILTIN_DEFAULT_RELAYS];
let _profileAggregators = [...BUILTIN_PROFILE_AGGREGATORS];

/**
 * Override the default relay set used by every fetcher that doesn't
 * receive an explicit `relays` argument. Use from a top-level setup
 * (e.g. `<NostrSdkProvider relays={…}>` calls this on mount).
 */
export function setDefaultRelays(relays: string[]): void {
  if (!Array.isArray(relays) || relays.length === 0) return;
  _defaultRelays = [...new Set(relays.filter((r) => r.startsWith("ws")))];
}

export function getDefaultRelays(): string[] {
  return _defaultRelays;
}

export function setProfileAggregators(relays: string[]): void {
  _profileAggregators = [...new Set(relays.filter((r) => r.startsWith("ws")))];
}

export function getProfileAggregators(): string[] {
  return _profileAggregators;
}

export const DEFAULT_TIMEOUT_MS = 4000;

/** @deprecated import `getDefaultRelays()` instead — the constant is
 *  frozen at module load and won't reflect overrides. Kept for back-compat. */
export const DEFAULT_RELAYS = BUILTIN_DEFAULT_RELAYS;

/** @deprecated import `getProfileAggregators()` instead. */
export const PROFILE_AGGREGATORS = BUILTIN_PROFILE_AGGREGATORS;
