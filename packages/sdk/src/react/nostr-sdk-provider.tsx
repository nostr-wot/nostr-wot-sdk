'use client';

import type { ReactNode } from 'react';
import { NostrDataProvider } from '@nostr-wot/data/react';
import { WoTProvider, type WoTProviderProps } from '@nostr-wot/wot/react';

export interface NostrSdkProviderProps {
  children: ReactNode;
  /** Override the default relay set used by all data fetchers. */
  relays?: string[];
  /** Specialised aggregators for kind-0 lookups (e.g. purplepag.es). */
  profileAggregators?: string[];
  /** Cache configuration. The SWR layer persists profiles, follows,
   *  and relay-lists to localStorage by default. */
  cache?: {
    namespace?: string;
    ttlMs?: number;
  };
  /** Web-of-Trust configuration. WoT is opt-in:
   *    - Omit `wot` (or set `wot: { enabled: false }`) → no WoT context;
   *      `useWoTContext()` returns null safely.
   *    - Set `wot: { enabled: true, ... }` → wraps children with the
   *      WoT context so `useWoT`, `useTrustScore`, `useIsInWoT`,
   *      `useBatchWoT` work. */
  wot?: { enabled: boolean } & Omit<WoTProviderProps, 'children'>;
}

/**
 * Top-level provider for an app using the full Nostr WoT SDK. Composes:
 *   - `<NostrDataProvider>` — sets default relays, profile aggregators,
 *     cache namespace.
 *   - `<WoTProvider>` (optional, when `wot.enabled === true`).
 *
 * For data-only apps (no WoT scoring), depend on `@nostr-wot/data` and
 * use `<NostrDataProvider>` directly — no need to install `@nostr-wot/wot`.
 */
export function NostrSdkProvider({
  children,
  relays,
  profileAggregators,
  cache,
  wot,
}: NostrSdkProviderProps) {
  const dataProps = {
    ...(relays !== undefined ? { relays } : {}),
    ...(profileAggregators !== undefined ? { profileAggregators } : {}),
    ...(cache !== undefined ? { cache } : {}),
  };
  const wrapped = <NostrDataProvider {...dataProps}>{children}</NostrDataProvider>;
  if (wot?.enabled) {
    const { enabled: _enabled, ...wotProps } = wot;
    return <WoTProvider {...wotProps}>{wrapped}</WoTProvider>;
  }
  return wrapped;
}
