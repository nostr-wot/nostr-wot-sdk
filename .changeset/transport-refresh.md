---
"@nostr-wot/signers": patch
---

Dispose internally owned NIP-46 relay pools after failed or cancelled pairing and signer teardown, including sockets still connecting. Preserve caller-owned pools and close late pairing results without reviving a disposed transport.
