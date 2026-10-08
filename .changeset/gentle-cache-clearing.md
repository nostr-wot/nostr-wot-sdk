---
"@nostr-wot/data": minor
---

Add `clear()` to keyed observables for runtime cache invalidation. It removes cached slots and notifies their per-key and global subscribers while preserving subscriptions, so mounted consumers continue receiving new values. The existing `_reset()` remains a silent test teardown that removes subscriptions.
