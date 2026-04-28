# @nostr-wot/signers

Signer abstractions for Nostr — one interface (`NostrSigner`), four backends:

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

## Use

```ts
import { Nip07Signer, Nip46Signer, PrivateKeySigner, type NostrSigner } from "@nostr-wot/signers";

// Browser extension
const signer: NostrSigner = new Nip07Signer();

// Bunker (NIP-46)
const signer = await Nip46Signer.fromBunkerUri("bunker://abc...?relay=wss://relay.x&secret=xxx");

// Private key (tests, CLIs)
const signer = new PrivateKeySigner("hex-or-uint8array-32-bytes");
```

Every signer implements:

```ts
interface NostrSigner {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<Event>;
  nip04Encrypt?(pk: string, plain: string): Promise<string>;
  nip04Decrypt?(pk: string, ct: string): Promise<string>;
  nip44Encrypt?(pk: string, plain: string): Promise<string>;
  nip44Decrypt?(pk: string, ct: string): Promise<string>;
  close?(): Promise<void> | void;
}
```

Encryption methods are optional — not every signer supports both NIP-04 and NIP-44. Check `typeof signer.nip44Encrypt === "function"` before calling.

## NIP-46 specifics

`Nip46Signer.fromBunkerUri` accepts the standard `bunker://` URI from your remote signer (Amber's QR pairing, Nsec.app's connection screen, etc.). It auto-generates an ephemeral client key; export and persist it via `signer.exportClientNsec()` so future sessions reuse the same client identity (the bunker remembers paired clients).

```ts
const signer = await Nip46Signer.fromBunkerUri(uri);
localStorage.setItem("bunker-client-nsec", signer.exportClientNsec());

// Later:
const savedNsec = localStorage.getItem("bunker-client-nsec");
const signer = await Nip46Signer.fromBunkerUri(uri, {
  clientSecretKey: nip19.decode(savedNsec).data as Uint8Array,
});
```

## NIP-55 specifics

NIP-55 requires a native bridge to dispatch `nostrsigner:` intents. The SDK ships a thin wrapper but expects the host app to provide the transport (`Nip55Bridge`). Pure web pages can't use NIP-55 — fall back to NIP-07 / NIP-46.

## License

MIT
