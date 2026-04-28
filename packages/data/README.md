# @nostr-wot/data

Pure-function Nostr data layer. Profiles, notes, threads, follows, follower lists, engagement (reactions / reposts / zaps), NIP-65 outbox-model relay discovery, and a streaming subscription coalescer. Optional SWR cache + React hooks ship as separate entrypoints.

## Three entrypoints

| Import path | What's in it | Depends on |
|---|---|---|
| `@nostr-wot/data` | Pure fetchers, parsers, outbox helper, `getPool()`, `sharedCoalescer` | `nostr-tools` (peer) |
| `@nostr-wot/data/cache` | SWR cache wrapping the fetchers; observable primitive; `localStorage` persistence | + the above |
| `@nostr-wot/data/react` | `useProfile`, `useNote`, `useThread`, `<NostrDataProvider>`, … | + `react` (peer) |

Use only what you need.

## Install

```bash
npm i @nostr-wot/data nostr-tools
```

---

## Vanilla fetchers (no cache, no React)

```ts
import {
  fetchProfile,
  fetchNote,
  fetchNotesByAuthor,
  fetchThread,
  fetchFollows,
  fetchEngagement,
  fetchRelayList,
  relaysForAuthor,
  setDefaultRelays,
  setProfileAggregators,
} from "@nostr-wot/data";

setDefaultRelays(["wss://relay.damus.io", "wss://nos.lol"]);
setProfileAggregators(["wss://purplepag.es"]);

const profile = await fetchProfile("hex-pubkey");
// → { displayName, name, picture, banner, about, nip05, lud16, fetchedAt }

const note = await fetchNote("hex-event-id");
const notes = await fetchNotesByAuthor("hex-pubkey", { limit: 50 });
const replies = await fetchThread("hex-event-id");

const follows = await fetchFollows("hex-pubkey");
// → { event, pubkeys, fetchedAt }

const engagement = await fetchEngagement(["id1", "id2"]);
// → Map<id, { reactionCount, repostCount, zapTotalSats }>

// Outbox: union of defaults + the author's NIP-65 write relays
const relays = await relaysForAuthor("hex-pubkey");
const relayList = await fetchRelayList("hex-pubkey");
// → { read: string[], write: string[], event } | null
```

### Streaming variants

`streamProfile` yields entry updates as relay events arrive (instead of resolving on EOSE).

```ts
import { streamProfile } from "@nostr-wot/data";

for await (const entry of streamProfile("hex-pubkey")) {
  // each yield is an updated ProfileEntry — useful for showing partial results
}
```

### Subscription coalescer

`sharedCoalescer` merges concurrent reads from across your app — DM cache, profile cache, follower lists, etc. — into a single REQ per relay-set within a 50ms window. When the last consumer unsubscribes, the underlying subscription tears down.

```ts
import { sharedCoalescer } from "@nostr-wot/data";

// Live subscription
const stop = sharedCoalescer.enqueue({
  filters: [{ kinds: [1], authors: ["hex"], limit: 50 }],
  relays: ["wss://relay.damus.io"],
  onEvent: (e) => { /* ... */ },
  onEose: (relay) => { /* ... */ },
});

// One-shot
const events = await sharedCoalescer.querySync(
  [{ kinds: [10002], authors: ["hex"], limit: 1 }],
  { relays, timeoutMs: 5000 },
);
```

---

## SWR cache layer

```ts
import {
  getProfile,
  getNote,
  getThread,
  getFollows,
  getRelayList,
  fetchEngagementBatch,
  configurePersistence,
  createKeyedObservable,
} from "@nostr-wot/data/cache";

configurePersistence({ namespace: "myapp", ttlMs: 24 * 3600_000 });

const profile = await getProfile("hex-pubkey");
// Cold-loads from localStorage if cached, refreshes in the background
// from relays as newer kind-0 events arrive.
```

The cache exposes its own primitive — `createKeyedObservable<K, V>()` — used internally by every cached fetcher and by `@nostr-wot/dm/cache`. Useful if you're building your own SWR-style stream:

```ts
const obs = createKeyedObservable<string, MyValue>();
obs.set("key", { ... });
obs.subscribe("key", (v) => { /* re-render */ });
const slot = obs.get("key");
```

---

## React hooks

```tsx
import {
  NostrDataProvider,
  useProfile,
  useNote,
  useThread,
  useEngagement,
  useFollows,
  useRelayList,
} from "@nostr-wot/data/react";

<NostrDataProvider
  relays={["wss://relay.damus.io", "wss://nos.lol"]}
  profileAggregators={["wss://purplepag.es"]}
  persistence={{ namespace: "myapp", ttlMs: 86400_000 }}
>
  <App />
</NostrDataProvider>;

function ProfileCard({ pubkey }: { pubkey: string }) {
  const profile = useProfile(pubkey); // SWR
  if (!profile) return <Skeleton />;
  return <h1>{profile.displayName ?? profile.name}</h1>;
}
```

`<NostrDataProvider>` configures defaults (relays, aggregators, persistence) on mount. If you're using `@nostr-wot/wot` or `nostr-wot-sdk`, prefer `<NostrSdkProvider>` instead — it wraps `<NostrDataProvider>` and adds opt-in WoT context.

---

## Outbox model (NIP-65)

Every fetcher routes through the outbox helper by default. When you ask for an author's content, the SDK resolves their kind-10002 (NIP-65) relay list and queries the union of their declared write relays + your defaults. This is the only reliable way to find content that isn't pinned to popular aggregators.

Override globally:

```ts
setDefaultRelays(["wss://relay.damus.io", "wss://nos.lol"]);
setProfileAggregators(["wss://purplepag.es"]);
```

Or per-call (most fetchers accept an optional `relays` override):

```ts
await fetchProfile(pubkey, ["wss://my-private-relay"]);
```

---

## Pool sharing

`@nostr-wot/data` owns a single `SimplePool` instance, accessible via `getPool()`. If you have your own pool (e.g. for binary-frame coercion or NDK interop), wire it once at startup:

```ts
import { setPool } from "@nostr-wot/data";

const pool = new SimplePool({ websocketImplementation: MyWebSocket });
setPool(pool);
```

Other `@nostr-wot/*` packages reuse this same pool — DM subscriptions, blossom uploads, WoT lookups, all share connections.

---

## License

MIT
