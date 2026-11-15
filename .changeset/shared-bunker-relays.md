---
"@nostr-wot/identity": minor
---

Share NIP-46 relay connections and reconnect backoff across server identities with BunkerRelayManager, including a global relay limit and ownership-aware socket cleanup. Add monotonic advanceGeneration synchronization without disconnecting unrelated paired clients.
