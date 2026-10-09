# @nostr-wot/relay

Low-level Nostr relay utilities. A pool that manages WebSocket connections, a query batcher that merges concurrent filters, and a stats tracker that records per-relay latency / success rates. Extracted from the WoT SDK so any Nostr project can use these primitives without pulling in WoT scoring code.

> Most apps want **`@nostr-wot/data`** instead — it builds on top of these primitives and exposes higher-level fetchers (profiles, notes, threads, follows). Reach for `@nostr-wot/relay` only when you need to roll your own data layer or instrument relay performance.

## Install

```bash
npm i @nostr-wot/relay nostr-tools
```

## Two entrypoints

| Import path | What's in it |
|---|---|
| `@nostr-wot/relay` | `RelayPool`, `RelayManager`, `QueryBatcher`, `RelayStats` |
| `@nostr-wot/relay/react` | React provider + hooks for the above |

## What's in the box

### `RelayPool`

A drop-in replacement for `nostr-tools`' `SimplePool` with reconnect handling and pluggable WebSocket implementations (e.g. for binary-frame coercion behind compressing proxies).

```ts
import { RelayPool } from "@nostr-wot/relay";

const pool = new RelayPool({
  relays: ["wss://relay.damus.io", "wss://nos.lol"],
  websocketImplementation: MyWebSocket,
});

const sub = pool.subscribeMany(
  pool.relays(),
  [{ kinds: [1], limit: 50 }],
  {
    onevent: (e) => { /* ... */ },
    oneose: () => { /* ... */ },
  },
);

await pool.publish(pool.relays(), signedEvent);
sub.close();
```

### `RelayManager`

Higher-level orchestrator: tracks which relays are connected, applies a per-relay reconnect policy, surfaces a status observable for UIs.

```ts
import { RelayManager } from "@nostr-wot/relay";

const manager = new RelayManager({
  relays: ["wss://relay.damus.io"],
  reconnectBackoffMs: [1000, 5000, 15000],
});

manager.onStatusChange((url, status) => {
  // status: "connecting" | "connected" | "closed" | "error"
});

await manager.connect();
```

### `QueryBatcher`

Merges concurrent reads with the same relay-set into a single REQ within a debounce window. Useful when many components ask for different events at once and you want to coalesce them on the wire.

```ts
import { QueryBatcher } from "@nostr-wot/relay";

const batcher = new QueryBatcher(pool, {
  debounceMs: 50,
  subscriptionTimeoutMs: 8000,
});

const events = await batcher.querySync(
  [{ kinds: [0], authors: [pubkey] }],
  { relays: ["wss://relay.damus.io"], timeoutMs: 5000 },
);
```

If you're using `@nostr-wot/data`, the `sharedCoalescer` exported from there is a singleton `QueryBatcher`-equivalent that the entire SDK shares.

### `RelayStats`

Per-relay metrics: latency, EOSE timings, success/error counts. Persists optionally via a pluggable `RelayStatsPersistence` (defaults to `localStorage`).

```ts
import { RelayStats } from "@nostr-wot/relay";

const stats = new RelayStats({
  persistence: { kind: "localStorage", namespace: "myapp" },
});

stats.recordLatency("wss://relay.damus.io", 142);
const metrics = stats.snapshot("wss://relay.damus.io");
// → { medianLatencyMs, successCount, errorCount, ... }
```

## React (`/react`)

```tsx
import { RelayPoolProvider, useRelayPool, useRelayStats } from "@nostr-wot/relay/react";

<RelayPoolProvider relays={["wss://relay.damus.io"]}>
  <App />
</RelayPoolProvider>;

function StatusBadge() {
  const { connectedCount, totalCount } = useRelayPool();
  return <span>{connectedCount}/{totalCount} relays</span>;
}
```

## Types

```ts
interface RelayPoolOptions { relays: string[]; websocketImplementation?: typeof WebSocket; }
type RelayStatus = "connecting" | "connected" | "closed" | "error";
interface RelayMetrics { medianLatencyMs: number; successCount: number; errorCount: number; }
```

See `src/types.ts` for the full surface.

## License

MIT

## Relay URL validation

`parseRelayUrl(value, { policy })` returns a parsed `URL` or `null`. The default `wss` policy accepts encrypted WebSocket URLs without credentials; `local-ws` additionally allows plaintext WebSockets on exactly `localhost`, `127.0.0.1`, or `[::1]`; `ws` allows both transports; `public-wss` requires encrypted transport and excludes local/private literal hosts. `isPublicWssUrl(value)` is the boolean public-policy convenience function.

Parsing does not infer a scheme, sort query parameters, remove fragments, or strip path slashes. Choose canonicalization separately: socket keys and application equality keys may have different contracts. Public-host filtering is lexical; server-side callers still need connection-layer DNS/redirect protection against SSRF.

## RelayHub

Import `createRelayHub`, `getRelayHub`, `currentRelayHub`, and the hub types from `@nostr-wot/relay/hub`. The hub owns subscriptions, queries, publishing, authentication leases, bounded caches, and identity-scoped pooled connections. `createRelayHub(options)` creates an independent instance; `getRelayHub(options)` shares one module-level instance and honors options only on first creation. `currentRelayHub()` observes that singleton without creating it. Use one package installation/import mode for callers that must share it.

`FakeRelayFactory` supports deterministic transport tests without network sockets. `resetRelayHubForTests()` disposes and clears the shared instance between tests. The hub subpath is separate from the default relay utilities, so consumers needing URL validation do not load the connection manager.

### Subscription pressure

Hub one-shot queries and live subscriptions share the per-socket REQ budget (40 by default). Queries use separate subscription keys so a completed one-shot cannot close or attach to an already-EOSE live feed. They have active priority below voice; queued queries expire at their original deadline without briefly issuing an expired REQ.

A quota or rate-limit CLOSED, including one prefixed with `restricted:`, pauses new subscriptions on that socket for 60 seconds and lowers its budget. The cooldown is installed before caller callbacks run, so releasing a rejected subscription cannot immediately open another queued request. Existing accepted subscriptions remain open. Repeated callbacks and pending query cleanup cannot bypass the cooldown.
