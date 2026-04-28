# @nostr-wot/wallet

Two complementary helpers for Nostr-aware wallets:

| Module | Standard | Use case |
|---|---|---|
| `NwcClient` | NIP-47 Nostr Wallet Connect | Pay invoices, get balance, etc. via a remote wallet daemon over Nostr |
| `buildZapRequest` / `requestZapInvoice` | NIP-57 zaps | Build LNURL+zap-request flow for tipping notes / profiles |

## Install

```bash
npm i @nostr-wot/wallet @nostr-wot/signers nostr-tools
```

## NWC

```ts
import { NwcClient } from "@nostr-wot/wallet";

const client = NwcClient.fromUri("nostr+walletconnect://abc?relay=wss://...&secret=...");
const { invoice, payment_hash } = await client.makeInvoice(1000, "test");
const { balance } = await client.getBalance();
const { preimage } = await client.payInvoice(invoice);
```

## Zaps (NIP-57)

```ts
import { requestZapInvoice } from "@nostr-wot/wallet";
import { Nip07Signer } from "@nostr-wot/signers";

const signer = new Nip07Signer();
const { invoice, zapRequest } = await requestZapInvoice(signer, {
  recipientPubkey: "hex…",
  amountMsats: 21_000,           // 21 sats
  comment: "great post",
  relays: ["wss://relay.damus.io"],
  lud16: "alice@getalby.com",
});
// pay invoice via NWC, WebLN, or any wallet
```

For lower-level access, `buildZapRequest` returns just the signed kind-9734 event + URL-encoded form ready to append to an LNURL-pay callback yourself.

## License

MIT
