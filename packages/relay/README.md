# nostr-wot-sdk/relay

> Package consolidation: this is the API guide for `nostr-wot-sdk/relay`. The former `@nostr-wot/relay` package is a deprecated compatibility re-export. Install the owning package shown below; a subpath is an import, not an npm package. See the [migration guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/docs/package-migration.md).

Low-level Nostr relay utilities. A pool that manages WebSocket connections, a query batcher that merges concurrent filters, and a stats tracker that records per-relay latency / success rates. Extracted from the WoT SDK so any Nostr project can use these primitives without pulling in WoT scoring code.

> Most apps want **`nostr-wot-sdk/data`** instead — it builds on top of these primitives and exposes higher-level fetchers (profiles, notes, threads, follows). Reach for `nostr-wot-sdk/relay` only when you need to roll your own data layer or instrument relay performance.

## Install

```bash
npm i nostr-wot-sdk nostr-tools
```

## Two entrypoints

| Import path | What's in it |
|---|---|
| `nostr-wot-sdk/relay` | `RelayPool`, `RelayManager`, `QueryBatcher`, `RelayStats` |
| `nostr-wot-sdk/relay/react` | React provider + hooks for the above |

## RelayPool

Wrap a compatible `PoolLike` transport with configured relay URLs, batching, subscriptions and connection status. `RelayPool` is not a drop-in `SimplePool` replacement; pass a `SimplePool` instance through `pool` or initialize one with `ensurePool`.

```ts
import { SimplePool } from "nostr-tools";
import { RelayPool } from "nostr-wot-sdk/relay";

const pool = new RelayPool({
  urls: ["wss://relay.damus.io", "wss://nos.lol"],
  pool: new SimplePool(),
});
const subscription = pool.subscribe(
  { kinds: [1], limit: 50 },
  { onEvent: event => console.log(event.id) },
);
await pool.publish(signedEvent);
subscription.close();
pool.destroy();
```

`query(filter)` batches reads; `queryImmediate(filter)` flushes immediately. `getUrls`, `setUrls`, `addRelay` and `removeRelay` manage relay selection. `getStatuses` returns a map of connection booleans, and `getConnectedCount` counts connected relays. A subscription reports `connected`, `eose` or `disconnected`; close its returned handle on teardown. Calling `subscribe` before initializing the underlying pool throws.

## QueryBatcher

Merge compatible reads over a supplied transport. The default debounce window is 100 ms; the default first-event timeout is 3000 ms and maximum subscription wait is 5000 ms. Supply options to the constructor's second argument.

```ts
import { SimplePool } from "nostr-tools";
import { QueryBatcher } from "nostr-wot-sdk/relay";

const transport = new SimplePool();
const urls = ["wss://relay.damus.io"];
const batcher = new QueryBatcher(transport, { debounceMs: 100 });
const events = await batcher.query(urls, { kinds: [0], authors: [pubkey] });
batcher.destroy();
transport.close(urls);
```

Use `queryImmediate` when a user action should not wait for debounce. `nostr-wot-sdk/data` also exposes its higher-level shared subscription coalescer for applications using the social-data fetchers.

## RelayStats

Track success counts, failures, average latency and backoff per relay. Persistence is optional and injected through `init(adapter)`; there is no default localStorage persistence.

```ts
import { RelayStats } from "nostr-wot-sdk/relay";

const stats = new RelayStats();
await stats.init();
stats.recordSuccess("wss://relay.damus.io", 142);
stats.recordFailure("wss://nos.lol");
const metrics = stats.getMetrics("wss://relay.damus.io");
const urls = stats.getPrioritizedUrls(["wss://relay.damus.io", "wss://nos.lol"]);
stats.destroy();
```

`getAllMetrics` reads all relay metrics, `isBackedOff` reports active backoff, and `persist` saves through the configured adapter. Destroy the tracker when its owner is disposed.

## RelayManager

`RelayManager` is an abstract feed-lifecycle base class that composes a pool, batcher and statistics. Subclass it and implement `getRelayUrls`, `persistRelayUrls`, `getTimeWindowSeconds` and `getLatestCachedTimestamp` to connect application settings and caches. For a general-purpose relay client, use `RelayPool` directly.

## React

```tsx
import { SimplePool } from "nostr-tools";
import { RelayProvider, useRelayStatuses } from "nostr-wot-sdk/relay/react";

<RelayProvider urls={["wss://relay.damus.io"]} createPool={() => new SimplePool()}>
  <StatusBadge />
</RelayProvider>;

function StatusBadge() {
  const { connectedCount, statuses } = useRelayStatuses();
  return <span>{connectedCount}/{statuses.size} relays</span>;
}
```

`useRelayPool` returns the `RelayPool` instance, `useQueryBatcher` returns its batcher, and `useRelayStats` returns a tracker or `null` when statistics are disabled. These hooks require `RelayProvider`. Install React separately when using this entry point.

## License

GNU General Public License version 3 only (`GPL-3.0-only`) — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Relay URL validation

`parseRelayUrl(value, { policy })` returns a parsed `URL` or `null`. The default `wss` policy accepts encrypted WebSocket URLs without credentials; `local-ws` additionally allows plaintext WebSockets on exactly `localhost`, `127.0.0.1`, or `[::1]`; `ws` allows both transports; `public-wss` requires encrypted transport and excludes local/private literal hosts. `isPublicWssUrl(value)` is the boolean public-policy convenience function.

Parsing does not infer a scheme, sort query parameters, remove fragments, or strip path slashes. Choose canonicalization separately: socket keys and application equality keys may have different contracts. Public-host filtering is lexical; server-side callers still need connection-layer DNS/redirect protection against SSRF.

## RelayHub

Import `createRelayHub`, `getRelayHub`, `currentRelayHub`, and the hub types from `nostr-wot-sdk/relay/hub`. The hub owns subscriptions, queries, publishing, authentication leases, bounded caches, and identity-scoped pooled connections. `createRelayHub(options)` creates an independent instance; `getRelayHub(options)` shares one module-level instance and honors options only on first creation. `currentRelayHub()` observes that singleton without creating it. Use one package installation/import mode for callers that must share it.

`FakeRelayFactory` supports deterministic transport tests without network sockets. `resetRelayHubForTests()` disposes and clears the shared instance between tests. The hub subpath is separate from the default relay utilities, so consumers needing URL validation do not load the connection manager.

### Subscription pressure

Hub one-shot queries and live subscriptions share the per-socket REQ budget (40 by default). Queries use separate subscription keys so a completed one-shot cannot close or attach to an already-EOSE live feed. They have active priority below voice; queued queries expire at their original deadline without briefly issuing an expired REQ.

A quota or rate-limit CLOSED, including one prefixed with `restricted:`, pauses new subscriptions on that socket for 60 seconds and lowers its budget. The cooldown is installed before caller callbacks run, so releasing a rejected subscription cannot immediately open another queued request. Existing accepted subscriptions remain open. Repeated callbacks and pending query cleanup cannot bypass the cooldown.
