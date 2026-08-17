---
'@nostr-wot/dm': patch
---

Verify the rumor's `id` against its own content in `unwrapGiftWrap`, and require the rumor's `pubkey` rather than only checking it when present.

The rumor is unsigned, so both fields were only claims. The signature cross-check added recently covers `pubkey` when it's there, but `id` was never checked at all — a sealer could write any 64-char hex string and it would come back to the caller unexamined. Consumers dedupe on `id` (Obelisk keys its DM store and its optimistic-send reconciliation on it), so it needs to mean what it says.

`unwrapGiftWrap` now recomputes the hash over the rumor's canonical unsigned-event fields and rejects a mismatch the same way the function's existing decrypt failures fail, so the error can't be used to tell which check tripped. A rumor that omits `id` entirely — `@nostr-wot/pq`'s deprecated `createPqDirectMessage` never sets one — isn't treated as a forgery attempt; there's nothing to forge when the hash is computed from fields already authenticated by the seal, so it's filled in instead of rejected.

Also closes a gap in the authorship check: it used to skip validation when `pubkey` was absent rather than merely mismatched, so a rumor with no author claim at all slipped through unauthenticated. `pubkey` is now required.

No wire format change.
