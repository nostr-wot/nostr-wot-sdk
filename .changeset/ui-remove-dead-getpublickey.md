---
"@nostr-wot/ui": patch
---

Internal cleanup (no public API change): remove the dead `getPublicKey` import and its unused-warning suppression in the NIP-46 login method (real calls use `signer.getPublicKey()`).
