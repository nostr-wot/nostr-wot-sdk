# `@nostr-wot/graph` — Local Web-of-Trust graph in the browser

**Date:** 2026-07-03
**Status:** Design approved, pending spec review
**Repo:** `nostr-wot-sdk` (new package `packages/graph`)

## 1. Motivation

The browser extension used to build a Web-of-Trust follow graph locally (crawl kind:3
contact lists from relays, compute social distance, score trust) and expose it to any
site via `window.nostr.wot`. That subsystem was removed from the extension. We want the
capability back — but as an **SDK package any website can consume directly**, so a site
can build and query its own trust graph in-browser without depending on the extension
or a remote Oracle.

### Cross-origin reality (explicit constraint)

Browser IndexedDB is **origin-scoped**. A graph built on `site-a.com` cannot be read by
`site-b.com`. There is no plain-web mechanism to share a local graph across origins —
true cross-site sharing requires a shared holder (the extension, or a remote Oracle),
which is out of scope here.

**Therefore "reuse for other websites" means: the same reusable package works on any
site, and each origin builds and caches its own graph.** Site A crawls once and caches
in its IndexedDB; Site B does the same independently. This is what is achievable on the
plain web, and it is the scope of this design.

## 2. Goals / Non-goals

**Goals**
- A standalone `@nostr-wot/graph` package: crawl → persist → query trust distance/score, locally.
- Port the extension's proven engine (BFS distance/paths, scoring, delta-encoded IndexedDB
  storage) onto the SDK's `@nostr-wot/relay` `RelayPool` primitive.
- Framework-agnostic core + optional `./react` hooks (matching SDK conventions).
- A thin, optional adapter so `@nostr-wot/wot`'s `WoT` class can use a local graph as a
  query source instead of the Oracle.

**Non-goals**
- Cross-origin graph sharing (see constraint above).
- Re-adding anything to the browser extension or `window.nostr.wot`.
- Real Oracle-side scoring (unchanged; `@nostr-wot/wot` Oracle path is separate).
- Solid support (the SDK is React-only now).

## 3. Prior art being ported

Recovered from the extension git history at commit `1e9c410` (before the WoT sunset):

| Extension file | LOC | Ported into `@nostr-wot/graph` as |
|---|---|---|
| `lib/scoring.ts` | 60 | `src/scoring.ts` — `calculateScore(hops, paths, config)` + `DEFAULT_SCORING` (pure) |
| `lib/graph.ts` (`LocalGraph`) | 426 | `src/graph.ts` — single-pass BFS → hops + shortest-path counts, cached in typed arrays |
| `lib/sync.ts` (`GraphSync`) | 565 | `src/crawl.ts` — `GraphCrawler`, re-based on `RelayPool` instead of raw `WebSocket` |
| `lib/storage.ts` | 766 | `src/storage.ts` — IndexedDB: pubkey↔int interning + delta-encoded follow arrays, namespaced |

The scoring and BFS logic port essentially verbatim (pure, proven). The crawl is rewritten
to use `RelayPool.subscribeMany` for connection/reconnect handling; its BFS scheduling,
newest-per-author selection, and per-relay rate limiting are preserved. The storage layer
ports its interning + delta-encoding, generalized from per-account DBs to a `namespace` key.

## 4. Architecture

Four internal layers plus a facade and a React binding.

```
relays ──RelayPool.subscribeMany(kind:3)──▶ GraphCrawler (BFS, maxDepth)
                                                   │ writes edges
                                                   ▼
                                        storage (IndexedDB: interned + delta-encoded)
                                                   │ hydrate
                                                   ▼
                                        LocalGraph (BFS from root → hops + paths, cached)
                                                   │
                                                   ▼
                                        scoring (hops + paths → 0..1)
                                                   │
                                                   ▼
                                        WotGraph facade  ──▶  React hooks / wot adapter
```

### 4.1 `src/scoring.ts` (pure)
```ts
export interface ScoringConfig {
  distanceWeights: Record<number, number>; // { 1:1.0, 2:0.5, 3:0.25, 4:0.1 }
  pathBonus: Record<number, number>;        // { 2:0.15, 3:0.1, 4:0.05 }
  maxPathBonus: number;                     // 0.5
}
export const DEFAULT_SCORING: ScoringConfig;
export function calculateScore(
  hops: number | null | undefined,
  paths: number | null,
  scoring?: ScoringConfig,
): number; // 0 (not connected) .. 1 (self)
```
No dependencies. Ported verbatim from the extension.

