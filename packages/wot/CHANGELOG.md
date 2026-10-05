# @nostr-wot/wot

## 1.1.0

### Minor Changes

- [`546a268`](https://github.com/nostr-wot/nostr-wot-sdk/commit/546a268b559e853c63fdc554e2354a13c3889f20) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Speak nostr-wot-oracle's real contract in the `WoT` class.

  Every remote query in this package addressed a server that does not exist. The default
  oracle, `https://wot-oracle.mappingbitcoin.com`, answers `GET /` with
  `{"service":"nostr-wot-oracle","version":"0.3.1"}` and its own endpoint list, and this
  client's routes are in none of it. Checked against that repository's `docs/API.md`,
  `src/api/http.rs` and `src/graph/bfs.rs`, the two disagreed on eight points, and every
  one of them failed silently:

  - Distance is `GET /distance?from=&to=&max_hops=`, not `GET /api/distance/FROM/TO?maxHops=`.
    Nothing is served under `/api`.
  - The distance field is `hops`, not `distance`. `bfs::DistanceResult` has no `distance`
    member, so `getDistance` resolved `undefined` where it promises `number | null`, and
    `isInMyWoT` turned that into a quiet `false`.
  - There is no `/details` route. `GET /distance` already carries the detail, so
    `getDetails` asks that.
  - The path count is `path_count`, not `paths`.
  - The mutual-follow flag is `mutual_follow`, not `mutual`.
  - Batch distance is `POST /distance/batch` with a JSON body, not
    `GET /api/batch/FROM?targets=a,b`, and it accepts up to 100 targets rather than the 50
    this client chunked to for a URL length limit that no longer applies.
  - A batch result names its endpoints `from` and `to`. There is no `pubkey` member, so
    `batchCheck` filed every result under the key `"undefined"` and no target could be
    found in the map it returned.
  - `max_hops` was never sent, so the server's default of 3 decided the depth: a caller
    configured to 2 was answered at 3. It is now sent, clamped to the 1..5 the oracle
    accepts, since a value it rejects is a 400 rather than a shallower answer.

  A 404 is now raised instead of being reported as an unreached target. nostr-wot-oracle
  reports "no route found within the depth searched" as `hops: null` on a 200 and never as
  a 404, so a 404 means the client is not talking to the server it thinks it is. Reading it
  as "not in the web of trust" is what let this package point at the right host and report
  an empty graph for every query. Callers that treated `null` as unreachable keep working;
  a caller pointed at a wrong base URL now hears about it.

  A saturated `path_count` is clamped rather than refused: the oracle documents that counts
  saturate at the maximum unsigned 64-bit integer, which is past `Number.MAX_SAFE_INTEGER`.

  Adds `QueryOptions.includeBridges`, off by default like the oracle's own
  `include_bridges`, because `DistanceResult.bridges` was otherwise unreachable. Its
  documentation now says what the oracle actually returns: the meeting nodes of a
  bidirectional search, not the first hop on a path. Exports `ORACLE_MIN_HOPS`,
  `ORACLE_MAX_HOPS`, `ORACLE_MAX_BATCH_TARGETS` and `clampMaxHops`.

  Eighteen tests, written from the oracle repository, pin each wire field and each of these
  divergences. All eighteen fail against the previous spelling.

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
