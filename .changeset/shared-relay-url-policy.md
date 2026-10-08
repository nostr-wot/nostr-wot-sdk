---
"@nostr-wot/relay": minor
"@nostr-wot/data": patch
---

Add a shared relay URL parser with explicit encrypted, local-development, compatible WebSocket, and public-host policies. Parsing rejects credentials while leaving canonicalization to callers. Route data's existing public relay filter through the shared implementation and reject bracketed IPv6 loopback/link-local, private ranges, local hostnames, and onion destinations consistently.

Expose RelayHub under `@nostr-wot/relay/hub`, including identity-isolated connections, authentication leases, subscription/query/publish coordination, bounded caches, test transport, and optional shared-instance ownership.
