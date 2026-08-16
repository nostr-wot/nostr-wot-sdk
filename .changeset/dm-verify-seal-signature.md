---
'@nostr-wot/dm': patch
---

Verify the seal's signature and cross-check rumor authorship in `unwrapGiftWrap`.

Previously the seal's `sig` was never checked, and the inner rumor's `pubkey` was returned to the caller without validation against the seal's signer. The NIP-44 conversation-key binding already made this safe in practice, but the returned `message.pubkey` was unvalidated and attacker-influenced: a sender could honestly seal with their own key while setting the rumor's author field to anyone, and any consumer reading `message.pubkey` — the natural author field on a Nostr event — would get a forged identity.

`unwrapGiftWrap` now verifies the seal's signature and rejects a rumor whose `pubkey` (when present) does not match the seal's signer, mirroring `@nostr-wot/pq`'s `openPqDirectMessage`. Both new checks fail the same way the function's existing decrypt failures do, so callers cannot use the error to distinguish which check failed. No wire format change.
