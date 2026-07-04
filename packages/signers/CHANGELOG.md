# @nostr-wot/signers

## 1.0.0

### Major Changes

- [`9e95a70`](https://github.com/nostr-wot/nostr-wot-sdk/commit/9e95a7076bb15e25b048d50c217aaf3759a39d5e) Thanks [@leonacostaok](https://github.com/leonacostaok)! - BREAKING: Remove dead adapters and unused types.

  - Removed the NDK adapter module (`ndkSignerAsNostrSigner`, `nostrSignerAsNdkSigner`, and all `Ndk*` types).
  - Removed the NIP-55 external-signer skeleton (`Nip55Signer`, `Nip55Bridge`) which had no working transport and zero consumers.
  - Removed the unused `SignerCapabilities` type.

  NIP-07, NIP-46, and in-memory (`PrivateKeySigner`) signers are unchanged.

## 0.4.0

### Minor Changes

- @nostr-wot/signers: ship `nostrSignerAsNdkSigner` — the reverse direction of `ndkSignerAsNostrSigner`.

  Wraps any `NostrSigner` to satisfy NDK's `NDKSigner` interface. Useful when migrating an NDK-backed app's login UI to `@nostr-wot/ui`'s `<LoginModal>` while keeping the rest of the app's call sites (DMs, posts, profile updates) on NDK — wrap the new signer once and assign to `ndk.signer`.

  ```ts
  import { nostrSignerAsNdkSigner } from "@nostr-wot/signers";
  import { NDKUser, type NDKSigner } from "@nostr-dev-kit/ndk";

  const wrapped = await nostrSignerAsNdkSigner(nostrSigner, { NDKUser });
  ndk.signer = wrapped as unknown as NDKSigner;
  ```

  Pubkey is resolved synchronously up front so the resulting signer can be used by NDK code that depends on the sync `pubkey` getter. Encryption/decryption are conditional — calling `encrypt(...,'nip44')` on a wrapper whose underlying signer doesn't implement NIP-44 throws.

  Type-loose w.r.t. NDK (no transitive dep) — caller supplies `NDKUser` constructor when real NDKUser instances are needed.

## 0.3.0

### Minor Changes

- @nostr-wot/signers: NIP-46 nostrconnect QR + auth-URL relay.

  - `Nip46Signer.startNostrConnect({ relays, metadata?, perms?, secret?, pairTimeoutMs?, onAuthChallenge?, ... })` returns `{ uri, clientPubkey, ready, cancel }` — render `uri` as a QR; the bunker scans it; `ready` resolves with the paired signer once it pings us. Symmetrical to `fromBunkerUri` for the client-initiated direction (`nostrconnect://` per NIP-46).
  - `signer.bunkerPubkey` + `signer.relays` getters expose pairing info so consumers can persist + silently restore.
  - `onAuthChallenge(url)` callback on both `fromBunkerUri` and `startNostrConnect` — fires when the bunker responds with `result: "auth_url"`, letting UIs render an "approve in your signer app" banner. The in-flight request stays pending until the bunker delivers the real result or it times out.

  @nostr-wot/ui: QR + paste tabs in the NIP-46 method, auth-URL banner, optional profile setup.

  - `<LoginWidget>` now exposes `nip46Mode={"qr" | "paste"}` (default `"qr"`), `nip46Relays`, `nip46Metadata`, `nip46Perms` props. The NIP-46 step renders tabs to switch between the `nostrconnect://` QR flow and the `bunker://` paste flow.
  - Auth-URL challenges from the bunker render automatically as a green pulsing banner above the QR/form, linking to the approval URL.
  - New `profileSetup` boolean on `<LoginWidget>` (and on `GenerateMethod` directly): when on, after the user generates and backs up their key, asks for name/about/picture and publishes a kind-0 to `profileRelays` (defaults: damus, nos.lol, nostr.band, purplepag.es).
  - Persisted nostrconnect pairings auto-restore on next load via the existing `tryRestoreNip46()` helper — the SDK saves `bunkerPubkey + relays + clientNsec` and reconstructs the signer silently.
  - `qrcode` added as a runtime dep of `@nostr-wot/ui` for QR generation.

## 0.2.0

### Minor Changes

- @nostr-wot/dm: follow-aware eviction, auto-persist, and lifecycle helpers.

  - `setFollowSet(myPubkey, set | null)` / `getFollowSet` / `subscribeFollowSet` — register the user's follow list so eviction can protect active partners. Cold-start contract: never calling this leaves all partners protected.
  - `evictIfNeeded(myPubkey, cap?)` — drop oldest non-followed messages once the cap is exceeded. Followed partners are always preserved.
  - `initDMSession({ ..., autoPersist?, autoPersistDebounceMs?, evictionCap? })` — debounced auto-save and per-mutation eviction. `autoPersist` defaults to `true` when a `storage` is provided.
  - `closeDMSession(session)` — stop auto-persist + eviction subscriptions.
  - `clearDMSession(myPubkey, { storage?, clearStorage? })` — wipe per-account state on logout / account-switch.

  @nostr-wot/signers: NDK adapter.

  - `ndkSignerAsNostrSigner({ ndk, NDKEvent })` — wraps any `NDKSigner` to satisfy the `NostrSigner` interface. NDK is not a dependency; the caller supplies the `NDKEvent` constructor at call time. Lets NDK-using apps adopt `@nostr-wot/*` without rewriting their auth layer.

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

## 0.1.0

### Minor Changes

- Subscription coalescer + four new capability packages.

  `@nostr-wot/data` adds `RequestCoalescer` + `sharedCoalescer` — debounces concurrent reads (50ms window) into a single REQ per relay-set, with subscription dedup via shared handles. Use it for live subscriptions (`enqueue`) or one-shot fetches (`querySync`).

  New packages:

  - `@nostr-wot/signers` — `NostrSigner` interface with four backends: `Nip07Signer` (extension), `Nip46Signer` (NIP-46 bunker), `Nip55Signer` (Android intent), `PrivateKeySigner` (in-memory). Each implements signEvent + optional NIP-04 / NIP-44 encrypt/decrypt.
  - `@nostr-wot/blossom` — `uploadToBlossom`, `mirrorBlob`, `deleteBlob`. Content-addressed file hosting per BUD-01 with kind-24242 signed auth, server failover.
  - `@nostr-wot/dm` — `encryptNip04` / `decryptNip04` for legacy DMs; `buildChatMessage` + `sealAndGiftWrap` + `unwrapGiftWrap` for NIP-17 sealed messages with ±2-day timestamp randomisation.
  - `@nostr-wot/wallet` — `NwcClient` for NIP-47 wallet connect (pay invoice, balance, info, custom methods); `requestZapInvoice` + `buildZapRequest` for NIP-57 zap flows including LNURL-pay resolution.