### 4.2 `src/storage.ts` (IndexedDB)
Ported interning + delta-encoded storage, generalized to a `namespace`.
- DB name: `nostr-wot-graph:<namespace>`. Stores: `pubkeys` (id↔hex intern table),
  `follows` (delta-encoded `Uint32Array` of followed ids per author id), `meta`
  (`{ root, lastCrawl, maxDepth, version }`).
- API (internal): `open(namespace)`, `getId(hex)`/`getOrCreateId(hex)`, `getHex(id)`,
  `saveFollows(authorId, followedIds)`, `getFollowIds(authorId)`, `loadAll()` (hydrate
  in-memory maps for BFS), `setMeta`/`getMeta`, `stats()`, `clear()`.
- In-memory fallback: if `indexedDB` is unavailable (Node without polyfill), operate in
  memory-only mode (no persistence) so crawl/query still work. Persistence is a browser
  feature; tests use `fake-indexeddb`.

### 4.3 `src/graph.ts` (`LocalGraph`)
Ported BFS. Given the hydrated follow map and a root pubkey, one BFS pass fills:
- `hops: Uint8Array` indexed by node id (distance from root, 255 = unreached),
- `paths: Uint32Array` indexed by node id (count of shortest paths).
Cached and invalidated on crawl / root change / clear.
- `getDistance(pubkey): { hops, paths } | null` — null when unreached / unknown.
- `getFollows(pubkey): string[]`.

### 4.4 `src/crawl.ts` (`GraphCrawler`)
```ts
new GraphCrawler({ pool: RelayPool, storage, relays });
crawler.crawl(rootPubkey, {
  maxDepth?: number;        // default 2
  onProgress?: (p: { depth: number; fetched: number; queued: number }) => void;
  signal?: AbortSignal;     // cancel
}): Promise<CrawlResult>;   // { fetched, nodes, edges, depth, durationMs, stoppedEarly }
```
- BFS by depth: fetch root's kind:3, enqueue its follows for the next depth, etc.
- For each pubkey, request kind:3 from all relays, pick the **newest** event (highest
  `created_at`); write follows to storage.
- Per-relay rate limiting (base delay + max concurrent), preserved from `GraphSync`.
- Tolerates unreachable relays; throws only if **zero** relays connect.
- Abortable via `signal` or `crawler.stop()`; a stopped crawl leaves partial data usable.
- Invalidates the `LocalGraph` cache on completion.

### 4.5 `src/wot-graph.ts` (`WotGraph` facade)
Ties the layers together; the primary public entry.
```ts
new WotGraph({
  namespace: string;                 // IndexedDB partition key (e.g. app name)
  relays: string[];
  pool?: RelayPool;                  // optional shared pool; else one is created
  scoring?: Partial<ScoringConfig>;
  websocketImplementation?: WebSocketLike; // forwarded to RelayPool (e.g. proxy-safe WS)
});

await wg.load();                             // hydrate from IndexedDB (fast path)
await wg.crawl(rootPubkey, opts);            // build/refresh the graph
wg.getDistance(pubkey): { hops, paths } | null;
wg.getScore(pubkey): number;                 // 0..1 via calculateScore
wg.isInWoT(pubkey, maxHops = 2): boolean;
wg.filterByWoT(pubkeys, opts?): string[];    // trusted subset, sorted by score desc
wg.getFollows(pubkey): string[];
wg.stats(): { nodes, edges, root, lastCrawl, maxDepth };
wg.isStale(ttlMs): boolean;                  // lastCrawl older than ttl
await wg.clear();                            // wipe this namespace
wg.stop();                                   // abort an in-flight crawl
wg.asWoTSource(): WoTLocalSource;            // adapter for @nostr-wot/wot
```

### 4.6 `src/react/` (optional peer)
- `WotGraphProvider` — constructs/holds a `WotGraph`, calls `load()` on mount.
- `useWotGraph()` — the instance + `{ ready, crawling }` state.
- `useDistance(pubkey)` — `{ hops, paths } | null` for a pubkey (recomputes on graph change).
- `useCrawl()` — `{ crawl, stop, progress, crawling, error }`.

