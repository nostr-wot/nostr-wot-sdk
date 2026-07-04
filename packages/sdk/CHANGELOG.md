# nostr-wot-sdk

## 0.9.1

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/data@0.5.0
  - @nostr-wot/wot@0.1.6

## 0.9.0

### Minor Changes

- New package `@nostr-wot/ui` — headless React UI for Nostr login.

  - `<NostrSessionProvider>`, `<LoginButton>`, `<LoginModal>`, `<LoginWidget>` — four login methods (NIP-07, NIP-46, generate, import) wired to a shared session context. Headless by default; ship `@nostr-wot/ui/styles.css` for a default look or skip and bring your own.
  - Themable via CSS variables on the provider's `data-nui-root` attribute (option A). Per-element class/style overrides via `classes={{...}}` / `styles={{...}}` slot props on every component.
  - Silent re-attach on mount: NIP-46 from saved bunker URI, remembered nsec when explicitly opted-in.

  `@nostr-wot/data/react` adds `<NostrSessionProvider>` + `useSession`, `useSigner`, `usePubkey`, `useLogin`, `useLogout`. This is the single mount point for the active signer; DM/blossom/wallet hooks read it from context. Lives in `data/react` (not `ui`) so non-UI packages can consume it without dragging in the React UI package.

  `@nostr-wot/dm/react`'s `useDMSession({ signer?, ... })` now treats `signer` as optional — when omitted, falls back to the session context. Existing call sites that pass a `signer` keep working.

  `<NostrSdkProvider>` from the meta package now mounts `<NostrSessionProvider>` by default. Pass `session={{ enabled: false }}` to opt out (e.g. when an outer session provider already wraps the tree).

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/data@0.4.0
  - @nostr-wot/wot@0.1.5

## 0.8.7

### Patch Changes

- @nostr-wot/dm: follow-aware eviction, auto-persist, and lifecycle helpers.

  - `setFollowSet(myPubkey, set | null)` / `getFollowSet` / `subscribeFollowSet` — register the user's follow list so eviction can protect active partners. Cold-start contract: never calling this leaves all partners protected.
  - `evictIfNeeded(myPubkey, cap?)` — drop oldest non-followed messages once the cap is exceeded. Followed partners are always preserved.
  - `initDMSession({ ..., autoPersist?, autoPersistDebounceMs?, evictionCap? })` — debounced auto-save and per-mutation eviction. `autoPersist` defaults to `true` when a `storage` is provided.
  - `closeDMSession(session)` — stop auto-persist + eviction subscriptions.
  - `clearDMSession(myPubkey, { storage?, clearStorage? })` — wipe per-account state on logout / account-switch.

  @nostr-wot/signers: NDK adapter.

  - `ndkSignerAsNostrSigner({ ndk, NDKEvent })` — wraps any `NDKSigner` to satisfy the `NostrSigner` interface. NDK is not a dependency; the caller supplies the `NDKEvent` constructor at call time. Lets NDK-using apps adopt `@nostr-wot/*` without rewriting their auth layer.

## 0.8.6

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

- Updated dependencies []:
  - @nostr-wot/data@0.3.1
  - @nostr-wot/relay@0.1.1
  - @nostr-wot/wot@0.1.4

## 0.8.5

### Patch Changes

- Add `@nostr-wot/dm/cache` and `@nostr-wot/dm/react` subpaths.

  `/cache` provides a per-session DM cache: `initDMSession`, `subscribeInbox` (auto-decrypts NIP-04 + NIP-17 gift wraps), `sendDM` (NIP-17 default with NIP-04 fallback), `fetchInboxRelays` (kind 10050), `relaysForPartner` (NIP-65 outbox), and pluggable `DMStorage` with built-in `localStorageDMStorage`.

  `/react` ships `useDMSession`, `useThread`, and `useConversations` hooks built on `useSyncExternalStore` for SWR-style updates.

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
