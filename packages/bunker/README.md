# @nostr-wot/bunker

The NIP-46 **responder**: the bunker / remote-signer side of Nostr Connect. `@nostr-wot/signers`
and the browser extension are NIP-46 clients; this is the other half, the thing they talk to.

It is a transport adapter and nothing more. It listens on relays for kind 24133 requests
addressed to a connection key, decrypts the NIP-44 payload, hands the request to one injected
function, and publishes the encrypted response. Vaults, permissions, accounts and approval UI
never enter this package: every policy decision is the handler's.

## Install

```bash
npm i @nostr-wot/bunker nostr-tools
```

## The contract

```ts
interface BunkerRequest {
  id: string;           // NIP-46 request id; the response carries it back
  clientPubkey: string; // the remote client's key, never the user's
  method: string;       // 'connect' | 'get_public_key' | 'sign_event' | 'nip04_encrypt' | ...
  params: string[];     // NIP-46 params, raw
}

/** Resolve with the NIP-46 `result` string, or reject: a rejection becomes an `error` response. */
type BunkerHandler = (request: BunkerRequest, context: BunkerRequestContext) => Promise<string>;
```

The second argument is optional. `context.sendAuthUrl(url)` sends an interim `auth_url`
response on the same request id; the promise you return still delivers the real result.

## Two keys, never conflated

- The **connection key** (`connectionSecretKey`) signs and encrypts every NIP-46 message and
  is what `bunker://` URIs advertise.
- The **user key** never enters this package. `get_public_key` reaches the handler like any
  other method, and the handler answers with it. That is how Amber and hosted bunkers work,
  and it is what the extension's compatibility audit found had been conflated once already.

## Usage

```ts
import { BunkerServer } from "@nostr-wot/bunker";
import { PrivateKeySigner } from "@nostr-wot/signers";

const user = new PrivateKeySigner(userSecretKey); // the identity; lives behind the handler

const server = new BunkerServer({
  connectionSecretKey, // a separate 32-byte key
  relays: ["wss://relay.nsec.app"],
  handler: async (req) => {
    switch (req.method) {
      case "connect":        return "ack";                 // approve the pairing
      case "get_public_key": return user.getPublicKey();
      case "sign_event":     return JSON.stringify(await user.signEvent(JSON.parse(req.params[0])));
      case "nip44_encrypt":  return user.nip44Encrypt(req.params[0], req.params[1]);
      // ...
      default: throw new Error(`unsupported method: ${req.method}`);
    }
  },
});
await server.start();

// Bunker-initiated pairing: hand this to the client (paste or QR).
const { uri } = server.createBunkerUri();

// Client-initiated pairing: the client shows a nostrconnect:// QR, the user scans it here.
await server.acceptNostrConnect(scannedUri);
```

### What the transport handles itself

| Behaviour | Detail |
|---|---|
| `connect` | The pairing secret is verified first (`invalid secret`, `secret already used by another client`); only then does the handler see the request. The wire result is always `ack`. A secret is bound to the first client that uses it, and that same client may reconnect with it indefinitely. |
| `nostrconnect://` | The handler sees a synthetic `connect` carrying the URI's secret, perms and metadata. On approval the URI's relays join the listening set and the acknowledgement (`result` = the client's secret) is published where the client listens. |
| Unconnected clients | Any other method from a client that has not connected gets `error: "unauthorized: connect first"`. |
| `ping` / `switch_relays` | Answered without the handler: `pong`, and the JSON list of relays the server is actually listening on. |
| `logout` | Forwarded to the handler; on success the client is forgotten. |
| Deduplication | By `clientPubkey + request id` and by event id, bounded. A redelivered request is answered once. |
| Concurrency | Requests are dispatched independently; a slow `sign_event` never delays a later `get_public_key`. |
| Relay churn | One subscription per relay. A dropped relay is re-subscribed with backoff while the others keep serving. Responses go to every configured relay. |
| Clock skew | Requests further than `maxClockSkewSec` (default 300) from now are dropped, as Amber does. |
| Logging | Optional injected logger; no `console`, and no key, plaintext or ciphertext ever reaches it. |

### Out of scope, deliberately

- NIP-04 transport. Every message is NIP-44, matching the extension's documented position.
- `create_account`, NIP-05 provider discovery (NIP-89), relay AUTH.
- Any notion of permissions, sessions or users. Put those in the handler.

## React Native

Pass `websocketImplementation` with the host's WebSocket constructor. It is installed through
nostr-tools' `useWebSocketImplementation`, the same way `@nostr-wot/graph` does it. Or inject
a ready `pool`.
