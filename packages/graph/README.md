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
| `getDistance(pubkey)` | `{ hops, paths }` from the crawled root, or `null`. |
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
  maxDepth?: number;            // default 2
  onProgress?: (p) => void;     // { depth, fetched, queued }
  signal?: AbortSignal;         // cancel
}): Promise<CrawlResult>;       // { fetched, nodes, edges, depth, durationMs, stoppedEarly }
```

Crawls tolerate unreachable relays and only throw `CrawlError` if **zero** relays are configured. In Node without an IndexedDB polyfill the store runs memory-only (crawl/query work, nothing persists).

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
