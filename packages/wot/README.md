# @nostr-wot/wot

Web-of-Trust scoring + browser-extension bridge for Nostr. Computes hop distance between npubs, derives trust scores from kind-3 follow graphs, and integrates with the [Nostr WoT browser extension](https://nostr-wot.com/) for client-side WoT queries that piggyback on the user's locally-cached follow data.

## Install

```bash
npm i @nostr-wot/wot
```

## Three entrypoints

| Import path | What's in it | Depends on |
|---|---|---|
| `@nostr-wot/wot` | `WoT` class — vanilla JS API | none beyond peers |
| `@nostr-wot/wot/react` | `<WoTProvider>`, `useWoT`, `useTrustScore`, `useIsInWoT`, `useBatchWoT` | + `react` (peer) |
| `@nostr-wot/wot/solid` | Solid equivalents | + `solid-js` (peer) |

## Quick start

```ts
import { WoT } from "@nostr-wot/wot";

const wot = new WoT({
  rootPubkey: "hex-pubkey-of-the-user",
  maxHops: 2,
});

const result = await wot.getDistance("hex-target-pubkey");
// → { hops: 1, paths: [...], score: 0.87 } | null
```

## React (recommended)

For React apps using any `@nostr-wot/*` package, prefer the unified provider from the meta SDK:

```tsx
import { NostrSdkProvider, useTrustScore, useIsInWoT } from "nostr-wot-sdk/react";

<NostrSdkProvider
  relays={["wss://relay.damus.io", "wss://nos.lol"]}
  wot={{
    enabled: true,
    options: { rootPubkey, maxHops: 2 },
  }}
>
  <App />
</NostrSdkProvider>;

function FollowBadge({ pubkey }: { pubkey: string }) {
  const score = useTrustScore(pubkey);   // 0..1 or null
  const isInWoT = useIsInWoT(pubkey);
  return isInWoT ? <Badge score={score} /> : null;
}
```

Or use the WoT provider directly if you don't want the data layer:

```tsx
import { WoTProvider, useWoT } from "@nostr-wot/wot/react";

<WoTProvider options={{ rootPubkey, maxHops: 2 }}>
  <App />
</WoTProvider>;
```

`<NostrSdkProvider>` configures `@nostr-wot/data` (relays, profile aggregators, persistence) and optionally enables WoT context. WoT hooks (`useWoT`, `useTrustScore`, `useIsInWoT`, `useBatchWoT`) require either `wot.enabled: true` on `<NostrSdkProvider>` or a separate `<WoTProvider>`.

### Batch lookups

```tsx
import { useBatchWoT } from "@nostr-wot/wot/react";

function Feed({ noteAuthors }: { noteAuthors: string[] }) {
  const wotMap = useBatchWoT(noteAuthors);
  // wotMap: Map<pubkey, { hops, score } | null>
  return noteAuthors.map((pk) =>
    wotMap.get(pk) ? <Note pubkey={pk} /> : null,
  );
}
```

## Browser-extension bridge

If the [Nostr WoT extension](https://nostr-wot.com/) is installed, the SDK delegates queries to it — the extension already has the user's full follow graph cached locally and can answer hop queries instantly without re-fetching kind-3 events.

```ts
import { WoT } from "@nostr-wot/wot";

const wot = new WoT({ extensionPreferred: true });

if (await wot.hasExtension()) {
  // queries go through window.nostrwot
}
```

When the extension isn't available, the SDK falls back to relay-fetched kind-3 events via `@nostr-wot/data`'s `fetchFollows`.

## API surface

```ts
class WoT {
  constructor(opts: { rootPubkey?: string; maxHops?: number; extensionPreferred?: boolean });
  getDistance(target: string): Promise<{ hops: number; paths: string[][]; score: number } | null>;
  isInWoT(target: string): Promise<boolean>;
  getTrustScore(target: string): Promise<number | null>;
  getBatch(targets: string[]): Promise<Map<string, { hops: number; score: number } | null>>;
  hasExtension(): Promise<boolean>;
}
```

## License

MIT
