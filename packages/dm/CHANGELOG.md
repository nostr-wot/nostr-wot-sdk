# @nostr-wot/dm

## 0.4.0

### Minor Changes

- @nostr-wot/dm: follow-aware eviction, auto-persist, and lifecycle helpers.

  - `setFollowSet(myPubkey, set | null)` / `getFollowSet` / `subscribeFollowSet` — register the user's follow list so eviction can protect active partners. Cold-start contract: never calling this leaves all partners protected.
  - `evictIfNeeded(myPubkey, cap?)` — drop oldest non-followed messages once the cap is exceeded. Followed partners are always preserved.
  - `initDMSession({ ..., autoPersist?, autoPersistDebounceMs?, evictionCap? })` — debounced auto-save and per-mutation eviction. `autoPersist` defaults to `true` when a `storage` is provided.
  - `closeDMSession(session)` — stop auto-persist + eviction subscriptions.
  - `clearDMSession(myPubkey, { storage?, clearStorage? })` — wipe per-account state on logout / account-switch.

  @nostr-wot/signers: NDK adapter.

  - `ndkSignerAsNostrSigner({ ndk, NDKEvent })` — wraps any `NDKSigner` to satisfy the `NostrSigner` interface. NDK is not a dependency; the caller supplies the `NDKEvent` constructor at call time. Lets NDK-using apps adopt `@nostr-wot/*` without rewriting their auth layer.

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/signers@0.2.0

## 0.3.0

### Minor Changes

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

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/data@0.3.1
  - @nostr-wot/signers@0.1.1

## 0.2.0

### Minor Changes

- Add `@nostr-wot/dm/cache` and `@nostr-wot/dm/react` subpaths.

  `/cache` provides a per-session DM cache: `initDMSession`, `subscribeInbox` (auto-decrypts NIP-04 + NIP-17 gift wraps), `sendDM` (NIP-17 default with NIP-04 fallback), `fetchInboxRelays` (kind 10050), `relaysForPartner` (NIP-65 outbox), and pluggable `DMStorage` with built-in `localStorageDMStorage`.

  `/react` ships `useDMSession`, `useThread`, and `useConversations` hooks built on `useSyncExternalStore` for SWR-style updates.

## 0.1.0

### Minor Changes

- Subscription coalescer + four new capability packages.

  `@nostr-wot/data` adds `RequestCoalescer` + `sharedCoalescer` — debounces concurrent reads (50ms window) into a single REQ per relay-set, with subscription dedup via shared handles. Use it for live subscriptions (`enqueue`) or one-shot fetches (`querySync`).

  New packages:

  - `@nostr-wot/signers` — `NostrSigner` interface with four backends: `Nip07Signer` (extension), `Nip46Signer` (NIP-46 bunker), `Nip55Signer` (Android intent), `PrivateKeySigner` (in-memory). Each implements signEvent + optional NIP-04 / NIP-44 encrypt/decrypt.
  - `@nostr-wot/blossom` — `uploadToBlossom`, `mirrorBlob`, `deleteBlob`. Content-addressed file hosting per BUD-01 with kind-24242 signed auth, server failover.
  - `@nostr-wot/dm` — `encryptNip04` / `decryptNip04` for legacy DMs; `buildChatMessage` + `sealAndGiftWrap` + `unwrapGiftWrap` for NIP-17 sealed messages with ±2-day timestamp randomisation.
  - `@nostr-wot/wallet` — `NwcClient` for NIP-47 wallet connect (pay invoice, balance, info, custom methods); `requestZapInvoice` + `buildZapRequest` for NIP-57 zap flows including LNURL-pay resolution.

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/signers@0.1.0
