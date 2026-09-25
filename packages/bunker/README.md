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

**What a rejection looks like on the wire.** Only a `BunkerError`'s message is forwarded to the
client. Any other throw (a vault exception, a JSON parse error, anything with internal detail)
becomes `error: "request rejected"`. Throw `BunkerError` for text the caller should read, or
pass `mapError(err, request)` to set your own policy. A handler that has not settled after
`handlerTimeoutMs` (default 120 s, `0` disables) is answered with `request timed out`.

## Two keys, never conflated

- The **connection key** (`connectionSecretKey`) signs and encrypts every NIP-46 message and
  is what `bunker://` URIs advertise.
- The **user key** never enters this package. `get_public_key` reaches the handler like any
  other method, and the handler answers with it. That is how Amber and hosted bunkers work,
  and it is what the extension's compatibility audit found had been conflated once already.

## Usage

```ts
import { BunkerError, BunkerServer } from "@nostr-wot/bunker";
import { PrivateKeySigner } from "@nostr-wot/signers";

const user = new PrivateKeySigner(userSecretKey); // the identity; lives behind the handler

const server = new BunkerServer({
  connectionSecretKey, // a separate 32-byte key
  relays: ["wss://relay.nsec.app"],
  handler: async (req) => {
    switch (req.method) {
      case "connect":        return "ack";                 // approve the pairing (throw BunkerError to refuse)
      case "get_public_key": return user.getPublicKey();
      case "sign_event":     return JSON.stringify(await user.signEvent(JSON.parse(req.params[0])));
      case "nip44_encrypt":  return user.nip44Encrypt(req.params[0], req.params[1]);
      // ...
      default: throw new BunkerError(`unsupported method: ${req.method}`);
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
| `connect` | The pairing secret is verified first (`invalid secret`, `secret already used by another client`); only then does the handler see the request. The wire result is always `ack`. A secret is bound to the first client that presents it, synchronously, before the handler's approval is awaited, so two clients racing one secret get exactly one `ack`. The binding counts pending approvals: it is freed only when the bound client's last pending `connect` is rejected and none was ever confirmed. The bound client may reconnect with it indefinitely. |
| `nostrconnect://` | The secret is bound and the URI's relays registered before the handler runs, so a concurrent accept with the same secret is refused and an `auth_url` sent during approval reaches the client's own relays. The handler sees a synthetic `connect` carrying the URI's secret, perms and metadata. On approval the server subscribes on the URI's relays for that client alone and publishes the acknowledgement (`result` = the client's secret) there. |
| Unconnected clients | Any method other than `connect` and `ping` from a client that has not connected gets `error: "unauthorized: connect first"`. |
| `ping` / `switch_relays` | Answered without the handler: `pong` (for anyone, per the NIP), and the JSON list of the relays this client's responses go to, in the pool's normalized spelling (lower-case host, trailing slash, no default port) rather than the client's own. A client that compares by string, as nostr-tools does, may re-subscribe once on the same relay; harmless. |
| `logout` | Forwarded to the handler; after the ack the client is forgotten and relays only it used are unsubscribed. A request still in flight at that moment is dropped rather than answered, so no released relay is re-opened for a client that has left. |
| Deduplication | By request id and by event id, per client. Connected clients keep their own window; senders that have not connected share a bounded pool of windows, so junk from fresh keypairs cannot evict a real client's replay protection. A redelivered request is answered once. |
| Concurrency | Requests are dispatched independently; a slow `sign_event` never delays a later `get_public_key`. |
| Relay churn | One subscription per relay, opened on the relay connection itself (`ensureRelay`) rather than through `pool.subscribe`, because nostr-tools' pool records an event id as seen before it verifies the event, which lets a forged id suppress a genuine request; the reasoning is in a block comment at the call site and must not be "simplified" away. Connection management stays with the pool. A dropped relay is re-subscribed with backoff while the others keep serving. |
| Clock skew | Requests further than `maxClockSkewSec` (default 300) from now are dropped, as Amber does. |
| Logging | Optional injected logger; no `console`, and no key, plaintext or ciphertext ever reaches it. |

### Surviving a restart

A phone kills and restarts the process constantly, so pairings must not live only in memory.
Everything a host needs to persist is one `BunkerState`:

```ts
interface BunkerState {
  version: 2;
  connectionPubkey: string;
  generation: number; // monotonic, bumped by every revocation; inside the MAC
  secrets: { secret: string; origin: "bunker" | "nostrconnect"; relays: string[]; clientPubkey?: string; confirmed: boolean; expiresAt?: number }[];
  clients: { clientPubkey: string; relays: string[]; secret?: string; connectedAt: number }[];
  mac: string; // HMAC-SHA256 under a key derived from the connection secret key
}
```

`onStateChange(state)` hands out a fresh one after every change (mint, bind, confirm, release,
revoke, lapse, admit, forget; one snapshot per successful restore); `exportState()` returns one
on demand; `restore(state)` rehydrates it on the way back up under the same connection key,
before or after `start()`. A restored secret keeps its binding: a different client presenting
it is refused exactly as before the restart. Restored clients carry on without re-pairing, on
their own relays. Pending approvals are exported as bound but unconfirmed, so the same client
may retry and nobody else can.

**What the MAC buys.** The export is authenticated under the connection key, and `restore`
verifies it before reading anything else. A state that was edited, assembled by hand, or
signed by anyone who does not hold the connection key is refused with
`state authentication failed`. That is the case that matters on a phone: the state sits in
ordinary storage and the key sits in the keychain, and the weaker domain cannot forge a pairing
on its own. It is exactly as strong as the key's storage: whoever holds the connection secret
key can sign any state (`signBunkerState` is exported for migration tooling that does).

