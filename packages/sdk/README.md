# nostr-wot-sdk

Meta-package and unified React provider for the `@nostr-wot/*` family. Re-exports every scoped package, plus the recommended top-level `<NostrSdkProvider>` that wires up the data layer and (optionally) WoT context with one component.

## Install

```bash
npm i nostr-wot-sdk
```

This installs the meta and pulls in the scoped packages as transitive deps. New code can also depend on the scoped packages directly:

```bash
npm i @nostr-wot/data
npm i @nostr-wot/dm
npm i @nostr-wot/wot
npm i @nostr-wot/relay
npm i @nostr-wot/signers
npm i @nostr-wot/blossom
npm i @nostr-wot/wallet
```

## React provider (recommended top-level)

```tsx
import { NostrSdkProvider } from "nostr-wot-sdk/react";

<NostrSdkProvider
  relays={["wss://relay.damus.io", "wss://nos.lol"]}
  profileAggregators={["wss://purplepag.es"]}
  persistence={{ namespace: "myapp", ttlMs: 86400_000 }}
  wot={{ enabled: true, options: { maxHops: 2 } }}
>
  <App />
</NostrSdkProvider>;
```

`<NostrSdkProvider>` is the recommended root for any app using the SDK. It composes:

- `<NostrDataProvider>` from `@nostr-wot/data/react` — configures default relays, profile aggregators, and SWR cache persistence
- `<WoTProvider>` from `@nostr-wot/wot/react` (only when `wot.enabled: true`) — provides WoT scoring context

WoT hooks (`useWoT`, `useTrustScore`, `useIsInWoT`, `useBatchWoT`) require `wot.enabled: true`. Data hooks (`useProfile`, `useNote`, `useThread`, …) work either way.

## Re-export map

| Import from `nostr-wot-sdk` | Equivalent scoped package |
|---|---|
| `nostr-wot-sdk` | `@nostr-wot/wot` |
| `nostr-wot-sdk/react` | `@nostr-wot/wot/react` + `@nostr-wot/data/react` + `<NostrSdkProvider>` |
| `nostr-wot-sdk/solid` | `@nostr-wot/wot/solid` |
| `nostr-wot-sdk/relay` | `@nostr-wot/relay` |
| `nostr-wot-sdk/relay/react` | `@nostr-wot/relay/react` |
| `nostr-wot-sdk/data` | `@nostr-wot/data` |
| `nostr-wot-sdk/data/cache` | `@nostr-wot/data/cache` |

For DM, signers, blossom, and wallet, use the scoped packages directly — they're not re-exported from this meta:

```ts
import { Nip07Signer } from "@nostr-wot/signers";
import { sealAndGiftWrap } from "@nostr-wot/dm";
import { useDMSession } from "@nostr-wot/dm/react";
import { uploadToBlossom } from "@nostr-wot/blossom";
import { NwcClient, requestZapInvoice } from "@nostr-wot/wallet";
```

## Architecture

```
                 ┌────────────────────┐
                 │   Your app         │
                 └─────────┬──────────┘
                           │
                 ┌─────────▼──────────┐
                 │ <NostrSdkProvider> │  ← unified config
                 └─────────┬──────────┘
            ┌──────────────┼─────────────┐
            ▼              ▼             ▼
      data fetchers   WoT scoring    DM cache
            │              │             │
            └──────────────┼─────────────┘
                           ▼
                ┌──────────────────┐
                │ shared SimplePool│  ← one set of WebSocket
                └──────────────────┘     connections
```

Every `@nostr-wot/*` package shares the same connection pool via `getPool()` / `setPool()` from `@nostr-wot/data`. Subscribe-once-fan-out-everywhere is enforced by `sharedCoalescer`, so DM inbox, profile reads, follower lists, and engagement queries are all coalesced on the wire.

## Per-package docs

- [@nostr-wot/data](https://www.npmjs.com/package/@nostr-wot/data) — fetchers, cache, hooks
- [@nostr-wot/relay](https://www.npmjs.com/package/@nostr-wot/relay) — pool, batcher, stats
- [@nostr-wot/signers](https://www.npmjs.com/package/@nostr-wot/signers) — NIP-07/46/55 + private key
- [@nostr-wot/dm](https://www.npmjs.com/package/@nostr-wot/dm) — NIP-04, NIP-17, cache, hooks
- [@nostr-wot/blossom](https://www.npmjs.com/package/@nostr-wot/blossom) — uploads
- [@nostr-wot/wallet](https://www.npmjs.com/package/@nostr-wot/wallet) — NWC + zaps
- [@nostr-wot/wot](https://www.npmjs.com/package/@nostr-wot/wot) — Web-of-Trust scoring

## License

MIT
