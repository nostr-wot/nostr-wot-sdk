'use client';

import { useEffect, type ReactNode } from 'react';
import { setDefaultRelays, setProfileAggregators } from '../pool';
import { configurePersistence } from '../cache/persistence';

export interface NostrDataProviderProps {
  children: ReactNode;
  /** Override the default relay set used by all data fetchers. */
  relays?: string[];
  /** Specialised aggregators for kind-0 lookups (e.g. purplepag.es). */
  profileAggregators?: string[];
  /** Cache configuration. The SWR layer persists profiles, follows, and
   *  relay-lists to localStorage by default. */
  cache?: {
    namespace?: string;
    ttlMs?: number;
  };
}

/**
 * Minimal top-level provider for `@nostr-wot/data`. Configures the
 * default relay set, profile aggregators, and cache namespace via the
 * underlying setters.
 *
 * No React context is created — settings live on module globals so any
 * data hook (`useProfile`, `useNote`, …) picks them up automatically.
 *
 * For an app that ALSO uses `@nostr-wot/wot`, prefer the unified
 * `<NostrSdkProvider>` from `nostr-wot-sdk` (which composes this
 * provider plus the WoT context with a `wot.enabled` opt-in flag).
 *
 * Example:
 * ```tsx
 * <NostrDataProvider
 *   relays={['wss://relay.damus.io', 'wss://nos.lol']}
 *   profileAggregators={['wss://purplepag.es']}
 *   cache={{ namespace: 'myapp' }}
 * >
 *   <App />
 * </NostrDataProvider>
 * ```
 */
export function NostrDataProvider({
  children,
  relays,
  profileAggregators,
  cache,
}: NostrDataProviderProps) {
  useEffect(() => {
    if (relays && relays.length > 0) setDefaultRelays(relays);
    if (profileAggregators) setProfileAggregators(profileAggregators);
    if (cache) configurePersistence(cache);
  }, [relays, profileAggregators, cache]);

  return <>{children}</>;
}
