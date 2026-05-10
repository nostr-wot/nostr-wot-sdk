# nostr-wot-sdk monorepo

A set of focused, peer-dep-only packages that compose into a full Nostr stack — data, signers, login UI, DMs, blossom uploads, wallets, WoT, and a server-side auth helper. Pick the slices you need; the meta package re-exports the core for back-compat.

## Packages

### Data + transport

| Package | Scope | Depends on |
|---|---|---|
| **[`@nostr-wot/data`](./packages/data)** | Profiles, notes, threads, follows, engagement (reactions/reposts/zaps) + NIP-65 outbox + subscription coalescer. Optional SWR cache + React hooks at `/cache` and `/react` subpaths. Also hosts the shared `<NostrSessionProvider>` (single mount point for the active signer). | `nostr-tools` (peer) |
| **[`@nostr-wot/relay`](./packages/relay)** | Standalone relay utilities — pool, query batcher, stats. Lower-level than `@nostr-wot/data`. | `nostr-tools` (peer) |
| **[`@nostr-wot/wot`](./packages/wot)** | Web-of-Trust scoring + browser-extension bridge. Includes `<NostrSdkProvider>` (the recommended top-level React provider) and React/Solid hooks. | `@nostr-wot/data` |

### Auth + UI

| Package | Scope | Depends on |
|---|---|---|
| **[`@nostr-wot/signers`](./packages/signers)** | One `NostrSigner` interface, four backends — `Nip07Signer` (extension), `Nip46Signer` (bunker, with `nostrconnect://` QR + auth-URL relay), `Nip55Signer` (Android/Amber), `PrivateKeySigner`. Plus NDK bridges in both directions (`ndkSignerAsNostrSigner`, `nostrSignerAsNdkSigner`). | `nostr-tools` (peer) |
| **[`@nostr-wot/ui`](./packages/ui)** | Headless React login UI — `<NostrSessionProvider>`, `<LoginButton>`, `<LoginModal>`, `<LoginWidget>`. Four login methods, NIP-46 QR + paste tabs, optional profile-setup wizard, pluggable encrypted-at-rest signer storage, branding slots, themable via CSS variables (built-in `light` / `dark` / `la-crypta` themes). Built-in `@nostr-wot/auth` handshake when you set `authBaseUrl`. | `@nostr-wot/data`, `@nostr-wot/signers` |
| **[`@nostr-wot/auth`](./packages/auth)** | Server-side NIP-98 challenge / verify / JWT for Nostr login. Web-standard handlers + Next.js shim + a client helper that pairs with `@nostr-wot/ui`'s `authBaseUrl`. | — |

### Capability packages

| Package | Scope | Depends on |
|---|---|---|
| **[`@nostr-wot/dm`](./packages/dm)** | Direct messages — NIP-04 legacy + NIP-17 sealed gift-wraps. `/cache` adds a follow-aware DM session with backfill, read cursors, kind-10050 inbox publish, and at-rest encryption (NIP-44-self KEK, non-extractable AES-GCM). `/react` adds `useDMSession`, `useUnreadCount`, etc. | `@nostr-wot/signers` (peer) |
| **[`@nostr-wot/blossom`](./packages/blossom)** | Blossom file hosting (BUD-01) — `uploadToBlossom`, `mirrorBlob`, `deleteBlob` with kind-24242 signed auth and server failover. | `@nostr-wot/signers` (peer) |
| **[`@nostr-wot/wallet`](./packages/wallet)** | NIP-47 NWC client (pay invoice, balance, info) + NIP-57 zap helpers (`requestZapInvoice`, `buildZapRequest`, LNURL-pay resolution). | `@nostr-wot/signers` (peer) |

### Meta

| Package | Scope | Depends on |
|---|---|---|
| **[`nostr-wot-sdk`](./packages/sdk)** | Back-compat meta-package re-exporting `data` / `relay` / `wot`. Existing imports keep working. | the three scoped packages |

## Install

Pick what you need:

```bash
# Login UI + signers + data — the most common starting point for a React app
npm i @nostr-wot/ui @nostr-wot/data @nostr-wot/signers nostr-tools react react-dom

# Add capabilities as needed
npm i @nostr-wot/dm @nostr-wot/blossom @nostr-wot/wallet

# Server-side login (Next.js, Hono, plain Web handlers)
npm i @nostr-wot/auth

# WoT scoring + extension bridge
npm i @nostr-wot/wot

# Low-level pool / batcher
npm i @nostr-wot/relay

# Back-compat meta (data + relay + wot under the original name)
npm i nostr-wot-sdk
```

## What the UI does

