# @nostr-wot/graph

Build and query a **local** Web-of-Trust follow graph in the browser. Crawl kind:3 contact lists over relays, persist them to IndexedDB (pubkey interning + delta-encoded follow arrays), and compute social distance / trust score with an in-memory BFS — no extension and no remote Oracle required.

Ported from the Nostr WoT browser extension's proven engine and re-based onto [`@nostr-wot/relay`](../relay)'s pool.

> **Cross-origin note:** IndexedDB is origin-scoped, so a graph built on `site-a.com` cannot be read by `site-b.com`. This package is reusable on _any_ site, but each origin crawls and caches its own graph.

## Install

```bash
npm i @nostr-wot/graph @nostr-wot/relay nostr-tools
```

## Quick start

```ts
import { WotGraph } from "@nostr-wot/graph";

const wg = new WotGraph({
  namespace: "myapp",                       // IndexedDB partition key
  relays: ["wss://relay.damus.io", "wss://nos.lol"],
});

await wg.load();                            // rehydrate cached graph (instant if present)

if (wg.isStale(24 * 60 * 60 * 1000)) {      // older than a day?
  await wg.crawl(myPubkey, {
    maxDepth: 2,
    onProgress: (p) => console.log(p.depth, p.fetched, p.queued),
  });
}

wg.getDistance(target);   // { hops, paths } | null
wg.getScore(target);      // 0..1
wg.isInWoT(target, 2);    // boolean
wg.filterByWoT(pubkeys);  // trusted subset, sorted by score desc
```

## API

| Method | Description |
|---|---|
| `load()` | Hydrate the cached graph from IndexedDB. |
| `crawl(root, opts)` | BFS-fetch kind:3 to build/refresh the graph. Concurrent calls share one in-flight promise. |
| `getDistance(pubkey, maxHops=6)` | `{ hops, paths }` from the crawled root, or `null`. |
| `getDistances(pubkeys, maxHops=6)` | Batch distances sharing one traversal. |
| `getScore(pubkey)` | Trust score `0..1` (`calculateScore`). |
| `isInWoT(pubkey, maxHops=2)` | Within `maxHops` of the root. |
| `filterByWoT(pubkeys, opts?)` | Trusted subset, sorted by score descending. |
| `getFollows(pubkey)` | Follow list (hex). |
| `stats()` | `{ nodes, edges, root, lastCrawl, maxDepth }`. |
| `isStale(ttlMs)` | Last crawl older than `ttlMs`. |
| `clear()` | Wipe this namespace. |
| `stop()` | Abort an in-flight crawl (partial data stays usable). |
| `asWoTSource()` | Adapter for `@nostr-wot/wot`. |

### `crawl` options

```ts
crawl(rootPubkey, {
  maxDepth?: number;            // inclusive fetched author depth, default 2
  maxHops?: number;             // optional hop boundary; overrides maxDepth
  onProgress?: (p) => void;     // { depth, fetched, queued }
  signal?: AbortSignal;         // cancel
}): Promise<CrawlResult>;       // { fetched, nodes, edges, depth, durationMs, stoppedEarly }
```

Crawls tolerate missing relay responses. Zero configured relays throw `CrawlError`; invalid options, transport exceptions and persistence failures propagate. In Node without an IndexedDB polyfill the store runs memory-only (crawl/query work, nothing persists).

## React (`/react`)

```tsx
import { WotGraphProvider, useWotGraph, useDistance, useCrawl } from "@nostr-wot/graph/react";

<WotGraphProvider namespace="myapp" relays={["wss://relay.damus.io"]}>
  <App />
</WotGraphProvider>;

function Trust({ pubkey }: { pubkey: string }) {
  const dist = useDistance(pubkey);
  return <span>{dist ? `${dist.hops} hops` : "unknown"}</span>;
}

function CrawlButton({ me }: { me: string }) {
  const { crawl, crawling, progress } = useCrawl();
  return (
    <button disabled={crawling} onClick={() => crawl(me, { maxDepth: 2 })}>
      {crawling ? `depth ${progress?.depth ?? 0}…` : "Build graph"}
    </button>
  );
}
```

## Use as a `@nostr-wot/wot` source

```ts
import { WoT } from "@nostr-wot/wot";

const wot = new WoT({ source: wg.asWoTSource() }); // resolve locally instead of the Oracle
await wot.getDistance(target);
```

## License

MIT


## Graph efficiency and compatibility

Crawling batches up to 100 authors per subscription (configurable through
`GraphCrawler.batchSize`). The filter has no global event limit, so one author's
history cannot consume another author's slot. The newest kind:3 wins by timestamp,
then lowest event ID; versions persist with follow rows so stale refreshes cannot
replace a newer list. A missing response retains cached follows for traversal.
Unrequested authors, other kinds and timestamps more than 60 seconds in the future
are ignored. The supplied pool remains responsible for event signature verification.

`maxDepth` keeps its existing inclusive author-depth meaning: `maxDepth: 1` fetches
the root and its direct follows, discovering people two hops away. Use `maxHops: 2`
to fetch just the lists needed for two-hop reachability; authors at distance two
are not fetched. `maxHops: 0` sends no requests. Query defaults remain six hops;
pass an explicit query bound when exploring further.

Storage interns keys, deduplicates adjacency and maintains edge counts as rows
change. IndexedDB schema version 2 writes delta-varint rows; existing version-1
fixed-width rows load without a full rewrite and migrate when updated. Older SDK
versions cannot reopen an upgraded namespace (IndexedDB reports `VersionError`),
so rolling back requires a different namespace or clearing the upgraded database.
Transactions preserve pending rows on failure, serialize flushes, and atomically
write each batch of follow rows with its key mappings and event versions. Metadata
writes use one separate transaction. A crawl is **not** a whole-graph transaction:
partial results remain queryable, and stopped crawls are marked stale.

One numeric BFS serves repeated queries and shallower bounds until edges change
or a deeper traversal is needed. Duplicate follows do not inflate paths. Distances
use 32-bit arrays and path counts use 64-bit floats, saturated at
`Number.MAX_SAFE_INTEGER`; this uses more traversal memory than the former 8-bit
hops/32-bit paths while avoiding overflow. No TTL-based incremental relay sync,
root-based pruning or cross-instance live cache synchronization is implemented.

Run `npm run benchmark -w @nostr-wot/graph` from the repository root for reproducible
synthetic construction, cold traversal and warm retrieval timings. Regression
fixtures verify 251 authors use 4 requests instead of 251 (98.4% fewer), 1,000 dense
follow IDs use 1,000 encoded bytes instead of 4,000 (75% smaller payload), and 1,000
unchanged queries traverse a three-node graph only once. These figures describe
fixtures; relay latency and IndexedDB record overhead are not included.
