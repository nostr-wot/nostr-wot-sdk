'use client';

import type { ReactNode } from 'react';
import {
  NostrDataProvider,
  NostrSessionProvider,
  type NostrSessionProviderProps,
} from '@nostr-wot/data/react';
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
  /** Session context — holds the active signer + pubkey. By default the
   *  provider mounts an empty session so any child can call `useSigner()`
   *  safely. Pass `initialSigner` / `onChange` / `onLogout` to wire your
   *  app's auth, or `{ enabled: false }` to opt out (useful when an
   *  outer `<NostrSessionProvider>` already wraps the tree). */
  session?:
    | ({ enabled?: true } & Omit<NostrSessionProviderProps, 'children'>)
    | { enabled: false };
  /** Web-of-Trust configuration. WoT is opt-in:
   *    - Omit `wot` (or set `wot: { enabled: false }`) → no WoT context;
   *      `useWoTContext()` returns null safely.
   *    - Set `wot: { enabled: true, ... }` → wraps children with the
   *      WoT context so `useWoT`, `useIsInWoT`, `useBatchWoT` work. */
  wot?: { enabled: boolean } & Omit<WoTProviderProps, 'children'>;
}

/**
 * Top-level provider for an app using the full Nostr WoT SDK. Composes:
 *   - `<NostrSessionProvider>` — single mount point for the active signer
 *     + pubkey; consumed by DM hooks, blossom, login UI, etc.
 *   - `<NostrDataProvider>` — sets default relays, profile aggregators,
 *     cache namespace.
 *   - `<WoTProvider>` (optional, when `wot.enabled === true`).
 *
 * For data-only apps with no WoT scoring, depend on `@nostr-wot/data`
 * and use `<NostrDataProvider>` directly — no need to install
 * `@nostr-wot/wot`. For full login UI, install `@nostr-wot/ui` and use
 * its `<NostrSessionProvider>` (a thin shell on top of this one that
 * also handles silent re-attach + theming attributes).
 */
export function NostrSdkProvider({
  children,
  relays,
  profileAggregators,
  cache,
  session,
  wot,
}: NostrSdkProviderProps) {
  const dataProps = {
    ...(relays !== undefined ? { relays } : {}),
    ...(profileAggregators !== undefined ? { profileAggregators } : {}),
    ...(cache !== undefined ? { cache } : {}),
  };
  let tree: ReactNode = (
    <NostrDataProvider {...dataProps}>{children}</NostrDataProvider>
  );
  if (wot?.enabled) {
    const { enabled: _enabled, ...wotProps } = wot;
    tree = <WoTProvider {...wotProps}>{tree}</WoTProvider>;
  }
  // Default: mount session provider with empty signer state. Opt out
  // via `session: { enabled: false }`.
  if (session && session.enabled === false) return tree;
  const { enabled: _se, ...sessionProps } = (session ?? {}) as {
    enabled?: true;
  } & Omit<NostrSessionProviderProps, 'children'>;
  return (
    <NostrSessionProvider {...sessionProps}>{tree}</NostrSessionProvider>
  );
}