`@nostr-wot/ui` is the React login surface. Drop `<NostrSessionProvider>` at the top of your tree and `<LoginButton>` anywhere — the user picks a method, the SDK constructs the corresponding `NostrSigner`, and stores it in a shared session context that every other `@nostr-wot/*` package reads from.

| Method | What it does |
|---|---|
| **NIP-07** | Connects to `window.nostr` (Alby, nos2x, Flamingo, Nostore). If no extension is detected, shows a CTA pointing to `nostr-wot.com/download` (overridable). |
| **NIP-46** | Two tabs: scan a `nostrconnect://` QR (desktop ↔ phone) or paste a `bunker://` URI. Auth-URL prompts from the bunker render as a green pulsing banner. Pairings auto-restore on next load. |
| **Generate** | Generates a fresh keypair on-device, shows nsec/npub for backup, optionally publishes a kind-0 profile (name/about/picture) to your relay set. |
| **Import** | Pastes nsec or 64-char hex private key. |

It's headless by default — ship `@nostr-wot/ui/styles.css` for the default look (light / dark via `prefers-color-scheme`, plus a built-in `la-crypta` theme), or skip the import and bring your own classes via the `classes={{...}}` slot props on every component. CSS-variable theming scopes cleanly under `[data-nui-root]`.

Production knobs:

- `authBaseUrl` — auto-runs the NIP-98 challenge → sign → verify handshake against `@nostr-wot/auth` server endpoints, including JWT cookie set by the server
- `onLogin` — awaited hook receiving `{ signer, pubkey, method }`; throw to keep the modal open with an inline error
- `signerStorage` — pluggable adapter for persisted login state (NIP-46 pairing, remembered nsec). Default is plaintext localStorage; swap in a WebAuthn-pinned AES-GCM adapter, IndexedDB, server-side, etc.
- `slots={{ header, footer, beforeMethods, afterMethods }}` — branding insertion points around the method list
- `profileSetup` — extends the Generate flow with a name/about/picture step that publishes kind-0

Once signed in, `@nostr-wot/dm`, `@nostr-wot/blossom`, and `@nostr-wot/wallet` hooks read the active signer from session context — no prop-drilling.

## Architecture

```
                ┌──────────────────────────────┐
                │ Your Nostr-aware React app   │
                └──────────────┬───────────────┘
                               │
              ┌────────────────▼────────────────┐
              │  <NostrSdkProvider>             │  nostr-wot-sdk (or compose
              │  └─ <NostrSessionProvider>      │   the providers yourself)
              │  └─ <NostrDataProvider>         │
              │  └─ (opt-in) WoT context        │
              └────────────────┬────────────────┘
                               │
   ┌───────────────────┬───────┼───────┬────────────────┬────────────┐
   ▼                   ▼       ▼       ▼                ▼            ▼
@nostr-wot/ui     @nostr-wot   data    signers      dm/blossom   @nostr-wot
(login modal,     /wot         (fetch, (Nip07/46/   /wallet      /auth
 widget, button)  (scoring,    cache,   55, PK,     (read signer  (server NIP-98
                  ext bridge)  outbox,  NDK ↔)      from session)  + JWT)
                               session
                               provider)
                                  │
                                  ▼
                            nostr-tools (peer)
```

`@nostr-wot/data` is the portable artifact — SWR observable + per-kind caches + NIP-65 outbox + the shared session context in ~1000 LOC. Runtime-agnostic, no NDK dependency, peer-deps only on `nostr-tools` (and `react` for the `/react` entry).

The session provider lives in `@nostr-wot/data/react` (not `ui`) on purpose: non-UI packages can read the active signer without dragging in the React UI bundle.

## Development

npm-workspaces monorepo.

```bash
git clone git@github.com:nostr-wot/nostr-wot-sdk.git
cd nostr-wot-sdk
npm install
npm run build       # builds all packages in dependency order
npm test
```

Per-package work:
```bash
npm run build -w @nostr-wot/data
npm run dev -w @nostr-wot/ui
```

## Publishing

Each scoped package versions and publishes independently. The meta-package bumps in lock-step with the highest scoped version so installs stay coherent.

```bash
cd packages/data    && npm publish --access public
cd packages/relay   && npm publish --access public
cd packages/wot     && npm publish --access public
cd packages/signers && npm publish --access public
cd packages/ui      && npm publish --access public
cd packages/auth    && npm publish --access public
cd packages/dm      && npm publish --access public
cd packages/blossom && npm publish --access public
cd packages/wallet  && npm publish --access public
cd packages/sdk     && npm publish --access public
```

## License

MIT — see [LICENSE](LICENSE).
