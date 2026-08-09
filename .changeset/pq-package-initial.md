---
"@nostr-wot/pq": minor
---

Add `@nostr-wot/pq`: post-quantum identity keys for Nostr.

Derives ML-KEM-1024 and ML-DSA-87 keys from a NIP-06 seed as siblings of the secp256k1 key, and builds, parses and verifies the `kind:10203` attestation that advertises them.

New leaf package, so nothing existing changes and the `@noble/post-quantum` dependency stays out of every other package.
