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
