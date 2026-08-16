---
'@nostr-wot/dm': minor
---

`sealAndGiftWrap` and `unwrapGiftWrap` gain an optional post-quantum mode, sealing with `@nostr-wot/pq`'s hybrid ML-KEM-1024 + NIP-44 envelope instead of plain NIP-44 ciphertext when the caller opts in. Nothing outside the seal changes — a relay or a client that hasn't implemented this still sees an ordinary kind-1059 gift wrap.

`unwrapGiftWrap` auto-detects which kind of seal it received (the envelope is self-describing), so a single conversation can freely mix classic and post-quantum messages with no caller flag. `sendDM` gains a matching `pq` option on `SendDMOptions`, threaded straight through.

A post-quantum message sealed by `@nostr-wot/dm` is byte-compatible with `@nostr-wot/pq`'s `openPqDirectMessage`, and vice versa — the two packages produce and consume the identical wire format. `@nostr-wot/dm` now depends on `@nostr-wot/pq` for the envelope rather than reimplementing it.
