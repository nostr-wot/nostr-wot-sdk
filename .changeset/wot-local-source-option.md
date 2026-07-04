---
"@nostr-wot/wot": minor
---

Add an optional local query `source` to the `WoT` class. When a `WoTLocalSource` is provided (e.g. from `@nostr-wot/graph`'s `WotGraph.asWoTSource()`), `getDistance`, `isInMyWoT`, and `filterByWoT` resolve from it instead of the Oracle. Additive and non-breaking — all other methods still use the Oracle, and omitting `source` keeps the previous behavior. Exports a new `WoTLocalSource` type.
