'use client';

import { useEffect, type ReactNode } from 'react';
import {
  setDefaultRelays,
  setProfileAggregators,
  configurePersistence,
} from '@nostr-wot/data';
import { WoTProvider } from './context';
import type { WoTProviderProps } from './context';

export interface NostrSdkProviderProps {
  children: ReactNode;

  /**
   * Override the default relay set used by all data fetchers.
   * If absent, the SDK's built-in defaults apply.
   */
  relays?: string[];

  /**
   * Specialised aggregators for kind-0 lookups (purplepag.es-style).
   * Hit alongside the main relay set when fetching profiles.
   */
  profileAggregators?: string[];

  /**
   * Cache configuration. The SDK persists profiles + follows + relay
   * lists to localStorage so cold loads render instantly with stale data
   * before the network refresh lands.
   */
  cache?: {
    namespace?: string;
    ttlMs?: number;
  };

  /**
   * Web-of-Trust configuration. WoT is opt-in: leave `wot` unset and
   * `useWoTContext()` returns null safely. Set `wot.enabled: true` and
   * the provider also wraps children with the existing WoT context.
   */
  wot?: {
    enabled: boolean;
  } & Omit<WoTProviderProps, 'children'>;
}

/**
 * Top-level provider for an app using the Nostr WoT SDK. Configures the
 * data layer (relays, profile aggregators, cache) and optionally wraps
 * children with WoT context.
 *
 * Data hooks (`useProfile`, `useNote`, `useThread`, `useEngagement`, …)
 * work without this provider — it's purely a configuration / WoT
 * convenience. WoT hooks (`useWoT`, `useTrustScore`, …) require
 * `wot.enabled: true` here OR a separate `<WoTProvider>` somewhere up
 * the tree.
 *
 * Example:
 * ```tsx
 * <NostrSdkProvider
 *   relays={['wss://relay.damus.io', 'wss://nos.lol']}
 *   profileAggregators={['wss://purplepag.es']}
 *   cache={{ namespace: 'myapp', ttlMs: 24 * 3600_000 }}
 *   wot={{ enabled: true, options: { extensionId: 'abc' } }}
 * >
 *   <App />
 * </NostrSdkProvider>
 * ```
 */
export function NostrSdkProvider({
  children,
  relays,
  profileAggregators,
  cache,
  wot,
}: NostrSdkProviderProps) {
  useEffect(() => {
    if (relays && relays.length > 0) setDefaultRelays(relays);
    if (profileAggregators) setProfileAggregators(profileAggregators);
    if (cache) configurePersistence(cache);
  }, [relays, profileAggregators, cache]);

  if (wot?.enabled) {
    const { enabled: _enabled, ...wotProps } = wot;
    return <WoTProvider {...wotProps}>{children}</WoTProvider>;
  }
  return <>{children}</>;
}
