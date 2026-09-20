# @nostr-wot/graph

Build and query a **local** Web-of-Trust follow graph in the browser. Crawl kind:3 contact lists over relays, save them in IndexedDB, and compute social distance and trust scores locally — no extension and no remote Oracle required.

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

await wg.load();                            // load the saved graph

if (wg.isStale(24 * 60 * 60 * 1000)) {      // older than a day?
  await wg.crawl(myPubkey, {
    maxHops: 2,
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

### Choosing a crawl depth

Use `maxHops: 2` to discover people up to two follows away: the crawler fetches
lists for the root and its direct follows. `maxHops: 0` sends no requests.

`maxDepth` counts the depth of authors whose lists are fetched, starting at zero
for the root. For example, `maxDepth: 1` fetches the same lists as `maxHops: 2`.
When both options are supplied, `maxHops` takes precedence.

Distance queries default to six hops. Pass a `maxHops` argument to query a
different range within the graph you have collected.

## Refreshing and saving the graph

Call `crawl()` to refresh the graph. The newest contact list replaces the saved
list; missing relay responses retain previously saved follows. Stopping a crawl
keeps partial results available and marks the graph stale. Refreshes do not remove
unreachable authors from storage; use `clear()` to start over.

Each namespace has its own saved graph. Separate instances do not automatically
synchronize their in-memory copies. Without IndexedDB, data remains in memory only.
If you provide a custom relay pool, it must verify event signatures.

### Upgrading from versions before 0.3.0

Opening an existing namespace upgrades its IndexedDB database to schema 2 while
preserving saved follows. Older package versions cannot open an upgraded database.
To downgrade, use a different namespace or clear the upgraded database first.

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
    <button disabled={crawling} onClick={() => crawl(me, { maxHops: 2 })}>
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
