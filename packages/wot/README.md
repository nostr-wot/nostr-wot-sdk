# @nostr-wot/wot

Web-of-Trust distance queries for Nostr. Query the public kind-3 follow graph through an Oracle HTTP API with `WoT`, or build and query a local graph with `WotGraph`. React hooks are separate entry points.

## Which Oracle

[nostr-wot-oracle](https://github.com/nostr-wot/nostr-wot-oracle), the Rust service behind the project's public instance at `https://wot-oracle.mappingbitcoin.com`, which is this package's default. Point `oracle` at your own deployment of that same service to self-host; the base may include a path prefix.

The wire shapes come from that repository's [`docs/API.md`](https://github.com/nostr-wot/nostr-wot-oracle/blob/main/docs/API.md) and `src/api/http.rs`. Three of its guarantees shape this API:

- **`hops: null` is not "no connection".** It means no route was found within the depth
  searched in the currently indexed graph. `getDistance` returns `null` and `getDetails`
  returns `null` for it.
- **A 404 is not an answer.** The Oracle reports an unreached target on a 200, so a 404
  is a route it does not serve. It raises `NotFoundError` rather than being read as "not
  in the web of trust", because a wrong base URL would otherwise look like an empty
  graph.
- **`maxHops` is clamped to 1..5.** Outside that range the Oracle answers 400, so a
  requested depth is brought into range before it is sent rather than failing the query.

Requests go to `GET /distance` and `POST /distance/batch`. Nothing is sent to a path under `/api`.

## Install

```bash
npm i @nostr-wot/wot nostr-tools
```

## Entry points

| Import path | What's in it | Depends on |
|---|---|---|
| `@nostr-wot/wot` | `WoT` class — vanilla JS API | none beyond peers |
| `@nostr-wot/wot/react` | `<WoTProvider>`, `useWoTInstance`, `useWoT`, `useIsInWoT`, `useBatchWoT` | + `react` (peer) |
| `@nostr-wot/wot/graph` | `WotGraph`: crawl follows, persist to IndexedDB, compute local distances and scores | + `nostr-wot-sdk` (optional peer required for graph imports) |
| `@nostr-wot/wot/graph/react` | `WotGraphProvider`, `useDistance`, `useCrawl` and graph hooks | + `react` (peer) |

## Quick start

```ts
import { WoT } from "@nostr-wot/wot";

const wot = new WoT({
  myPubkey: "hex-pubkey-of-the-user",
  maxHops: 3,
});

const hops = await wot.getDistance("hex-target-pubkey");
// → number of hops (e.g. 2) or null if not reachable within maxHops

const inWoT = await wot.isInMyWoT("hex-target-pubkey");
// → boolean
```

### Configuration

```ts
new WoT({
  oracle?: string;   // Oracle API URL (default: https://wot-oracle.mappingbitcoin.com)
  myPubkey?: string; // your pubkey (hex) — required for queries
  maxHops?: number;  // default search depth (default: 3)
  timeout?: number;  // request timeout in ms (default: 5000)
  fallback?: { oracle?; myPubkey; maxHops?; timeout? };
});
```

Per-query options are `{ maxHops?, timeout?, includeBridges? }`.

## API surface

```ts
class WoT {
  constructor(opts?: WoTOptions);

  // Shortest hop distance to a target, or null if unreachable within maxHops.
  getDistance(target: string, options?: QueryOptions): Promise<number | null>;

  // Convenience boolean: is target within maxHops?
  isInMyWoT(target: string, options?: QueryOptions): Promise<boolean>;

  // Hop distance between any two pubkeys.
  getDistanceBetween(from: string, to: string, options?: QueryOptions): Promise<number | null>;

  // Batch reachability check → Map<pubkey, { pubkey, distance, inWoT }>.
  batchCheck(targets: string[], options?: QueryOptions): Promise<Map<string, BatchResult>>;

  // Keep only the pubkeys within your WoT.
  filterByWoT(pubkeys: string[], options?: QueryOptions): Promise<string[]>;

  // Distance, path count and mutual-follow flag. Pass `includeBridges` to also
  // ask for the Oracle's `bridges`, which it omits unless requested.
  getDetails(target: string, options?: QueryOptions): Promise<DistanceResult | null>;

  // Batch hop distances (optionally with path counts).
  getDistanceBatch(targets: string[], options?: boolean | DistanceBatchOptions): Promise<Record<string, ...>>;

  getMyPubkey(): Promise<string>;
  getOracle(): string;
}
```

## React

```tsx
import {
  WoTProvider,
  useWoTInstance,
  useIsInWoT,
  useBatchWoT,
} from "@nostr-wot/wot/react";

function App() {
  return (
    <WoTProvider options={{ myPubkey, maxHops: 3 }}>
      <Feed />
    </WoTProvider>
  );
}

function TrustBadge({ pubkey }: { pubkey: string }) {
  const { inWoT, loading } = useIsInWoT(pubkey, { maxHops: 2 });
  if (loading) return null;
  return inWoT ? <span>Trusted</span> : null;
}

function Feed({ authors }: { authors: string[] }) {
  const { results } = useBatchWoT(authors);
  // results: Map<pubkey, { distance, inWoT }>
  return authors.map((pk) => (results.get(pk)?.inWoT ? <Note key={pk} pubkey={pk} /> : null));
}
```

`useWoTInstance()` returns the underlying `WoT` instance for direct calls.

## Local graph (unreleased consolidation)

```bash
npm install @nostr-wot/wot nostr-wot-sdk nostr-tools
```

```ts
import { WotGraph } from "@nostr-wot/wot/graph";

const graph = new WotGraph({ namespace: "myapp", relays: ["wss://relay.damus.io"] });
await graph.load();
await graph.crawl(myPubkey, { maxHops: 2 });
const distance = graph.getDistance(targetPubkey);
// Stop outstanding crawl work when the owning view/session is disposed.
graph.stop();
```

The local graph belongs to this package in the consolidation release. It previously shipped as `@nostr-wot/graph`. Install `nostr-wot-sdk` for its relay transport. Saved graphs are origin-scoped in IndexedDB; without IndexedDB the graph stays in memory. A crawl can be partial, and missing data is not proof of no social connection. See the [graph API guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/graph/README.md) for depth limits, cancellation, errors, refresh behavior and React examples.

## License

GNU General Public License version 3 only (`GPL-3.0-only`) — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
