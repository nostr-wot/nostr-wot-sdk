# @nostr-wot/wallet

## 0.3.1

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/data@0.5.1

## 0.3.0

### Minor Changes

- @nostr-wot/wallet: WebLN zap pipeline, LNbits → NWC URI helper, and stricter `buildZapRequest` validation.

  - **`zapViaWebLN({ recipient, amountSats, comment?, eventId?, relays, signer })`** — full NIP-57 + WebLN zap flow in one call. Resolves the recipient's `lud16` → fetches LNURL-pay metadata → builds a kind-9734 zap request → mints an invoice → asks the user's WebLN provider (`window.webln`) to pay. Throws on any step with a clear message so the caller can surface it.
  - **`isWebLNAvailable()`** — `true` when `window.webln` is present.
  - **`lnbitsToNwc({ adminUrl, adminKey, walletId? })`** — converts an LNbits admin URL + admin-key pair into an `nostr+walletconnect://` URI. Drop-in for apps that want to bootstrap an NWC connection from existing LNbits credentials without manually crafting the URI.
  - **`buildZapRequest` validation** — empty `relays` or non-positive `amountMsats` now throw early, matching NIP-57 requirements. Previously the function happily produced an unsendable zap request.

  The webln module is a separate file so consumers that don't ship a wallet UI don't pay for the import.

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/data@0.5.0

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
