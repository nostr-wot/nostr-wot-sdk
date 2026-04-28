# @nostr-wot/relay

## 0.1.0

### Minor Changes

- Restart of the scoped packages at proper semver baselines.

  - `@nostr-wot/data`, `@nostr-wot/relay`, `@nostr-wot/wot` reset to **0.1.0** (initial public release).
  - `nostr-wot-sdk` (back-compat meta-package) bumps to **0.8.1**, declares the new scoped versions.
  - `<NostrSdkProvider>` moved out of `@nostr-wot/wot/react` into `nostr-wot-sdk` so apps that only need data don't have to install the WoT package. Two new providers:
    - `<NostrDataProvider>` in `@nostr-wot/data/react` — configures relays, profile aggregators, and cache.
    - `<NostrSdkProvider>` in `nostr-wot-sdk` — composes `<NostrDataProvider>` plus optional `<WoTProvider>` (opt-in via `wot.enabled`).
  - Keywords added to all four `package.json`s for npm search discoverability.

## 0.8.0

### Minor Changes

- Initial release of the monorepo split.

  - New `@nostr-wot/data` package: pure-function Nostr data layer (profiles, notes, threads, follows, engagement) with NIP-65 outbox baked into every fetcher. Optional SWR cache + React hooks at `/cache` and `/react` subpaths.
  - New `@nostr-wot/relay` package: standalone relay utilities (`RelayPool`, `QueryBatcher`, `RelayStats`).
  - New `@nostr-wot/wot` package: Web-of-Trust scoring + browser-extension bridge. Adds `<NostrSdkProvider>` — the recommended top-level React provider with WoT opt-in.
  - `nostr-wot-sdk` continues as a back-compat meta-package re-exporting all of the above. Existing imports keep working unchanged.
