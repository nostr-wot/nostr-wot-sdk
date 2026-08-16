---
'@nostr-wot/dm': minor
---

`sealAndGiftWrap` gains an optional `pq` option (`{ scheme: 'pq'; recipientKemKey: string }`), which it passes straight through to the signer's `nip44Encrypt` to seal with `@nostr-wot/pq`'s hybrid ML-KEM-1024 + NIP-44 envelope instead of plain NIP-44 ciphertext. Nothing outside the seal changes — a relay or a client that hasn't implemented this still sees an ordinary kind-1059 gift wrap. `sendDM` gains a matching `pq` option on `SendDMOptions`, threaded straight through.

`unwrapGiftWrap` needs no new option at all: `signer.nip44Decrypt` auto-routes on its own, since the post-quantum envelope is self-describing. A single conversation can freely mix classic and post-quantum messages, and existing callers of `unwrapGiftWrap` (`cache/inbox.ts`, `cache/backfill.ts`) get post-quantum support with no changes on their part, as long as the signer supports it (requires `@nostr-wot/signers` >=1.2.0).

This package does not depend on `@nostr-wot/pq` and never touches post-quantum key material — the signer owns that, by design, since it's the layer that already owns key material for every other scheme. A post-quantum message sealed by `@nostr-wot/dm` is byte-compatible with `@nostr-wot/pq`'s `openPqDirectMessage`, and vice versa, verified by cross-package round-trip tests.
