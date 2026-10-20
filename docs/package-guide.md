# Choose packages for your Nostr application

This guide describes the unreleased eight-package consolidation. Use the [migration table](package-migration.md) when updating an existing consumer; install the replacement versions only once they are published.

## Start with the job

| What you are building | Start here | Add when needed |
| --- | --- | --- |
| A feed, profile page or social client | `nostr-wot-sdk/data` | `/data/cache` for caching, `/data/react` for hooks, `/signers` for signing. |
| A custom relay client or connection monitor | `nostr-wot-sdk/relay` | `/relay/react` for React status views. |
| A login screen | `@nostr-wot/ui` | `@nostr-wot/auth` if the server needs its own authenticated session. |
| An extension or mobile signer | `@nostr-wot/identity/accounts`, `/vault`, `/permissions`, `/signing` | `/bunker` to serve remote NIP-46 clients; `nostr-wot-sdk/storage` for the storage port. |
| A private inbox | `@nostr-wot/dm` | `/cache` for inbox state, `/react` for hooks. |
| Invoice payments or tipping | `@nostr-wot/wallet` | `/react` for UI hooks; `/nwc` for the NWC-focused entry. |
| Follow-distance filtering | `@nostr-wot/wot` | `/graph` for local crawling and IndexedDB instead of Oracle queries. |
| File uploads | `nostr-wot-sdk/blossom` | A compatible signer for authorization. |
| Post-quantum identity and encryption | `@nostr-wot/pq` | A signer backend that explicitly supports the requested hybrid scheme. |

## Install packages, import modules

```bash
npm install nostr-wot-sdk nostr-tools
```

```ts
import { fetchProfile } from 'nostr-wot-sdk/data';
import { Nip07Signer, isNip07Available } from 'nostr-wot-sdk/signers';
```

Subpaths are entry points inside a package, not independently installable npm names. Declare every directly imported package in your application's dependencies. Install required peers explicitly and use one compatible `nostr-tools` and React version across the app. React is optional until you import a React entry point. Install `react-dom` for the login UI.

## App signing versus signer hosting

Use `nostr-wot-sdk/signers` to ask a user's browser extension or remote bunker for signatures. A `PrivateKeySigner` is available for code that intentionally holds a private key in its own process. For another backend, implement the exported `NostrSigner` interface in your application.

Use `@nostr-wot/identity` when you own the account lifecycle and must decide whether another caller can use a key. It supplies account parsing/derivation, vault operations, permissions and the request pipeline. You supply trusted caller identity, approval UI, persistent storage, unlock handling and transport adapters. A NIP-46 responder is transport, not an automatic permission grant.

## Runtime boundaries

| Entry or feature | Runtime requirements |
| --- | --- |
| Social fetchers and relay clients | Network access and compatible WebSocket transport; server runtimes may need an injected implementation. |
| NIP-07 signer | Browser `window.nostr`; check availability before construction. |
| React hooks and login UI | React; the UI also uses React DOM. Mount providers on the client. |
| Local graph | Browser IndexedDB, origin-scoped storage and relay access. |
| Oracle WoT queries | HTTP fetch access to the configured Oracle. |
| Portable identity | Secure randomness, UTF-8 encoders, timers, AbortController and the documented base64 support for PQ operations; storage and host capabilities are injected. |
| Passkey registration/assertion | A host WebAuthn/provider integration; record encryption alone does not perform user verification. |
| HTTP auth | A server with the Web APIs required by its handlers and configured application secrets. Use `/client` in the client and `/next` for Next.js routing. |

Use ESM for identity entry points. Read each package's export map for CommonJS support rather than assuming every subpath supports the same formats. Mobile polyfills must initialize before imports that need them.

## Defaults that affect your integration

The UI defaults to plaintext localStorage for remembered signer state. Supply protected storage before retaining secrets in a production application. Password vault encryption does not turn an empty password into protection. The vault's scoped callbacks must not externalize results before authorization has completed.

NIP-17 inbox relay selection protects recipient metadata. Follow the DM package's discovery and failure behavior instead of adding arbitrary fallback publish relays. NIP-04 remains a legacy compatibility option. Unsupported post-quantum signing/encryption must be reported as a failure, never silently converted to classical encryption.

The WoT package defaults to a public Oracle. A `null` distance means no route was found within the indexed graph and search depth; it is not proof that two accounts have no connection. An HTTP 404 is a server/route error. A local graph avoids that Oracle dependency but is scoped to the browser origin and only knows the events it has crawled.

The auth package creates a server session; a client-side public key alone does not authenticate HTTP requests. Read its challenge, replay, cookie and JWT configuration before mounting endpoints. A NWC connection URI grants wallet capabilities and must be treated as a secret.

## Share state and release resources

Use `nostr-wot-sdk/data/react` as the common session context for login and capability hooks. Keep one owner for each shared pool. Close subscriptions when consumers unmount, close NIP-46 signers on teardown, and cancel abandoned pairing handles. A supplied pool remains caller-owned. Clear or partition account-specific state when switching users according to the relevant cache/session API.

## Detailed references

The maintained [SDK README](../packages/sdk/README.md) and [identity README](../packages/identity/README.md) link to detailed module guides, including retained API contracts, examples and errors. Capability guides are available for [DM](../packages/dm/README.md), [wallet](../packages/wallet/README.md), [auth](../packages/auth/README.md), [UI](../packages/ui/README.md), [WoT](../packages/wot/README.md) and [PQ](../packages/pq/README.md). The old package directories remain as compatibility wrappers and retain their module API reference during migration.
