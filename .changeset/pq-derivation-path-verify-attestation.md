---
"@nostr-wot/pq": minor
---

`derivePqKeys`, `kemInfo` and `dsaInfo` take a canonical BIP-32 derivation path as well as a NIP-06 account index, with the extension's selector rule: a path in the NIP-06 sequence keeps the numeric selector, any other path derives under `path/<path>`. `verifyAttestation` checks an event's kind and secp256k1 signature before parsing its tags.

`classifyEnvelope(payload)` answers `'pq' | 'pq-unreadable' | 'classic'` where `isPqEnvelope` answers a boolean, so a caller can tell somebody else's ciphertext from one of ours that is truncated, names an algorithm byte we do not implement, or cannot be base64-decoded on this host. It reads the version and algorithm bytes from the first four base64 characters itself, without `atob` or `Buffer`, so a host missing both is told "post-quantum, unreadable" rather than "classic".