### 4.7 `@nostr-wot/wot` integration (thin, optional)
`WotGraph.asWoTSource()` returns an object matching a small `WoTLocalSource` interface
(`getDistance`, `isInMyWoT`, `filterByWoT`). `@nostr-wot/wot`'s `WoT` class gains an
optional `source` option: when a local source is provided, distance/`isInMyWoT`/
`filterByWoT` resolve from it instead of the Oracle. This is a **minor, additive** change
to `@nostr-wot/wot` (no breaking removal), shipped as a `minor` changeset. If it risks the
freshly published `wot` major, it can be deferred — but the adapter method on `WotGraph`
ships regardless so consumers can wire it themselves.

## 5. Package layout & conventions

Mirror `@nostr-wot/relay`:
- `type: module`, tsup build, dual CJS/ESM, `.` + `./react` exports.
- peers: `nostr-tools >=2.0.0`, `react >=16.8.0` (optional), `@nostr-wot/relay` (workspace dep).
- devDeps: `vitest`, `fake-indexeddb`, `typescript`, `tsup`.
- `sideEffects: false`. README + LICENSE + keywords.
- Add to root workspaces and (per the meta reframe) a `./graph` + `./graph/react` re-export
  from `nostr-wot-sdk`.

## 6. Data flow (end to end)

1. Consumer creates `WotGraph({ namespace, relays })`, calls `load()` → hydrates any cached
   graph from IndexedDB (instant if present).
2. If empty or `isStale(ttl)`, calls `crawl(rootPubkey, { maxDepth: 2, onProgress })`.
3. `GraphCrawler` BFS-fetches kind:3 via `RelayPool`, writing interned+delta-encoded follows
   to IndexedDB.
4. On completion, `LocalGraph` runs one BFS from root → `hops`/`paths` typed arrays (cached).
5. Queries (`getDistance`/`getScore`/`isInWoT`/`filterByWoT`) read the cache in O(1)/O(n).
6. On next page load, `load()` rehydrates and reuses the cached graph — no re-crawl unless stale.

## 7. Error handling & edge cases

- **No relays reachable:** `crawl` throws `CrawlError('no relays connected')`; existing cached
  graph (if any) remains queryable.
- **Partial crawl / abort:** whatever was written stays usable; `stoppedEarly: true` in result.
- **Unknown / unreached pubkey:** `getDistance` → `null`; `getScore` → `0`; `isInWoT` → `false`.
- **Self:** `getDistance(root)` → `{ hops: 0, paths: 1 }`; `getScore(root)` → `1`.
- **No IndexedDB (Node):** memory-only mode; crawl/query work, nothing persisted.
- **Huge graphs:** delta-encoded typed-array storage + typed-array BFS keep memory bounded for
  the 100k+ nodes a 2-hop crawl can yield (the reason we port the optimized layer).
- **Concurrent crawls:** a second `crawl()` while one is in flight returns the same in-flight
  promise (idempotent — no double crawl); this keeps React double-renders / strict mode safe.
  Single active crawl per instance.

## 8. Testing (vitest)

- **`scoring.test.ts`** — self=1, unconnected=0, hop weights, path-bonus cap, config override.
- **`graph.test.ts`** — BFS hops + shortest-path counts on hand-built follow maps (diamonds,
  cycles, disconnected nodes, root-only).
- **`storage.test.ts`** — intern round-trip, delta-encode/decode, save/load follows, meta,
  clear, stats — under `fake-indexeddb`.
- **`crawl.test.ts`** — BFS depth control, newest-per-author selection, abort, zero-relay
  error, progress callbacks — against a mock `RelayPool`.
- **`wot-graph.test.ts`** — facade wiring: load→crawl→query, `isStale`, `filterByWoT` ordering,
  `asWoTSource()` shape.
- Add a `test` script to the package; wire into the root test run.

## 9. Rollout

- New package `@nostr-wot/graph@0.1.0` (initial, `minor`/`0.x`).
- Optional `@nostr-wot/wot` `minor` for the `source` option + `nostr-wot-sdk` `minor` for the
  `./graph` re-export. Changesets included.
- Not published in this change — committed with changesets for a later coordinated release.

## 10. Open questions (resolved)

- Cross-site sharing → per-origin only (§1). ✓
- Packaging → dedicated `@nostr-wot/graph`. ✓
- Persistence → port the optimized IndexedDB layer. ✓
- `wot` adapter → include the thin, additive local-source adapter now. ✓
