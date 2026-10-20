# Nostr WoT SDK

TypeScript libraries for building Nostr applications and signers: read and publish social data, connect a signing backend, manage encrypted accounts, send private messages, take Lightning payments, and query a Web of Trust.

**Unreleased package consolidation:** this branch reduces the maintained public surface from 18 packages to eight. The import paths below describe the replacement release, not a claim that it is already available on npm. Eleven former package names remain compatibility wrappers (19 workspaces including the new identity package); npm deprecation follows publication of their replacements. See the [migration guide](docs/package-migration.md).

## Choose a package

| Package | Use it for |
| --- | --- |
| [`nostr-wot-sdk`](packages/sdk/README.md) | Relay connections, profiles, notes, follows, cache and React session hooks, NIP-07/46 signer clients, Blossom uploads, and portable storage ports. Import individual modules such as `nostr-wot-sdk/data`. |
| [`@nostr-wot/identity`](packages/identity/README.md) | Building a signer or account manager: seed derivation, encrypted vaults and passkey recovery, permissions, approval and signing, and a NIP-46 responder. |
| [`@nostr-wot/wot`](packages/wot/README.md) | Query an Oracle for follow distance or crawl a local IndexedDB graph with `/graph`. |
| [`@nostr-wot/dm`](packages/dm/README.md) | NIP-17 gift-wrapped messages, legacy NIP-04, inbox caching, read cursors, and React hooks. |
| [`@nostr-wot/wallet`](packages/wallet/README.md) | NIP-47 wallet connections, invoice payments, and NIP-57 zaps. |
| [`@nostr-wot/auth`](packages/auth/README.md) | HTTP login with NIP-98, challenge verification, JWT sessions, and Web/Next.js handlers. |
| [`@nostr-wot/ui`](packages/ui/README.md) | React login button, modal or inline widget with extension, bunker, generated-key and imported-key flows. |
| [`@nostr-wot/pq`](packages/pq/README.md) | Seed-derived ML-KEM/ML-DSA identity keys, attestations and hybrid encrypted envelopes. |

Install packages; import their subpaths. For example, `npm install nostr-wot-sdk` provides `nostr-wot-sdk/data`, but `npm install nostr-wot-sdk/data` is not a package install. Add the capability packages your application actually imports and their required peers.

```bash
# Data and signing in a browser or a compatible server runtime
npm install nostr-wot-sdk nostr-tools

# React login; use the same React instance throughout your app
npm install @nostr-wot/ui nostr-wot-sdk nostr-tools react react-dom

# A signer host with portable account and vault management
npm install @nostr-wot/identity nostr-wot-sdk nostr-tools

# Add only the capabilities you need
npm install @nostr-wot/dm @nostr-wot/wallet @nostr-wot/wot
```

## Read a profile

```ts
import { fetchProfile, setDefaultRelays } from 'nostr-wot-sdk/data';

setDefaultRelays(['wss://relay.damus.io', 'wss://nos.lol']);
const profile = await fetchProfile(userPubkey); // user's 64-character hex public key
console.log(profile);
```

## Connect an existing signer

```ts
import { Nip07Signer, isNip07Available } from 'nostr-wot-sdk/signers';

if (!isNip07Available()) throw new Error('Install a NIP-07 signer extension');
const signer = new Nip07Signer();
const pubkey = await signer.getPublicKey();
const event = await signer.signEvent({
  kind: 1,
  content: 'Hello from my app',
  tags: [],
  created_at: Math.floor(Date.now() / 1000),
});
```

Signing does not publish the event. Use the relay module when you are ready to publish. A signer client belongs in an app that requests signatures; `@nostr-wot/identity/signing` belongs in the host that owns accounts and decides whether requests are allowed.

## Runtime and security boundaries

Use `/react` entry points in React applications and install React separately. Browser extension signing requires `window.nostr`; the local graph requires IndexedDB. Server relay clients need a compatible WebSocket implementation. Portable identity code takes storage and host capabilities through explicit interfaces; React Native hosts must supply secure random values and the documented globals.

Login state is not automatically encrypted: the UI's default signer storage uses plaintext localStorage. Supply a protected `signerStorage` adapter when retaining private keys or pairing credentials. The vault provides encryption and scoped secret access, while your host owns unlock UI, transport identity, WebAuthn assertions and authorization. Review each module's defaults before integrating it.

## Guides

- [Package and runtime guide](docs/package-guide.md): which module to use, installation, defaults and teardown.
- [Migration guide](docs/package-migration.md): every retired name and its replacement.
- [Passkey recovery](docs/passkey-recovery.md): provider storage, recovery records and explicit relay fallback.
- [Extension integration](docs/extension-shared-core.md): portable core versus browser-owned responsibilities.

## Development and release

```bash
npm install
npm run build
npm test
npm run build -w nostr-wot-sdk
```

Build before packing or publishing: there is no publish hook that refreshes `dist/`. Follow the repository release preflight and changeset workflow so the verified build is the artifact published. Compatibility packages remain available to existing consumers; publish replacements successfully before adding npm deprecation notices. See [AGENTS.md](AGENTS.md) for repository conventions.

## License

GNU General Public License version 3 only (`GPL-3.0-only`). See [LICENSE](LICENSE) and [NOTICE](NOTICE).
