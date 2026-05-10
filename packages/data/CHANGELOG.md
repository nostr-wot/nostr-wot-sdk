# @nostr-wot/data

## 0.5.0

### Minor Changes

- @nostr-wot/data: WebSocket-coercing pool helper, NIP-65 filtering, NIP-17 inbox parser, mention scanners, nsec helpers, and an ad-hoc query hook.

  - **`TextCoercingWebSocket`** (new export) — `WebSocket` subclass that coerces binary `EVENT` / `EOSE` / `NOTICE` frames to UTF-8 strings before nostr-tools parses them. Some relays (Cloudflare, compressing proxies, NIP-42 AUTH paths) push frames as binary; nostr-tools v2's pool then crashes inside `getSubscriptionId` and silently drops every event. Pass it via `new SimplePool({ websocketImplementation: TextCoercingWebSocket })`.
  - **`parseRelayList(event, filter?)`** — new optional `filter` parameter:
    - `'all'` (default) — current behaviour, keeps every URL.
    - `'public'` — drops loopback, RFC-1918, `.onion`, and non-`wss://` URLs.
    - `(url) => boolean` — custom predicate.
      Companion helper `isPublicWssUrl` exported alongside.
  - **`parseInboxRelayList(event, filter?)`** — new NIP-17 (kind 10050) DM inbox-relay parser with the same `filter` knob. Accepts both `relay` and `r` tag names.
  - **`useNostrQuery(filters, opts)`** (new from `@nostr-wot/data/react`) — one-shot ad-hoc filter query as a React hook, routed through `sharedCoalescer.querySync`. Re-fires when filters / relays change. For "fetch this once when X changes" patterns where the dedicated fetchers (`useProfile` / `useNote` / etc.) don't fit (e.g. NIP-50 search).
  - **NIP-19 nsec helpers** — `nsecToBytes(nsec)` returns the raw 32-byte secret; `nsecToHex(nsec)` returns hex. Pair with the existing `npubToHex` / `hexToNpub` so apps don't need to import `nostr-tools/nip19` directly.
  - **Mention scanners** — `extractMentionPubkeys(content)` returns the deduplicated set of pubkeys referenced inline (legacy hex form + bech32 `nostr:npub1…`); `findNpubMentions(content)` returns positional offsets for syntax highlighting / autocomplete.
  - **`shortNpub(hex)`** — abbreviated `npub1abcd…` label, drop-in for tiny avatars / chips.

### Patch Changes

- @nostr-wot/data: re-export `createKeyedObservable` and the `Slot` / `SlotStatus` / `KeyedObservable` / `KeyedObservableOptions` types from the package root (previously only available via `@nostr-wot/data/cache`). Lets consumers build their own per-key slot caches without reaching into the subpath import.

## 0.4.0

### Minor Changes

- New package `@nostr-wot/ui` — headless React UI for Nostr login.

  - `<NostrSessionProvider>`, `<LoginButton>`, `<LoginModal>`, `<LoginWidget>` — four login methods (NIP-07, NIP-46, generate, import) wired to a shared session context. Headless by default; ship `@nostr-wot/ui/styles.css` for a default look or skip and bring your own.
  - Themable via CSS variables on the provider's `data-nui-root` attribute (option A). Per-element class/style overrides via `classes={{...}}` / `styles={{...}}` slot props on every component.
  - Silent re-attach on mount: NIP-46 from saved bunker URI, remembered nsec when explicitly opted-in.

  `@nostr-wot/data/react` adds `<NostrSessionProvider>` + `useSession`, `useSigner`, `usePubkey`, `useLogin`, `useLogout`. This is the single mount point for the active signer; DM/blossom/wallet hooks read it from context. Lives in `data/react` (not `ui`) so non-UI packages can consume it without dragging in the React UI package.

  `@nostr-wot/dm/react`'s `useDMSession({ signer?, ... })` now treats `signer` as optional — when omitted, falls back to the session context. Existing call sites that pass a `signer` keep working.

  `<NostrSdkProvider>` from the meta package now mounts `<NostrSessionProvider>` by default. Pass `session={{ enabled: false }}` to opt out (e.g. when an outer session provider already wraps the tree).

## 0.3.1

### Patch Changes

- @nostr-wot/dm: lift reusable primitives out of obelisk so other clients don't reinvent them.

  New in `@nostr-wot/dm/cache`:

  - `publishInboxRelays(signer, publishRelays, inboxRelays)` — kind-10050 publish, companion to existing `fetchInboxRelays`
  - `backfillInbox(session, opts?)` — paginated kind-1059 + NIP-04 historical walker for first-login partner discovery
  - `setReadCursor` / `markRead` / `getReadCursor` / `getUnreadCount` / `getUnreadCounts` / `subscribeReadCursors` — device-local read-state tracking (never synced to relays)
  - `detectScheme(messages)` — NIP-04 vs NIP-17 prediction from recent message slice
  - `getOrCreateCacheKey(myPubkey, signer)` — XSS-safe per-account KEK (NIP-44-self-encrypted, imported as non-extractable AES-GCM key)
  - `encryptToCache(key, str)` / `decryptFromCache(key, blob)` — at-rest crypto primitives
  - `wrapStorageWithEncryption(storage, key)` — adapter that encrypts any `DMStorage` at rest
  - `KIND_NIP17_INBOX_RELAYS` constant (10050)

  New in `@nostr-wot/dm/react`:

  - `useUnreadCount(myPubkey, partner)` — re-renders on cursor or message changes
  - `useUnreadCounts(myPubkey)` — all unread counts at once
  - `useReadCursors(myPubkey)` — raw cursor map

  Documentation: every package now has a comprehensive README with full API surface, per-entrypoint examples, and TypeScript types. Published to npm.

## 0.3.0

### Minor Changes

- Subscription coalescer + four new capability packages.

  `@nostr-wot/data` adds `RequestCoalescer` + `sharedCoalescer` — debounces concurrent reads (50ms window) into a single REQ per relay-set, with subscription dedup via shared handles. Use it for live subscriptions (`enqueue`) or one-shot fetches (`querySync`).

  New packages:

  - `@nostr-wot/signers` — `NostrSigner` interface with four backends: `Nip07Signer` (extension), `Nip46Signer` (NIP-46 bunker), `Nip55Signer` (Android intent), `PrivateKeySigner` (in-memory). Each implements signEvent + optional NIP-04 / NIP-44 encrypt/decrypt.
  - `@nostr-wot/blossom` — `uploadToBlossom`, `mirrorBlob`, `deleteBlob`. Content-addressed file hosting per BUD-01 with kind-24242 signed auth, server failover.
  - `@nostr-wot/dm` — `encryptNip04` / `decryptNip04` for legacy DMs; `buildChatMessage` + `sealAndGiftWrap` + `unwrapGiftWrap` for NIP-17 sealed messages with ±2-day timestamp randomisation.
  - `@nostr-wot/wallet` — `NwcClient` for NIP-47 wallet connect (pay invoice, balance, info, custom methods); `requestZapInvoice` + `buildZapRequest` for NIP-57 zap flows including LNURL-pay resolution.

## 0.2.0

### Minor Changes

- `getAuthorNotes` and `loadMoreAuthorNotes` now stream entry updates as each note arrives (not only after EOSE-from-all). Components subscribed via `useAuthorNotes` see rows fill in incrementally — no more waiting for the slowest relay.

## 0.1.1

### Patch Changes

- Build fix: tsup now emits the automatic JSX transform (`import { jsx } from 'react/jsx-runtime'`) instead of `React.createElement`, so providers work in Next.js / RSC environments without needing a top-level `import React from 'react'`.

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
