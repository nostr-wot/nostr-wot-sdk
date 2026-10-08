---
"@nostr-wot/wallet": minor
---

Expose a transport-injected NIP-47 client at `@nostr-wot/wallet/nwc`, with strict connection parsing, multi-relay support, NIP-44/NIP-04 negotiation, request expiration, and machine-readable payment outcomes. The existing root client delegates to the same protocol implementation while retaining its public method and result shapes.
