---
'@nostr-wot/signers': minor
---

Rebuild `Nip46Signer` as a thin adapter over `nostr-tools/nip46`'s `BunkerSigner`.

The signer previously hand-rolled the NIP-46 handshake: its own kind-24133 subscription, its own request/response correlation, and its own pending-promise map. That is a lot of protocol surface to own privately, and it only interoperates as well as our own reading of the spec.

Delegating to `nostr-tools/nip46` gets the handshake that Amber, Nsec.app and Keychat already interoperate with, and halves the code (448 lines to 238).

The public API does not change. `fromBunkerUri`, `startNostrConnect`, `onAuthChallenge`, `exportClientNsec`, `perms`, the `secret` flow, and every `NostrSigner` method keep their existing signatures and semantics; the generated type declarations are byte-identical to 1.0.0.

Originally written by @Fabricio333 in a fork, where it had been running against Obelisk. It never landed upstream because the fork had read-only access to this repo, so it lived on as a vendored `dist` copy in the consuming app. This brings it home and lets that app drop the vendoring.
