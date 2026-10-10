---
"@nostr-wot/signer-core": minor
---

Validate destination authentication at the signing boundary, require explicit individual consent even for remote accounts, and revalidate policy, account, timestamp and revocation before releasing signatures. Add opt-in, host-configured legacy login compatibility with one-time warning metadata. Authentication approval adapters must now return authenticationScope: once; generic batch authentication is refused.
