# nostr-wot-sdk

## 0.8.4

### Patch Changes

- Subscription coalescer + four new capability packages.

  `@nostr-wot/data` adds `RequestCoalescer` + `sharedCoalescer` — debounces concurrent reads (50ms window) into a single REQ per relay-set, with subscription dedup via shared handles. Use it for live subscriptions (`enqueue`) or one-shot fetches (`querySync`).

  New packages:

  - `@nostr-wot/signers` — `NostrSigner` interface with four backends: `Nip07Signer` (extension), `Nip46Signer` (NIP-46 bunker), `Nip55Signer` (Android intent), `PrivateKeySigner` (in-memory). Each implements signEvent + optional NIP-04 / NIP-44 encrypt/decrypt.
  - `@nostr-wot/blossom` — `uploadToBlossom`, `mirrorBlob`, `deleteBlob`. Content-addressed file hosting per BUD-01 with kind-24242 signed auth, server failover.
  - `@nostr-wot/dm` — `encryptNip04` / `decryptNip04` for legacy DMs; `buildChatMessage` + `sealAndGiftWrap` + `unwrapGiftWrap` for NIP-17 sealed messages with ±2-day timestamp randomisation.
  - `@nostr-wot/wallet` — `NwcClient` for NIP-47 wallet connect (pay invoice, balance, info, custom methods); `requestZapInvoice` + `buildZapRequest` for NIP-57 zap flows including LNURL-pay resolution.

- Updated dependencies []:
  - @nostr-wot/data@0.3.0
  - @nostr-wot/wot@0.1.3

## 0.8.3

### Patch Changes

- `getAuthorNotes` and `loadMoreAuthorNotes` now stream entry updates as each note arrives (not only after EOSE-from-all). Components subscribed via `useAuthorNotes` see rows fill in incrementally — no more waiting for the slowest relay.

- Updated dependencies []:
  - @nostr-wot/data@0.2.0
  - @nostr-wot/wot@0.1.2

## 0.8.2

### Patch Changes

- Build fix: tsup now emits the automatic JSX transform (`import { jsx } from 'react/jsx-runtime'`) instead of `React.createElement`, so providers work in Next.js / RSC environments without needing a top-level `import React from 'react'`.

- Updated dependencies []:
  - @nostr-wot/data@0.1.1
  - @nostr-wot/wot@0.1.1

## 0.8.1

### Patch Changes

- Restart of the scoped packages at proper semver baselines.

  - `@nostr-wot/data`, `@nostr-wot/relay`, `@nostr-wot/wot` reset to **0.1.0** (initial public release).
  - `nostr-wot-sdk` (back-compat meta-package) bumps to **0.8.1**, declares the new scoped versions.
  - `<NostrSdkProvider>` moved out of `@nostr-wot/wot/react` into `nostr-wot-sdk` so apps that only need data don't have to install the WoT package. Two new providers:
    - `<NostrDataProvider>` in `@nostr-wot/data/react` — configures relays, profile aggregators, and cache.
    - `<NostrSdkProvider>` in `nostr-wot-sdk` — composes `<NostrDataProvider>` plus optional `<WoTProvider>` (opt-in via `wot.enabled`).
  - Keywords added to all four `package.json`s for npm search discoverability.

- Updated dependencies []:
  - @nostr-wot/data@0.1.0
  - @nostr-wot/relay@0.1.0
  - @nostr-wot/wot@0.1.0

## 0.8.0

### Minor Changes

- Initial release of the monorepo split.

  - New `@nostr-wot/data` package: pure-function Nostr data layer (profiles, notes, threads, follows, engagement) with NIP-65 outbox baked into every fetcher. Optional SWR cache + React hooks at `/cache` and `/react` subpaths.
  - New `@nostr-wot/relay` package: standalone relay utilities (`RelayPool`, `QueryBatcher`, `RelayStats`).
  - New `@nostr-wot/wot` package: Web-of-Trust scoring + browser-extension bridge. Adds `<NostrSdkProvider>` — the recommended top-level React provider with WoT opt-in.
  - `nostr-wot-sdk` continues as a back-compat meta-package re-exporting all of the above. Existing imports keep working unchanged.

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/data@0.8.0
  - @nostr-wot/relay@0.8.0
  - @nostr-wot/wot@0.8.0
