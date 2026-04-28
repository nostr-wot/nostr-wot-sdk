# @nostr-wot/ui

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
