# @nostr-wot/wot

## 1.0.0

### Major Changes

- [`9e95a70`](https://github.com/nostr-wot/nostr-wot-sdk/commit/9e95a7076bb15e25b048d50c217aaf3759a39d5e) Thanks [@leonacostaok](https://github.com/leonacostaok)! - BREAKING: Remove the browser-extension bridge, trust-score API, and Solid support.

  - Removed the `window.nostr.wot` extension integration: `getExtension`, `isUsingExtension`, `getExtensionStatus`, `getExtensionConfig`, `isConfigured`, `getFollows`, `getCommonFollows`, `getStats`, `getPath`, and the `extensionId` option. Query methods now go straight to the oracle.
  - Removed the always-0 trust score: `getTrustScore`, `getTrustScoreBatch`, the `score` field on `DistanceResult`/`BatchResult`, the `includeScores` batch option, and the React `useTrustScore` hook / `score` fields on `useWoT` and `useBatchWoT`.
  - Removed the Solid entrypoint (`@nostr-wot/wot/solid`) and the `solid-js` peer dependency.
  - Removed the unused `@nostr-wot/data` dependency and internal helpers (`delay`, `createDeferred`, `Deferred`).
  - Removed now-dead types: `ExtensionConnectionStatus`, `ScoringConfig`, `ExtensionConfig`, `ExtensionStatus`, `GraphStats`, `NostrWoTExtension`, `NostrWindow`, `ExtensionDistanceResult`, `NostrContactEvent`.
  - The React provider now constructs the `WoT` instance immediately (no extension-detection polling); `useExtension` and its state types were removed.

  Surviving API: `WoT` class (`getDistance`, `isInMyWoT`, `getDistanceBetween`, `batchCheck`, `filterByWoT`, `getDetails`, `getDistanceBatch`, `getMyPubkey`, `getOracle`) and React `WoTProvider` / `useWoTInstance` / `useWoT` / `useIsInWoT` / `useBatchWoT`.

### Minor Changes

- [`2718ee9`](https://github.com/nostr-wot/nostr-wot-sdk/commit/2718ee9063e3efba025a0f8fd2f190392a187ded) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Add an optional local query `source` to the `WoT` class. When a `WoTLocalSource` is provided (e.g. from `@nostr-wot/graph`'s `WotGraph.asWoTSource()`), `getDistance`, `isInMyWoT`, and `filterByWoT` resolve from it instead of the Oracle. Additive and non-breaking — all other methods still use the Oracle, and omitting `source` keeps the previous behavior. Exports a new `WoTLocalSource` type.

## 0.1.6

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/data@0.5.0

## 0.1.5

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/data@0.4.0

## 0.1.4

### Patch Changes

- @nostr-wot/dm: lift reusable primitives out of obelisk so other clients don't reinvent them.

  New in `@nostr-wot/dm/cache`:

  - `publishInboxRelays(signer, publishRelays, inboxRelays)` — kind-10050 publish, companion to existing `fetchInboxRelays`
  - `backfillInbox(session, opts?)` — paginated kind-1059 + NIP-04 historical walker for first-login partner discovery
  - `setReadCursor` / `markRead` / `getReadCursor` / `getUnreadCount` / `getUnreadCounts` / `subscribeReadCursors` — device-local read-state tracking (never synced to relays)
  - `detectScheme(messages)` — NIP-04 vs NIP-17 prediction from recent message slice
  - `getOrCreateCacheKey(myPubkey, signer)` — XSS-safe per-account KEK (NIP-44-self-encrypted, imported as non-extractable AES-GCM key)
  - `encryptToCache(key, str)` / `decryptFromCache(key, blob)` — at-rest crypto primitives
  - `wrapStorageWithEncryption(storage, key)` — adapter that encrypts any `DMStorage` at rest
  - `KIND_NIP17_INBOX_RELAYS` constant (10050)

  New in `@nostr-wot/dm/react`:

  - `useUnreadCount(myPubkey, partner)` — re-renders on cursor or message changes
  - `useUnreadCounts(myPubkey)` — all unread counts at once
  - `useReadCursors(myPubkey)` — raw cursor map

  Documentation: every package now has a comprehensive README with full API surface, per-entrypoint examples, and TypeScript types. Published to npm.

- Updated dependencies []:
  - @nostr-wot/data@0.3.1

## 0.1.3

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/data@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/data@0.2.0

## 0.1.1

### Patch Changes

- Build fix: tsup now emits the automatic JSX transform (`import { jsx } from 'react/jsx-runtime'`) instead of `React.createElement`, so providers work in Next.js / RSC environments without needing a top-level `import React from 'react'`.

- Updated dependencies []:
  - @nostr-wot/data@0.1.1

## 0.1.0

### Minor Changes

- Restart of the scoped packages at proper semver baselines.

  - `@nostr-wot/data`, `@nostr-wot/relay`, `@nostr-wot/wot` reset to **0.1.0** (initial public release).
  - `nostr-wot-sdk` (back-compat meta-package) bumps to **0.8.1**, declares the new scoped versions.
  - `<NostrSdkProvider>` moved out of `@nostr-wot/wot/react` into `nostr-wot-sdk` so apps that only need data don't have to install the WoT package. Two new providers:
    - `<NostrDataProvider>` in `@nostr-wot/data/react` — configures relays, profile aggregators, and cache.
    - `<NostrSdkProvider>` in `nostr-wot-sdk` — composes `<NostrDataProvider>` plus optional `<WoTProvider>` (opt-in via `wot.enabled`).
  - Keywords added to all four `package.json`s for npm search discoverability.

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/data@0.1.0

## 0.8.0

### Minor Changes

- Initial release of the monorepo split.

  - New `@nostr-wot/data` package: pure-function Nostr data layer (profiles, notes, threads, follows, engagement) with NIP-65 outbox baked into every fetcher. Optional SWR cache + React hooks at `/cache` and `/react` subpaths.
  - New `@nostr-wot/relay` package: standalone relay utilities (`RelayPool`, `QueryBatcher`, `RelayStats`).
  - New `@nostr-wot/wot` package: Web-of-Trust scoring + browser-extension bridge. Adds `<NostrSdkProvider>` — the recommended top-level React provider with WoT opt-in.
  - `nostr-wot-sdk` continues as a back-compat meta-package re-exporting all of the above. Existing imports keep working unchanged.

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/data@0.8.0