**Revocation survives a storage rollback.** Every `revokeSecret` bumps `generation`;
`onGenerationChange` hands the new value to the host, which keeps it beside the key in the
keychain, and passes it back as the `generation` option on startup. `restore` refuses a state
whose generation is behind the host's, so restoring an export taken before a revoke does not
bring the revoked client back. The generation is inside the MAC, so it cannot be edited upward.
A host that lost its counter (starts at 0) adopts the state's generation: as strong as the
keychain, no more.

**The rest of `restore`, in order.** `version` is read first, because it decides whether a MAC
is required: a version 2 state must be signed, and stripping its `mac` does not turn it into a
pre-2 state; versions above 2 are refused. Then the MAC is verified, before anything else is
read. A pre-2 state (no `version`) migrates once with `restore(state, { allowUnsigned: true })`;
persist the signed export afterwards and drop the flag, and gate the flag on something the
storage cannot change (a keychain marker), never on "the stored state has no mac". The state must
belong to this connection key and not be behind the host's generation; no approval may be pending (`pendingApprovals` says how many, `whenIdle()`
resolves when none is, so a host with `handlerTimeoutMs: 0` and an unanswered prompt knows when
to retry); the MAC must verify; then the whole object is validated (shapes and types, relay URLs
by the pairing rules, pubkeys on the curve, every client backed by a secret in the same state
bound to it and confirmed with the same relays, no duplicates, `confirmed` only with a
`clientPubkey`, within the ceilings). Only then is anything applied, all at once, with nothing
emitted until it has succeeded, so a host persisting on every callback never sees a partial
state. Where memory already holds a binding or a client, memory wins: a live handshake outranks
a stored record; a secret bound in memory to a different client refuses the whole restore.

### Secrets do not pile up

`revokeSecret(secret)` revokes a secret in the sense a user expects: `connect` with it is refused
from then on, an approval pending for it is discarded when the handler answers (the client gets
`secret revoked`, nothing is admitted), and the client bound to it is disconnected. Unclaimed
secrets lapse after `secretTtlMs` (default 15 minutes, `createBunkerUri({ ttlMs })` per mint,
`0` disables); the sweep is O(1) until the earliest expiry has passed and never runs on behalf
of an unauthenticated request, which checks its one secret instead. A confirmed binding never
expires, since paired clients reconnect with it indefinitely.

Ceilings, live and restored alike: `maxSecrets` (256; minting past it throws), `maxClients` (64;
admissions in flight count, per request, so a `connect` past it is refused with `too many
clients` even while another is pending, and a client whose first attempt was rejected keeps the
slot its retry holds), `maxRelaysPerClient` (8; a longer `nostrconnect://` URI or client record
is refused). On a scan, both ceilings are host-facing errors, not wire-visible ones.

### Relays are per client

Relay selection is a privacy control, not a delivery detail. A client's responses go to the
relays it was paired on: the `bunker://` URI's relays for a bunker-initiated pairing, the
client's own `nostrconnect://` relays for a client-initiated one. A relay one client introduced
is never used for another client's traffic, `switch_relays` answers with the asking client's own
set, and a client-introduced relay is dropped when that client leaves. `server.relays` is the
host-configured set, `server.listeningRelays` everything currently subscribed,
`server.relaysFor(pubkey)` one client's set. Relays are identified the way nostr-tools' pool
identifies them (`normalizeURL`: lower-case host, no trailing slash, no default port), so two
spellings of one relay are one relay everywhere. A pending pairing never writes to a secret's relays,
so a rejected scan leaves no trace on a host-minted secret, and `stop()` closes every socket the
server opened, publish-only ones included.

### Out of scope, deliberately

- NIP-04 transport. Every message is NIP-44, matching the extension's documented position.
- `create_account`, NIP-05 provider discovery (NIP-89), relay AUTH.
- Any notion of permissions, sessions or users. Put those in the handler.

## Connect timeout caveat

`connectTimeoutMs` (default 3000) bounds how long a relay may take to accept. In nostr-tools
2.24.1 a connect that times out leaves its socket open and unreachable: the relay's handlers
are nulled without a close, and the pool forgets the relay, so `stop()` cannot close it. Each
attempt against a slow relay, retries included, leaks one socket for the process lifetime.
Prefer relays that accept promptly, set the timeout generously on hosts that run for hours,
and see the package report for the upstream defect.

## Vendoring

Prefer `npm pack`: `prepack` rebuilds, so a tarball is never stale. The build writes
`dist/.src-hash` (tsup's `onSuccess`, so it cannot exist without a build): a hash of every build
input (`src/`, `tsup.config.ts`, `package.json`, the TypeScript config as tsc resolves it so the
monorepo's `tsconfig.base.json` counts, and the tsup/esbuild/typescript versions) and a hash of
every file the build produced. `npm run check:dist -w @nostr-wot/bunker` fails when `dist/` is
missing, behind any input, or no longer what the build produced (tampered or partially deleted);
`--dist DIR` checks a packed or vendored copy against this tree. CI runs it after the build,
proves it fails on a tampered and on a partial copy, and checks the packed tarball. There is
deliberately no vitest test for this: `dist/` is gitignored, so such a test would run against
nothing in CI.

## React Native

Pass `websocketImplementation` with the host's WebSocket constructor. It is installed through
nostr-tools' `useWebSocketImplementation`, the same way `@nostr-wot/graph` does it. Or inject
a ready `pool`.
