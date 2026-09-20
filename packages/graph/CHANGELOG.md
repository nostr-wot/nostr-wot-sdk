# @nostr-wot/graph

## 0.3.0

### Minor Changes

- [#10](https://github.com/nostr-wot/nostr-wot-sdk/pull/10) [`50db2e2`](https://github.com/nostr-wot/nostr-wot-sdk/commit/50db2e28f5a1d5069f720b7e4c1aff3cdd9f3cb5) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Batch author crawling and add explicit hop bounds, revision-aware numeric queries,
  deterministic persisted list versions, and compact schema-2 delta-varint graph rows.
  Preserve inclusive maxDepth and legacy row reads. Flush failures retain pending
  writes; stopped crawls remain stale. Upgraded namespaces require schema-2-aware
  SDKs; old SDKs cannot reopen them. Add regression tests and a synthetic benchmark.

## 0.2.0

### Minor Changes

- [`2718ee9`](https://github.com/nostr-wot/nostr-wot-sdk/commit/2718ee9063e3efba025a0f8fd2f190392a187ded) Thanks [@leonacostaok](https://github.com/leonacostaok)! - New package: a standalone, local Web-of-Trust follow graph for the browser.

  - Crawl kind:3 contact lists over relays (`GraphCrawler`, re-based on `@nostr-wot/relay`'s pool), persist them to IndexedDB with pubkey interning + delta-encoded follow arrays (`GraphStorage`, namespaced per app), and compute social distance / shortest-path counts with a cached typed-array BFS (`LocalGraph`).
  - `WotGraph` facade: `load`, `crawl`, `getDistance`, `getScore`, `isInWoT`, `filterByWoT`, `getFollows`, `stats`, `isStale`, `clear`, `stop`, and `asWoTSource()` (adapter for `@nostr-wot/wot`).
  - Optional `./react` entrypoint: `WotGraphProvider`, `useWotGraph`, `useDistance`, `useCrawl`.
  - Pure `calculateScore` + `DEFAULT_SCORING`. In-memory fallback when IndexedDB is unavailable (Node).

  Ported from the browser extension's proven engine (BFS, scoring, delta-encoded storage), with the raw-WebSocket transport rewritten onto `RelayPool`.
