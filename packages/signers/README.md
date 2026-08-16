# @nostr-wot/signers

Signer abstractions for Nostr — one interface, four backends. Used by every other `@nostr-wot/*` package that needs to sign or decrypt.

| Class | Backend | When to use |
|---|---|---|
| `Nip07Signer` | `window.nostr` browser extension | Browser apps where the user has Alby / nos2x / Flamingo / Nostore installed |
| `Nip46Signer` | NIP-46 Nostr Connect (bunker) | Remote signers, mobile bunker apps, air-gapped key storage |
| `Nip55Signer` | NIP-55 Android intent | Android webviews / TWAs that delegate to Amber |
| `PrivateKeySigner` | In-memory `Uint8Array` | Tests, CLIs, server-side signing |

## Install

```bash
npm i @nostr-wot/signers nostr-tools
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

This is the layer that performs post-quantum sealing, because it's the layer that already owns
key material for every other scheme. `@nostr-wot/pq` supplies the pure ML-KEM-1024 + NIP-44
hybrid envelope; `@nostr-wot/dm` only does transport, passing an opaque `pq` option through to
`nip44Encrypt` without ever seeing a key. `PrivateKeySigner` implements it directly — configure
its ML-KEM keypair with the `pqKem` constructor option, derived via `@nostr-wot/pq`'s
`derivePqKeys` — and `Nip07Signer` forwards the option to `window.nostr.nip44.encrypt` as a
third argument, omitting it entirely for extensions that don't expect one.

```ts
import { PrivateKeySigner } from "@nostr-wot/signers";
import { derivePqKeys } from "@nostr-wot/pq";

const { kem: pqKem } = derivePqKeys(seed, 0);
const signer = new PrivateKeySigner(sk, { pqKem });

const sealed = await signer.nip44Encrypt(recipientPubkey, plaintext, {
  scheme: "pq",
  recipientKemKey, // recipient's ML-KEM-1024 key, base64, from their kind:10203 attestation
});
```

`Nip46Signer` cannot do this, and that's deliberate rather than a gap to fill: `nostr-tools`'
`BunkerSigner.nip44Encrypt` sends NIP-46's `nip44_encrypt` request over the wire as
`[pubkey, plaintext]`, with no channel for a third parameter, so there is nowhere to put
`recipientKemKey`. Asked for `{ scheme: 'pq' }`, it throws instead of quietly sealing with plain
NIP-44 — a signer that can't honor a post-quantum request must fail loudly, because a silent
downgrade of a message the caller explicitly asked to protect post-quantum is exactly the
failure this scheme exists to prevent.

## NIP-07 (browser extension)

```ts
import { Nip07Signer } from "@nostr-wot/signers";

const signer = new Nip07Signer();          // detects window.nostr
const pubkey = await signer.getPublicKey();
const event = await signer.signEvent({
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: "hello",
});
```

`Nip07Signer` is a thin wrapper around `window.nostr.*`. It throws synchronously if no extension is detected — wrap construction in a try/catch or check `Nip07Signer.isAvailable()` first.

## NIP-46 (bunker)

Two pairing modes:

### Bunker-initiated (paste a `bunker://` URI)

```ts
import { Nip46Signer } from "@nostr-wot/signers";

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
localStorage.setItem("bunker-client-nsec", signer.exportClientNsec());
```

`fromBunkerUri` accepts the standard `bunker://` URI (Amber's QR pairing, Nsec.app's connection screen, etc.) and auto-generates an ephemeral client key. Export it with `exportClientNsec()` and re-supply on next session — the bunker remembers paired clients by pubkey, so reusing the same client identity avoids re-authorization prompts.

### Client-initiated (`nostrconnect://` QR)

The desktop generates the URI and shows it as a QR; the bunker scans it.

```ts
import { Nip46Signer } from "@nostr-wot/signers";

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

## NIP-55 (Android Amber)

```ts
import { Nip55Signer } from "@nostr-wot/signers";

const signer = new Nip55Signer({ bridge: myAndroidBridge });
```

NIP-55 requires a native bridge to dispatch `nostrsigner:` intents. The SDK ships the protocol layer; the host app provides transport (`Nip55Bridge`). Pure web pages can't use NIP-55 — fall back to NIP-07 / NIP-46.

## Private key (tests, CLIs, servers)

```ts
import { PrivateKeySigner } from "@nostr-wot/signers";

const signer = new PrivateKeySigner("hex-or-uint8array-32-bytes");
// or
const signer = PrivateKeySigner.generate();
```

Supports all four encryption operations (NIP-04 + NIP-44). Use only when the key is loaded into a process you control — never expose this signer to untrusted scripts in a browser.

## Adapting an NDK signer

If your app already uses NDK (`@nostr-dev-kit/ndk`), this package ships adapters in both directions so you can mix `@nostr-wot/*` packages with NDK call sites without rewriting your auth layer.

### NDK → NostrSigner (`ndkSignerAsNostrSigner`)

Wrap any `NDKSigner` to use it across `@nostr-wot/*` packages:

```ts
import { ndkSignerAsNostrSigner } from "@nostr-wot/signers";
import NDK, { NDKEvent, NDKNip07Signer } from "@nostr-dev-kit/ndk";

const ndk = new NDK({ explicitRelayUrls: ["wss://relay.damus.io"] });
ndk.signer = new NDKNip07Signer();
await ndk.connect();

const signer = ndkSignerAsNostrSigner({ ndk, NDKEvent });
// signer is a NostrSigner; pass it to any @nostr-wot/* package.
```

### NostrSigner → NDK (`nostrSignerAsNdkSigner`)

The reverse direction — useful when you migrate an NDK app's login UI to `@nostr-wot/ui`'s `<LoginModal>` but keep the rest of the app on NDK. The new modal hands you a `NostrSigner`; wrap it back to NDK and assign to your existing `ndk.signer`:

```ts
import { nostrSignerAsNdkSigner } from "@nostr-wot/signers";
import { NDKUser, type NDKSigner } from "@nostr-dev-kit/ndk";

const wrapped = await nostrSignerAsNdkSigner(nostrSigner, { NDKUser });
ndk.signer = wrapped as unknown as NDKSigner;
```

Both adapters are type-loose w.r.t. NDK so this package doesn't pull NDK as a dependency — you supply the `NDKEvent` / `NDKUser` constructors at call time when you want real NDK instances back. Compatible with NDK ≥ 2.10 for NIP-44 support.

## Composition

The `NostrSigner` interface is what every other SDK package consumes. To swap backends, just construct a different signer:

```ts
import { uploadToBlossom } from "@nostr-wot/blossom";
import { sealAndGiftWrap } from "@nostr-wot/dm";
import { requestZapInvoice } from "@nostr-wot/wallet";

const signer = new Nip07Signer();
// or
const signer = await Nip46Signer.fromBunkerUri(uri);

await uploadToBlossom(file, { signer });
await sealAndGiftWrap(signer, recipientPubkey, message);
await requestZapInvoice(signer, { recipientPubkey, amountMsats });
```

## License

MIT
