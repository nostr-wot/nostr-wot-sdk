# @nostr-wot/dm

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
