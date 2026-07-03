---
"@nostr-wot/wot": major
---

BREAKING: Remove the browser-extension bridge, trust-score API, and Solid support.

- Removed the `window.nostr.wot` extension integration: `getExtension`, `isUsingExtension`, `getExtensionStatus`, `getExtensionConfig`, `isConfigured`, `getFollows`, `getCommonFollows`, `getStats`, `getPath`, and the `extensionId` option. Query methods now go straight to the oracle.
- Removed the always-0 trust score: `getTrustScore`, `getTrustScoreBatch`, the `score` field on `DistanceResult`/`BatchResult`, the `includeScores` batch option, and the React `useTrustScore` hook / `score` fields on `useWoT` and `useBatchWoT`.
- Removed the Solid entrypoint (`@nostr-wot/wot/solid`) and the `solid-js` peer dependency.
- Removed the unused `@nostr-wot/data` dependency and internal helpers (`delay`, `createDeferred`, `Deferred`).
- Removed now-dead types: `ExtensionConnectionStatus`, `ScoringConfig`, `ExtensionConfig`, `ExtensionStatus`, `GraphStats`, `NostrWoTExtension`, `NostrWindow`, `ExtensionDistanceResult`, `NostrContactEvent`.
- The React provider now constructs the `WoT` instance immediately (no extension-detection polling); `useExtension` and its state types were removed.

Surviving API: `WoT` class (`getDistance`, `isInMyWoT`, `getDistanceBetween`, `batchCheck`, `filterByWoT`, `getDetails`, `getDistanceBatch`, `getMyPubkey`, `getOracle`) and React `WoTProvider` / `useWoTInstance` / `useWoT` / `useIsInWoT` / `useBatchWoT`.
