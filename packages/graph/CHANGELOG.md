# @nostr-wot/graph

## 1.0.2

### Patch Changes

- Updated dependencies [[`6ba2fc0`](https://github.com/nostr-wot/nostr-wot-sdk/commit/6ba2fc0a07a10d092f53ae5cb01592fdcf23932f)]:
  - nostr-wot-sdk@3.0.1
  - @nostr-wot/wot@3.0.1

## 1.0.2-next.0

### Patch Changes

- Updated dependencies [[`6ba2fc0`](https://github.com/nostr-wot/nostr-wot-sdk/commit/6ba2fc0a07a10d092f53ae5cb01592fdcf23932f)]:
  - nostr-wot-sdk@3.0.1-next.0
  - @nostr-wot/wot@3.0.1-next.0

## 1.0.1

### Patch changes

- Replace the implementation with a compatibility re-export of `@nostr-wot/wot/graph` from `@nostr-wot/wot` 3.0.0. Preserve the existing public import entry points; new consumers should install the maintained owner and import its module directly.
- Mark this package for deprecation after its replacement is published and available. See the [migration guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/docs/package-migration.md).

## 1.0.0

### Major Changes

- [#16](https://github.com/nostr-wot/nostr-wot-sdk/pull/16) [`c609a4b`](https://github.com/nostr-wot/nostr-wot-sdk/commit/c609a4b64d7cb44173472eef919a602065476d8a) Thanks [@leonacostaok](https://github.com/leonacostaok)! - License project-owned code under GNU General Public License version 3 only (GPL-3.0-only). Include the full license and preserved prior MIT notice in every package. Previously released versions keep their original license.

### Patch Changes

- Updated dependencies [[`c609a4b`](https://github.com/nostr-wot/nostr-wot-sdk/commit/c609a4b64d7cb44173472eef919a602065476d8a)]:
  - @nostr-wot/relay@1.0.0

## 0.3.1

### Patch Changes

- [#11](https://github.com/nostr-wot/nostr-wot-sdk/pull/11) [`b0bea82`](https://github.com/nostr-wot/nostr-wot-sdk/commit/b0bea82dfa89e43d71eb995de10f1c1cdb6d65ee) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Simplify the README around usage, crawl depth, persistence and upgrade compatibility. Move synthetic performance comparisons into the changelog. No runtime changes.

## 0.3.0

### Minor Changes

- [#10](https://github.com/nostr-wot/nostr-wot-sdk/pull/10) [`50db2e2`](https://github.com/nostr-wot/nostr-wot-sdk/commit/50db2e28f5a1d5069f720b7e4c1aff3cdd9f3cb5) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Batch author crawling and add explicit hop bounds, revision-aware numeric queries,
  deterministic persisted list versions, and compact schema-2 delta-varint graph rows.
  Preserve inclusive maxDepth and legacy row reads. Flush failures retain pending
  writes; stopped crawls remain stale. Upgraded namespaces require schema-2-aware
  SDKs; old SDKs cannot reopen them. Add regression tests and a synthetic benchmark.

### Performance notes

Compared with 0.2.0, the 251-author regression fixture uses 4 relay subscriptions
instead of 251. A dense list of 1,000 consecutive follow IDs encodes to 1,000 bytes
instead of 4,000. These are synthetic fixtures, excluding network latency and
IndexedDB record overhead; they are not whole-database or production measurements.

Traversal caching already existed in 0.2.0. The updated tests check correct reuse
across hop limits and invalidation after graph changes, rather than establishing
a new caching speedup. Run `npm run benchmark -w @nostr-wot/graph` from the repository
root for current construction and query timings; those timings do not include a
before-and-after baseline.

## 0.2.0

### Minor Changes

- [`2718ee9`](https://github.com/nostr-wot/nostr-wot-sdk/commit/2718ee9063e3efba025a0f8fd2f190392a187ded) Thanks [@leonacostaok](https://github.com/leonacostaok)! - New package: a standalone, local Web-of-Trust follow graph for the browser.

  - Crawl kind:3 contact lists over relays (`GraphCrawler`, re-based on `@nostr-wot/relay`'s pool), persist them to IndexedDB with pubkey interning + delta-encoded follow arrays (`GraphStorage`, namespaced per app), and compute social distance / shortest-path counts with a cached typed-array BFS (`LocalGraph`).
  - `WotGraph` facade: `load`, `crawl`, `getDistance`, `getScore`, `isInWoT`, `filterByWoT`, `getFollows`, `stats`, `isStale`, `clear`, `stop`, and `asWoTSource()` (adapter for `@nostr-wot/wot`).
  - Optional `./react` entrypoint: `WotGraphProvider`, `useWotGraph`, `useDistance`, `useCrawl`.
  - Pure `calculateScore` + `DEFAULT_SCORING`. In-memory fallback when IndexedDB is unavailable (Node).

  Ported from the browser extension's proven engine (BFS, scoring, delta-encoded storage), with the raw-WebSocket transport rewritten onto `RelayPool`.
