---
"@nostr-wot/graph": minor
---

Batch author crawling and add explicit hop bounds, revision-aware numeric queries,
deterministic persisted list versions, and compact schema-2 delta-varint graph rows.
Preserve inclusive maxDepth and legacy row reads. Flush failures retain pending
writes; stopped crawls remain stale. Upgraded namespaces require schema-2-aware
SDKs; old SDKs cannot reopen them. Add regression tests and a synthetic benchmark.
