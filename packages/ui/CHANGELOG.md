# @nostr-wot/ui

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

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/signers@0.3.0

## 0.2.0

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
