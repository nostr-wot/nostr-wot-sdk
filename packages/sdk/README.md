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

WoT hooks (`useWoT`, `useIsInWoT`, `useBatchWoT`) require `wot.enabled: true`. Data hooks (`useProfile`, `useNote`, `useThread`, …) work either way.

## Re-export map

| Import from `nostr-wot-sdk` | Equivalent scoped package |
|---|---|
| `nostr-wot-sdk` | `@nostr-wot/wot` |
| `nostr-wot-sdk/react` | `@nostr-wot/wot/react` + `@nostr-wot/data/react` + `<NostrSdkProvider>` |
| `nostr-wot-sdk/relay` | `@nostr-wot/relay` |
| `nostr-wot-sdk/relay/react` | `@nostr-wot/relay/react` |
| `nostr-wot-sdk/data` | `@nostr-wot/data` |
| `nostr-wot-sdk/data/cache` | `@nostr-wot/data/cache` |
| `nostr-wot-sdk/signers` | `@nostr-wot/signers` |
| `nostr-wot-sdk/ui` | `@nostr-wot/ui` |
| `nostr-wot-sdk/dm` | `@nostr-wot/dm` |
| `nostr-wot-sdk/dm/react` | `@nostr-wot/dm/react` |
| `nostr-wot-sdk/wallet` | `@nostr-wot/wallet` |
| `nostr-wot-sdk/wallet/react` | `@nostr-wot/wallet/react` |
| `nostr-wot-sdk/auth` | `@nostr-wot/auth` |
| `nostr-wot-sdk/blossom` | `@nostr-wot/blossom` |

The whole family is surfaced through this meta, so you can either import via a
subpath or depend on the scoped package directly:

```ts
import { Nip07Signer } from "nostr-wot-sdk/signers";
import { sealAndGiftWrap } from "nostr-wot-sdk/dm";
import { useDMSession } from "nostr-wot-sdk/dm/react";
import { uploadToBlossom } from "nostr-wot-sdk/blossom";
import { NwcClient, requestZapInvoice } from "nostr-wot-sdk/wallet";
```

> Note: `@nostr-wot/ui`'s stylesheet is not re-exported — import it from the
> scoped package directly: `import "@nostr-wot/ui/styles.css"`. The
> framework-specific `@nostr-wot/auth/next` and `@nostr-wot/auth/client`
> entries are likewise only available on the scoped package.

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
- [@nostr-wot/signers](https://www.npmjs.com/package/@nostr-wot/signers) — NIP-07/46 + private key
- [@nostr-wot/dm](https://www.npmjs.com/package/@nostr-wot/dm) — NIP-04, NIP-17, cache, hooks
- [@nostr-wot/blossom](https://www.npmjs.com/package/@nostr-wot/blossom) — uploads
- [@nostr-wot/wallet](https://www.npmjs.com/package/@nostr-wot/wallet) — NWC + zaps
- [@nostr-wot/wot](https://www.npmjs.com/package/@nostr-wot/wot) — Web-of-Trust scoring

## License

MIT
