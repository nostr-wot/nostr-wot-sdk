# @nostr-wot/wallet

Two complementary helpers for Nostr-aware wallets:

| Module | Standard | Use case |
|---|---|---|
| `NwcClient` | NIP-47 Nostr Wallet Connect | Pay invoices, get balance, list transactions via a remote wallet daemon over Nostr |
| `buildZapRequest` / `requestZapInvoice` | NIP-57 zaps | Build LNURL+zap-request flow for tipping notes / profiles |

## Install

```bash
npm i @nostr-wot/wallet @nostr-wot/signers nostr-tools
```

## NIP-47 — Nostr Wallet Connect

Connect to a remote wallet (Alby Hub, Mutiny, Cashu.me, custom NWC server) and drive it from your app.

```ts
import { NwcClient } from "@nostr-wot/wallet";

const client = NwcClient.fromUri(
  "nostr+walletconnect://abc?relay=wss://...&secret=...",
);

// Make an invoice
const { invoice, payment_hash } = await client.makeInvoice({
  amount: 1000_000,        // msats
  description: "test",
});

// Pay an invoice
const { preimage } = await client.payInvoice({ invoice });

// Get balance
const { balance } = await client.getBalance();

// List transactions
const txs = await client.listTransactions({ limit: 50 });

await client.close();
```

`NwcClient` opens a single subscription to the wallet's relay, multiplexes requests over it, and resolves each response by `e`-tag matching the request id. Always call `close()` on teardown.

### Lower-level

```ts
const client = new NwcClient({
  walletPubkey: "hex...",
  relays: ["wss://..."],
  secretKey: new Uint8Array(32),
});

const result = await client.request({
  method: "lookup_invoice",
  params: { payment_hash: "abc..." },
});
```

## NIP-57 — Zaps

The full zap flow: discover the recipient's LNURL endpoint from their profile, build a kind-9734 zap request, hit the LNURL callback, get back a BOLT11 invoice ready to pay.

```ts
import { requestZapInvoice } from "@nostr-wot/wallet";
import { Nip07Signer } from "@nostr-wot/signers";

const signer = new Nip07Signer();
const { invoice, zapRequest } = await requestZapInvoice(signer, {
  recipientPubkey: "hex...",
  amountMsats: 21_000,             // 21 sats
  comment: "great post",
  relays: ["wss://relay.damus.io"],
  lud16: "alice@getalby.com",      // optional; auto-discovered if omitted
  zappedEventId: "abc...",         // for note zaps; omit for profile zaps
});

// Pay the invoice via NWC, WebLN, or any wallet
await nwcClient.payInvoice({ invoice });
```

The zap receipt (kind-9735) lands on the recipient's relays once the LNURL service publishes it; consumers can subscribe to `kinds: [9735], #e: [eventId]` to count zaps. The `parseZapMsats` helper in `@nostr-wot/data` decodes the receipt's bolt11 amount.

### Lower-level

```ts
import { buildZapRequest } from "@nostr-wot/wallet";

const { event, encoded } = await buildZapRequest(signer, {
  recipientPubkey,
  amountMsats: 21_000,
  comment: "...",
  relays,
  zappedEventId,
});

// Append `?nostr=${encoded}&amount=${amountMsats}&comment=...` to the
// recipient's LNURL-pay callback yourself, parse the invoice from
// the JSON response.
```

## License

MIT

## Caller-owned NWC transport

Import `NwcClient`, `parseNwcUri`, and `NwcTransport` from `@nostr-wot/wallet/nwc` when an application already owns its relay connections. The client accepts a parsed connection and a transport with `subscribe`, `publish`, and `query` methods. It does not create sockets. The optional `createPoolNwcTransport` adapts an existing `nostr-tools` pool.

The protocol client reads the wallet's info event, negotiates NIP-44 when advertised (otherwise NIP-04), waits for the answer subscription to become ready, and adds request expiration. URI parsing accepts WSS relays and WS only for localhost or loopback development endpoints, rejects embedded credentials, validates the client secret, and retains up to three distinct relays.

`NwcError.outcome` is `not-paid` only when no relay could have received the request or the wallet explicitly rejected it. `unknown` means a payment may have completed: do not automatically submit a second payment. The transport's `publish` must return `false` only when it can make that no-delivery guarantee; an ambiguous failure must remain unknown. Timeouts, malformed replies, and transport exceptions after sending are unknown outcomes.

The root-entry `NwcClient` retains its pool-based constructor, method names, and result shapes while delegating to this same implementation. It now uses strict URI checks and wallet info negotiation; callers must use a NIP-47 wallet that publishes its info event.
