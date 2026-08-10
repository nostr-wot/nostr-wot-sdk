---
"@nostr-wot/pq": minor
---

Add post-quantum direct messages: `createPqDirectMessage` / `openPqDirectMessage`.

Composes the envelope with NIP-17 and NIP-59 unchanged — the post-quantum payload is the content of a kind:14 rumor, sealed in a kind:13 and gift-wrapped in a kind:1059 with an ephemeral key. To a relay, and to any client that has not implemented this, it is an ordinary gift wrap.

Authenticates the sealed author against the seal's signature, so a forged rumor claiming someone else's authorship is rejected rather than displayed as genuine.
