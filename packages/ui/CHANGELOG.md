# @nostr-wot/ui

## 0.7.1

### Patch Changes

- [`9e95a70`](https://github.com/nostr-wot/nostr-wot-sdk/commit/9e95a7076bb15e25b048d50c217aaf3759a39d5e) Thanks [@leonacostaok](https://github.com/leonacostaok)! - Internal cleanup (no public API change): remove the dead `getPublicKey` import and its unused-warning suppression in the NIP-46 login method (real calls use `signer.getPublicKey()`).

- Updated dependencies [[`9e95a70`](https://github.com/nostr-wot/nostr-wot-sdk/commit/9e95a7076bb15e25b048d50c217aaf3759a39d5e)]:
  - @nostr-wot/signers@1.0.0

## 0.6.0

### Minor Changes

- @nostr-wot/ui: customization knobs for hosts that bring their own session/persistence.

  - **`flatLayout?: boolean`** on `LoginWidget` / `LoginModal` — render every login method in a single list with no Advanced disclosure. Useful when the host has decided up-front which methods to show and wants the full picker visible at once.
  - **`methodIcons?: Partial<Record<LoginMethodId, ReactNode>>`** — replace the default emoji icon (`🔐`, `🔑`, `✨`, `🛡️`) for any of the four methods. The override renders inside the existing `nui-method-icon` slot so styling is preserved.
  - **`showRememberToggle?: boolean`** — reserved for a future "stay signed in" UI; currently a no-op so consumers can pre-thread the prop without a breaking change later.
  - **Extended `onLogin` payload** — when the host maintains its own session/bridge and needs to re-route the user's auth material, the callback now receives optional method-specific extras:

    - `nsec` for `generate` / `import`
    - `bunkerUri` + `clientNsec` for `nip46`

    For NIP-46 QR mode, the bunker URI is synthesized as `bunker://<pubkey>?relay=...` matching the format `tryRestoreNip46` uses, so the host can later reconnect by passing the URI back through `Nip46Method` paste mode.

  All new props are optional and existing callers keep their current rendering / payload shape.

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/data@0.5.0

## 0.5.1

### Patch Changes

- Updated dependencies []:
  - @nostr-wot/signers@0.4.0

## 0.5.0

### Minor Changes

- @nostr-wot/ui: pluggable signer storage + method discriminator on `onLogin`.

  - **`SignerStorage` adapter.** New `signerStorage?` prop on `<NostrSessionProvider>` lets apps swap the default plaintext-localStorage persistence for any backing — encrypted-at-rest with a WebAuthn-pinned key, IndexedDB AES-GCM, server-side, you name it. The same instance is consumed by every login method and the auto-restore path. Sync or async methods both work.
  - New exports: `SignerStorage` type, `localStorageSignerStorage` (default), `useSignerStorage()` hook for custom slot rendering, and key constants `SIGNER_STORAGE_KEY_NIP46` / `SIGNER_STORAGE_KEY_NSEC` for adapters that want method-aware encryption schemes.
  - `tryRestoreNip46` / `tryRestoreGeneratedOrImported` / `clearPersistedNip46` / `clearPersistedNsec` now accept an optional `SignerStorage` first argument (default: localStorage). Existing callers keep working.
  - **`onLogin` discriminator.** `onLogin` now receives `{ signer, pubkey, method }` where `method` is `"nip07" | "nip46" | "generate" | "import"`. Lets consumers run method-specific follow-ups (e.g. an extension upsell only after `generate`) without needing to inspect the signer instance.

## 0.4.0

### Minor Changes

- @nostr-wot/ui: production-ready login bundle.

  - **Awaited `onLogin` hook**. Replaces the fire-and-forget `onSuccess` semantic with `onLogin?: (args: { signer, pubkey }) => Promise<void>`. Awaited after the signer is attached but before the widget signals success — throw to keep the widget open with the error in the inline `nui-error` slot. `onSuccess` is preserved for fire-and-forget side effects after a successful `onLogin`.
  - **Built-in backend handshake.** New `authBaseUrl` prop — when set, the widget runs the NIP-98 challenge → sign → verify flow against `@nostr-wot/auth` server endpoints automatically (including the JWT cookie set by the server). `rollbackOnAuthFailure` opt-in unsets the local signer if the backend rejects.
  - **Branding slots.** New `slots={{ header, footer, beforeMethods, afterMethods }}` prop accepts arbitrary `ReactNode`s, rendered at the corresponding position around the method list.
  - **`noExtensionCta` prop.** Renderable shown when `nip07` is in the method list but no `window.nostr` is detected. Default: a CTA pointing to https://nostr-wot.com/download. Pass `false` to suppress, or any `ReactNode` to fully customize.
  - **Stable client identity for NIP-46.** The `nostrconnect://` flow now persists the client nsec on QR generation (not just on successful pair). If the user closes the tab and reopens before pairing, the next attempt reuses the same client pubkey so the bunker treats it as the same client (continued permissions, no re-prompt). The full pairing record is overwritten on success; `tryRestoreNip46()` only restores from full records.

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
