# @nostr-wot/blossom

## 0.2.1

### Patch Changes

- [#14](https://github.com/nostr-wot/nostr-wot-sdk/pull/14) [`938faf4`](https://github.com/nostr-wot/nostr-wot-sdk/commit/938faf42f1f322c2ae44b9970c671c3fed509506) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Update pinned shared dependencies so file uploads, messaging and wallet consumers receive the current signer lifecycle fixes. Wallet also uses the latest relay connection-budget safeguards.

- Updated dependencies [[`9439868`](https://github.com/nostr-wot/nostr-wot-sdk/commit/9439868eeefd6d18dc504c313354dadfd3bfe77e)]:
  - @nostr-wot/signers@1.2.3

## 0.2.0

### Minor Changes

- [#13](https://github.com/nostr-wot/nostr-wot-sdk/pull/13) [`bfba05f`](https://github.com/nostr-wot/nostr-wot-sdk/commit/bfba05f4c41239e709182c28a144cc22a670fc7f) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Add anonymous encrypted-blob uploads with fresh ephemeral identities and server-scoped BUD-11 authorization. Share immutable upload bytes and validated BUD-02 descriptors across public and encrypted uploads, expose aggregate server failure diagnostics, and stop failover on cancellation or session changes. Public uploads preserve a single signature by default and can opt into server binding. Correct mirror/delete documentation and add distribution freshness checks.

## 0.1.8

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/signers@1.2.1

## 0.1.7

### Patch Changes

- Updated dependencies [[`bdddcd6`](https://github.com/nostr-wot/nostr-wot-sdk/commit/bdddcd63e0181c8ee4d9906a31c93b02ca64ac9a)]:
  - @nostr-wot/signers@1.2.0

## 0.1.6

### Patch Changes

- Updated dependencies [[`7ecf9cb`](https://github.com/nostr-wot/nostr-wot-sdk/commit/7ecf9cbc4312f9b2d635ed2b5c1caf8fd3d237ab)]:
  - @nostr-wot/signers@1.1.0

## 0.1.5

### Patch Changes

- Updated dependencies [[`9e95a70`](https://github.com/nostr-wot/nostr-wot-sdk/commit/9e95a7076bb15e25b048d50c217aaf3759a39d5e)]:
  - @nostr-wot/signers@1.0.0

## 0.1.4

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/signers@0.4.0

## 0.1.3

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/signers@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/signers@0.2.0

## 0.1.1

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
  - @nostr-wot/signers@0.1.1

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
