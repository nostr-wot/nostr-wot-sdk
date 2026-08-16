---
'@nostr-wot/pq': patch
---

Mark `createPqDirectMessage` and `openPqDirectMessage` as `@deprecated`. No behavior change — both functions keep working exactly as before, and their wire format stays pinned by the cross-implementation vector test against the Rust port in the Dart NDK.

They predate the signer-layer post-quantum support added in `@nostr-wot/signers` and duplicate NIP-17 gift-wrap logic that now lives in `@nostr-wot/dm`. Using them means composing two packages by hand and passing a raw secret key to a function outside the signer that's supposed to own it. Prefer `@nostr-wot/dm`'s `sealAndGiftWrap` / `unwrapGiftWrap` with the signer's `{ scheme: 'pq', recipientKemKey }` option instead: transport belongs in `@nostr-wot/dm`, key material belongs in `@nostr-wot/signers`, and `@nostr-wot/pq` stays what it was always meant to be — pure primitives, no transport, no keys.
