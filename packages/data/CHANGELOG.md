# @nostr-wot/data

## 0.8.0

### Minor Changes

- Initial release of the monorepo split.

  - New `@nostr-wot/data` package: pure-function Nostr data layer (profiles, notes, threads, follows, engagement) with NIP-65 outbox baked into every fetcher. Optional SWR cache + React hooks at `/cache` and `/react` subpaths.
  - New `@nostr-wot/relay` package: standalone relay utilities (`RelayPool`, `QueryBatcher`, `RelayStats`).
  - New `@nostr-wot/wot` package: Web-of-Trust scoring + browser-extension bridge. Adds `<NostrSdkProvider>` — the recommended top-level React provider with WoT opt-in.
  - `nostr-wot-sdk` continues as a back-compat meta-package re-exporting all of the above. Existing imports keep working unchanged.
