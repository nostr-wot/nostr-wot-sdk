# nostr-wot-sdk/signers

> Package consolidation: this is the API guide for `nostr-wot-sdk/signers`. The former `@nostr-wot/signers` package is a deprecated compatibility re-export. Install the owning package shown below; a subpath is an import, not an npm package. See the [migration guide](https://github.com/nostr-wot/nostr-wot-sdk/blob/main/docs/package-migration.md).

Signer abstractions for Nostr — one interface, three backends. Used by every other `@nostr-wot/*` package that needs to sign or decrypt.

| Class | Backend | When to use |
|---|---|---|
| `Nip07Signer` | `window.nostr` browser extension | Browser apps where the user has Alby / nos2x / Flamingo / Nostore installed |
| `Nip46Signer` | NIP-46 Nostr Connect (bunker) | Remote signers and mobile bunker apps |
| `PrivateKeySigner` | In-memory `Uint8Array` | Tests, CLIs, server-side signing |

## Install

```bash
npm i nostr-wot-sdk nostr-tools
```

## The interface

```ts
interface NostrSigner {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<Event>;
  nip04Encrypt?(pubkey: string, plaintext: string): Promise<string>;
  nip04Decrypt?(pubkey: string, ciphertext: string): Promise<string>;
  nip44Encrypt?(pubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt?(pubkey: string, ciphertext: string): Promise<string>;
  close?(): Promise<void> | void;
}
```

Encryption methods are optional — not every backend supports both NIP-04 and NIP-44. Check `typeof signer.nip44Encrypt === "function"` before calling.

## Post-quantum sealing

This is the layer that performs post-quantum sealing, because it's the layer that already owns key material for every other scheme. `@nostr-wot/pq` supplies the pure ML-KEM-1024 + NIP-44 hybrid envelope; `@nostr-wot/dm` only does transport, passing an opaque `pq` option through to `nip44Encrypt` without ever seeing a key. `PrivateKeySigner` implements it directly — configure its ML-KEM keypair with the `pqKem` constructor option, derived via `@nostr-wot/pq`'s `derivePqKeys` — and `Nip07Signer` forwards the option to `window.nostr.nip44.encrypt` as a third argument, omitting it entirely for extensions that don't expect one.

```ts
import { PrivateKeySigner } from "nostr-wot-sdk/signers";
import { derivePqKeys } from "@nostr-wot/pq";

const { kem: pqKem } = derivePqKeys(seed, 0);
const signer = new PrivateKeySigner(sk, { pqKem });

const sealed = await signer.nip44Encrypt(recipientPubkey, plaintext, {
  scheme: "pq",
  recipientKemKey, // recipient's ML-KEM-1024 key, base64, from their kind:10203 attestation
});
```

`Nip46Signer` cannot do this, and that's deliberate rather than a gap to fill: `nostr-tools`' `BunkerSigner.nip44Encrypt` sends NIP-46's `nip44_encrypt` request over the wire as `[pubkey, plaintext]`, with no channel for a third parameter, so there is nowhere to put `recipientKemKey`. Asked for `{ scheme: 'pq' }`, it throws instead of quietly sealing with plain NIP-44 — a signer that can't honor a post-quantum request must fail loudly, because a silent downgrade of a message the caller explicitly asked to protect post-quantum is exactly the failure this scheme exists to prevent.

## NIP-07 (browser extension)

```ts
import { Nip07Signer } from "nostr-wot-sdk/signers";

const signer = new Nip07Signer();          // detects window.nostr
const pubkey = await signer.getPublicKey();
const event = await signer.signEvent({
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: "hello",
});
```

`Nip07Signer` is a thin wrapper around `window.nostr.*`. It throws synchronously if no extension is detected — wrap construction in a try/catch or check `isNip07Available()` first.

## NIP-46 (bunker)

Two pairing modes:

### Bunker-initiated (paste a `bunker://` URI)

```ts
import { Nip46Signer } from "nostr-wot-sdk/signers";

const signer = await Nip46Signer.fromBunkerUri(
  "bunker://abc...?relay=wss://relay.x&secret=xxx",
  {
    onAuthChallenge: (url) => {
      // Bunker asked the user to approve at this URL — show a banner.
      window.open(url, "_blank");
    },
  },
);

// Persist client identity so future sessions reuse it
// credentialStore is an application-provided protected storage adapter.
await credentialStore.set("bunker-client-nsec", signer.exportClientNsec());
```

`fromBunkerUri` accepts the standard `bunker://` URI (Amber's QR pairing, Nsec.app's connection screen, etc.) and auto-generates an ephemeral client key. Export it with `exportClientNsec()` and re-supply on next session — the bunker remembers paired clients by pubkey, so reusing the same client identity avoids re-authorization prompts.

### Client-initiated (`nostrconnect://` QR)

The desktop generates the URI and shows it as a QR; the bunker scans it.

```ts
import { Nip46Signer } from "nostr-wot-sdk/signers";

const handle = Nip46Signer.startNostrConnect({
  relays: ["wss://relay.nsec.app", "wss://relay.damus.io"],
  metadata: { name: "MyApp", url: "https://myapp.com" },
  perms: "sign_event:1,nip44_encrypt,nip44_decrypt",
  pairTimeoutMs: 5 * 60_000,
  onAuthChallenge: (url) => {/* user-approval banner */},
});

renderQr(handle.uri);          // nostrconnect://<clientPubkey>?...
const signer = await handle.ready;  // resolves once the bunker pairs
```

`handle.cancel()` stops the pairing wait early. After `await handle.ready`, the signer behaves identically to one created via `fromBunkerUri` — `exportClientNsec()`, `signer.bunkerPubkey`, and `signer.relays` are all populated.

### Auth-URL challenges

The bunker may respond to any signing call with `result: "auth_url"` (meaning "ask the user to approve at this URL, then I'll send the real result"). Both `fromBunkerUri` and `startNostrConnect` accept an `onAuthChallenge(url)` callback — render the URL as a banner / link; the in-flight request stays pending until the bunker eventually responds with the real result or it times out.

## Private key (tests, CLIs, servers)

```ts
import { PrivateKeySigner } from "nostr-wot-sdk/signers";

import { generateSecretKey } from "nostr-tools";

const signer = new PrivateKeySigner(generateSecretKey());
// Or pass an existing 32-byte Uint8Array / 64-character hex secret key.
```

Supports all four encryption operations (NIP-04 + NIP-44). Use only when the key is loaded into a process you control — never expose this signer to untrusted scripts in a browser.

## Other signer backends

Implement `NostrSigner` to connect a backend not exported here. The current package exports NIP-07, NIP-46 and private-key implementations; it does not export NIP-55 or NDK adapters. Your adapter owns transport integration and must fail explicitly when a requested encryption scheme is unsupported.

## Composition

The `NostrSigner` interface is what every other SDK package consumes. To swap backends, just construct a different signer:

```ts
import { uploadToBlossom } from "nostr-wot-sdk/blossom";
import { sealAndGiftWrap } from "@nostr-wot/dm";
import { requestZapInvoice } from "@nostr-wot/wallet";

const signer = new Nip07Signer();
// or
const signer = await Nip46Signer.fromBunkerUri(uri);

await uploadToBlossom(file, { signer });
await sealAndGiftWrap(signer, recipientPubkey, {
  pubkey: await signer.getPublicKey(), kind: 14, content: message,
  tags: [["p", recipientPubkey]], created_at: Math.floor(Date.now() / 1000),
});
await requestZapInvoice(signer, {
  recipientPubkey, amountMsats, lud16, relays: ["wss://relay.damus.io"],
});
```

## License

GNU General Public License version 3 only (`GPL-3.0-only`) — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

### NIP-46 transport lifetime

Call `await signer.close()` on teardown, or `handle.cancel()` when abandoning QR pairing. An internally created pool belongs to the signer: failed pairing, timeout, cancellation, and close dispose its sockets, including connections still opening. A pool supplied through `pool` remains caller-owned; cleanup closes only this signer's subscriptions and never destroys the shared pool. The socket disposal follows the extension's `src/services/signing/nip46Connection.ts` transport ownership rules.
