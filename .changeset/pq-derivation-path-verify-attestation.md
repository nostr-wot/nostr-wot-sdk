---
"@nostr-wot/pq": minor
---

`derivePqKeys`, `kemInfo` and `dsaInfo` take a canonical BIP-32 derivation path as well as a NIP-06 account index, with the extension's selector rule: a path in the NIP-06 sequence keeps the numeric selector, any other path derives under `path/<path>`. `verifyAttestation` checks an event's kind and secp256k1 signature before parsing its tags.
