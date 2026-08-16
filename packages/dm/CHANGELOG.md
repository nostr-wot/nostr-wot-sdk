# @nostr-wot/dm

## 0.6.0

### Minor Changes

- [#7](https://github.com/nostr-wot/nostr-wot-sdk/pull/7) [`596646b`](https://github.com/nostr-wot/nostr-wot-sdk/commit/596646bcc1e881b671df80abb6239ef8cf6eb9df) Thanks [@leonacostaok](https://github.com/leonacostaok)! - `sealAndGiftWrap` gains an optional `pq` option (`{ scheme: 'pq'; recipientKemKey: string }`), which it passes straight through to the signer's `nip44Encrypt` to seal with `@nostr-wot/pq`'s hybrid ML-KEM-1024 + NIP-44 envelope instead of plain NIP-44 ciphertext. Nothing outside the seal changes — a relay or a client that hasn't implemented this still sees an ordinary kind-1059 gift wrap. `sendDM` gains a matching `pq` option on `SendDMOptions`, threaded straight through.

  `unwrapGiftWrap` needs no new option at all: `signer.nip44Decrypt` auto-routes on its own, since the post-quantum envelope is self-describing. A single conversation can freely mix classic and post-quantum messages, and existing callers of `unwrapGiftWrap` (`cache/inbox.ts`, `cache/backfill.ts`) get post-quantum support with no changes on their part, as long as the signer supports it (requires `@nostr-wot/signers` >=1.2.0).

  This package does not depend on `@nostr-wot/pq` and never touches post-quantum key material — the signer owns that, by design, since it's the layer that already owns key material for every other scheme. A post-quantum message sealed by `@nostr-wot/dm` is byte-compatible with `@nostr-wot/pq`'s `openPqDirectMessage`, and vice versa, verified by cross-package round-trip tests.

### Patch Changes

- [#7](https://github.com/nostr-wot/nostr-wot-sdk/pull/7) [`a01cd21`](https://github.com/nostr-wot/nostr-wot-sdk/commit/a01cd21008603e58ccd0d53165de593fe604b796) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Verify the seal's signature and cross-check rumor authorship in `unwrapGiftWrap`.

  Previously the seal's `sig` was never checked, and the inner rumor's `pubkey` was returned to the caller without validation against the seal's signer. The NIP-44 conversation-key binding already made this safe in practice, but the returned `message.pubkey` was unvalidated and attacker-influenced: a sender could honestly seal with their own key while setting the rumor's author field to anyone, and any consumer reading `message.pubkey` — the natural author field on a Nostr event — would get a forged identity.

  `unwrapGiftWrap` now verifies the seal's signature and rejects a rumor whose `pubkey` (when present) does not match the seal's signer, mirroring `@nostr-wot/pq`'s `openPqDirectMessage`. Both new checks fail the same way the function's existing decrypt failures do, so callers cannot use the error to distinguish which check failed. No wire format change.

- Updated dependencies [[`bdddcd6`](https://github.com/nostr-wot/nostr-wot-sdk/commit/bdddcd63e0181c8ee4d9906a31c93b02ca64ac9a)]:
  - @nostr-wot/signers@1.2.0

## 0.5.2

### Patch Changes

- Updated dependencies [[`7ecf9cb`](https://github.com/nostr-wot/nostr-wot-sdk/commit/7ecf9cbc4312f9b2d635ed2b5c1caf8fd3d237ab)]:
  - @nostr-wot/signers@1.1.0

## 0.5.1

### Patch Changes

- [`9e95a70`](https://github.com/nostr-wot/nostr-wot-sdk/commit/9e95a7076bb15e25b048d50c217aaf3759a39d5e) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Internal cleanup (no public API change): remove the dead `_publishPool` re-export and its unused-warning suppression, and the unused `DraftMessage` type.

- Updated dependencies [[`9e95a70`](https://github.com/nostr-wot/nostr-wot-sdk/commit/9e95a7076bb15e25b048d50c217aaf3759a39d5e)]:
  - @nostr-wot/signers@1.0.0

## 0.5.0

### Minor Changes

- @nostr-wot/dm: pluggable storage prefix for the encrypted DM cache key.

  `getOrCreateCacheKey(myPubkey, signer, opts)` now accepts `opts.storageKeyPrefix` to override the default `@nostr-wot/dm:cache-key:` namespace. Apps migrating off a pre-existing key namespace need their own prefix or every existing user's encrypted-at-rest data is invalidated. The in-memory key cache also incorporates the prefix so multi-app processes don't collide on the same pubkey.

  Example (Obelisk migrating from a legacy `obelisk:dm-cache-key:` namespace):

  ```ts
  const key = await getOrCreateCacheKey(myPubkey, signer, {
    storageKeyPrefix: "obelisk:dm-cache-key:",
  });
  ```

  Default behaviour unchanged for callers that don't pass the option.

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/data@0.5.0

## 0.4.3

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/signers@0.4.0

## 0.4.2

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/signers@0.3.0

## 0.4.1

### Patch Changes

- New package `@nostr-wot/ui` — headless React UI for Nostr login.

  - `<NostrSessionProvider>`, `<LoginButton>`, `<LoginModal>`, `<LoginWidget>` — four login methods (NIP-07, NIP-46, generate, import) wired to a shared session context. Headless by default; ship `@nostr-wot/ui/styles.css` for a default look or skip and bring your own.
  - Themable via CSS variables on the provider's `data-nui-root` attribute (option A). Per-element class/style overrides via `classes={{...}}` / `styles={{...}}` slot props on every component.
  - Silent re-attach on mount: NIP-46 from saved bunker URI, remembered nsec when explicitly opted-in.

  `@nostr-wot/data/react` adds `<NostrSessionProvider>` + `useSession`, `useSigner`, `usePubkey`, `useLogin`, `useLogout`. This is the single mount point for the active signer; DM/blossom/wallet hooks read it from context. Lives in `data/react` (not `ui`) so non-UI packages can consume it without dragging in the React UI package.

  `@nostr-wot/dm/react`'s `useDMSession({ signer?, ... })` now treats `signer` as optional — when omitted, falls back to the session context. Existing call sites that pass a `signer` keep working.

  `<NostrSdkProvider>` from the meta package now mounts `<NostrSessionProvider>` by default. Pass `session={{ enabled: false }}` to opt out (e.g. when an outer session provider already wraps the tree).

- Updated dependencies []:
  - @nostr-wot/data@0.4.0

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
