# @nostr-wot/dm

Direct messages for Nostr — three encryption layers, one API:

| Function | Standard | Privacy |
|---|---|---|
| `encryptNip04` / `decryptNip04` | NIP-04 (kind 4) | Sender + recipient visible on the wire |
| `sealAndGiftWrap` / `unwrapGiftWrap` | NIP-17 (kind 14 → 13 → 1059) | Sender hidden, recipient visible only via `p` tag on the wrap |

NIP-04 is the legacy AES-CBC scheme — still widely deployed. NIP-17 is the modern sealed-message standard built on NIP-44 v2 + gift wrapping; use it for anything new.

## Install

```bash
npm i @nostr-wot/dm @nostr-wot/signers nostr-tools
```

## NIP-17 sealed messages

```ts
import { buildChatMessage, sealAndGiftWrap, unwrapGiftWrap } from "@nostr-wot/dm";
import { Nip07Signer } from "@nostr-wot/signers";

const signer = new Nip07Signer();
const me = await signer.getPublicKey();

// Send
const inner = buildChatMessage(me, recipientPubkey, "hello");
const giftWrap = await sealAndGiftWrap(signer, recipientPubkey, inner);
// publish giftWrap (kind 1059) to recipient's read relays

// Receive
const { message, senderPubkey } = await unwrapGiftWrap(signer, giftWrap);
// message.content is the plaintext, senderPubkey is who sent it
```

The library automatically randomizes seal + wrap timestamps within ±2 days of `now` so traffic-analysis can't correlate.

## NIP-04 (legacy)

```ts
import { encryptNip04, decryptNip04 } from "@nostr-wot/dm";

const event = await encryptNip04(signer, recipientPubkey, "hello");
// publish event (kind 4)

// Receive
const plaintext = await decryptNip04(signer, event);
```

## License

MIT
