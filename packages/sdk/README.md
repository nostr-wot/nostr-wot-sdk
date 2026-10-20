# nostr-wot-sdk

The application foundation for Nostr: relay connections, social data, caching, signer clients, Blossom uploads and portable key/value storage. Import the modules you need; React is only required by React entry points.

> Unreleased consolidation: these modules now live in this package. The old scoped names become compatibility wrappers after the replacement release is published. See the [migration guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/docs/package-migration.md).

## Install

```bash
npm install nostr-wot-sdk nostr-tools
# Only for React entry points:
npm install react
```

Do not install a subpath such as `nostr-wot-sdk/data`. Install `nostr-wot-sdk` and use the subpath in your imports.

## Modules

| Import | Capabilities and API guide |
| --- | --- |
| `nostr-wot-sdk/data` | [Profiles, notes, threads, follows, reactions, reposts, zaps and NIP-65 relay discovery](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/data/README.md). Also exposes the shared pool and subscription coalescer. |
| `nostr-wot-sdk/data/cache` | Observable stale-while-revalidate caches and optional persistence. |
| `nostr-wot-sdk/data/react` | Data hooks, `NostrDataProvider`, `NostrSessionProvider` and `useSession`. |
| `nostr-wot-sdk/relay` | [RelayPool, RelayManager, QueryBatcher and RelayStats](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/relay/README.md). Use this when building a custom data layer. |
| `nostr-wot-sdk/relay/react` | Relay state providers and hooks. |
| `nostr-wot-sdk/relay/hub` | Shared relay hub integration; see the relay guide for transport ownership. |
| `nostr-wot-sdk/signers` | [Nip07Signer, Nip46Signer and PrivateKeySigner](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/signers/README.md). |
| `nostr-wot-sdk/blossom` | [Upload, mirror and delete blobs with signed authorization and server failover](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/blossom/README.md). |
| `nostr-wot-sdk/storage` | [KeyValueStore, MemoryStore and namespaced stores](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/packages/storage/README.md). |

## Fetch data without React

```ts
import { fetchProfile, fetchFollows, setDefaultRelays } from 'nostr-wot-sdk/data';

setDefaultRelays(['wss://relay.damus.io', 'wss://nos.lol']);
const profile = await fetchProfile(userPubkey);
const follows = await fetchFollows(userPubkey);
```

Pass hexadecimal Nostr public keys and event IDs. The `/cache` layer adds shared cached results; the `/react` layer subscribes components to them. Configure relays deliberately for your application. NIP-65 relay discovery is for public data and is not a substitute for the DM package's recipient inbox privacy rules.

## Request a signature

```ts
import { Nip07Signer, isNip07Available } from 'nostr-wot-sdk/signers';

if (!isNip07Available()) throw new Error('A NIP-07 extension is required');
const signer = new Nip07Signer();
const event = await signer.signEvent({
  kind: 1, content: 'Hello', tags: [],
  created_at: Math.floor(Date.now() / 1000),
});
```

`Nip07Signer` requires a browser extension. `Nip46Signer` connects to a remote signer and supports bunker URIs or QR pairing. Close the signer when finished, and cancel abandoned QR pairing handles. `PrivateKeySigner` keeps a key in your process; use it only where that key can be trusted to the application.

Encryption methods on `NostrSigner` are optional. Check support before invoking them. A backend that cannot satisfy an explicitly requested post-quantum operation must fail rather than downgrade it.

## React sessions

Import the shared session provider and hooks from `nostr-wot-sdk/data/react`. Add `@nostr-wot/ui` for a login interface; add `@nostr-wot/dm`, `@nostr-wot/wallet` or `@nostr-wot/wot` for those capabilities. Use one shared session context so each capability sees the same active signer.

The historical `NostrSdkProvider` remains available from `nostr-wot-sdk/react`; its WoT dependency remains installed with the SDK. For new integrations, compose the data/session providers with `WoTProvider` from `@nostr-wot/wot/react` when WoT context is needed. React modules are client-side integrations; do not construct browser signers during server rendering.

## Compatibility imports

The package root retains the historical WoT API, and `/react`, `/graph` and `/graph/react` retain their WoT compatibility exports. `@nostr-wot/wot` remains a direct SDK dependency for this compatibility. The `/dm`, `/dm/react`, `/wallet`, `/wallet/react`, `/auth` and `/ui` compatibility entry points require the corresponding optional peer package: install it explicitly before importing the entry. These capabilities are no longer installed automatically with the SDK.

For new code, use `@nostr-wot/wot`, `@nostr-wot/wot/react`, `@nostr-wot/wot/graph`, `@nostr-wot/dm`, `@nostr-wot/wallet`, `@nostr-wot/auth` and `@nostr-wot/ui` directly. Import UI CSS from `@nostr-wot/ui/styles.css`; auth's `/client` and `/next` adapters belong to `@nostr-wot/auth`.

## Runtime and cleanup

Network modules need the relevant fetch/WebSocket APIs; portable storage has no DOM requirement. React hooks need React; browser cache persistence needs browser storage. Close subscriptions and signer-owned transports on teardown. A caller-supplied pool stays caller-owned. `MemoryStore` is ephemeral and does not encrypt values; `namespaced` separates keys, not security domains.

## License

GNU General Public License version 3 only (`GPL-3.0-only`). See [LICENSE](LICENSE) and [NOTICE](NOTICE).
