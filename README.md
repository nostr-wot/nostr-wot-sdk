# nostr-wot-sdk monorepo

Three focused packages plus a back-compat meta:

| Package | Scope | Depends on |
|---|---|---|
| **[`@nostr-wot/data`](./packages/data)** | Profiles, notes, threads, follows, engagement (reactions/reposts/zaps) + NIP-65 outbox. Optional SWR cache + React hooks at `/cache` and `/react` subpaths. | `nostr-tools` (peer) |
| **[`@nostr-wot/relay`](./packages/relay)** | Standalone relay utilities — pool, query batcher, stats. Lower-level than `@nostr-wot/data`. | `nostr-tools` (peer) |
| **[`@nostr-wot/wot`](./packages/wot)** | Web-of-Trust scoring + browser-extension bridge. Includes `<NostrSdkProvider>` (the recommended top-level React provider) and React/Solid hooks. | `@nostr-wot/data` |
| **[`nostr-wot-sdk`](./packages/sdk)** | Back-compat meta-package re-exporting all of the above. Existing imports keep working. | the three scoped packages |

## Install

Pick what you need:

```bash
npm i @nostr-wot/data           # data fetching + cache + hooks
npm i @nostr-wot/wot            # WoT scoring + extension bridge
npm i @nostr-wot/relay          # low-level relay utilities
npm i nostr-wot-sdk             # all of the above (back-compat)
```

## Architecture

```
                ┌──────────────────────────────┐
                │ Your Nostr-aware React app   │
                └──────────────┬───────────────┘
                               │
                ┌──────────────▼───────────────┐
                │  <NostrSdkProvider>          │  @nostr-wot/wot/react
                │  (configures + opt-in WoT)   │
                └──────────────┬───────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
  @nostr-wot/wot         @nostr-wot/data        @nostr-wot/relay
  (WoT scoring,          (fetchers, parsers,    (low-level pool,
   extension bridge)      outbox, cache,         batcher, stats)
                          React hooks)
                               │
                               ▼
                         nostr-tools (peer)
```

`@nostr-wot/data` is the portable artifact — SWR observable + per-kind caches + NIP-65 outbox in ~1000 LOC. Runtime-agnostic, no NDK dependency, peer-deps only on `nostr-tools` (and `react` for the `/react` entry).

## Development

npm-workspaces monorepo.

```bash
git clone git@github.com:nostr-wot/nostr-wot-sdk.git
cd nostr-wot-sdk
npm install
npm run build       # builds all packages in dependency order
npm test
```

Per-package work:
```bash
npm run build -w @nostr-wot/data
npm run dev -w @nostr-wot/wot
```

## Publishing

Each scoped package versions and publishes independently. The meta-package bumps in lock-step with the highest scoped version so installs stay coherent.

```bash
cd packages/data  && npm publish --access public
cd packages/relay && npm publish --access public
cd packages/wot   && npm publish --access public
cd packages/sdk   && npm publish --access public
```

## License

MIT — see [LICENSE](LICENSE).
