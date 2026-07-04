---
"@nostr-wot/graph": minor
---

New package: a standalone, local Web-of-Trust follow graph for the browser.

- Crawl kind:3 contact lists over relays (`GraphCrawler`, re-based on `@nostr-wot/relay`'s pool), persist them to IndexedDB with pubkey interning + delta-encoded follow arrays (`GraphStorage`, namespaced per app), and compute social distance / shortest-path counts with a cached typed-array BFS (`LocalGraph`).
- `WotGraph` facade: `load`, `crawl`, `getDistance`, `getScore`, `isInWoT`, `filterByWoT`, `getFollows`, `stats`, `isStale`, `clear`, `stop`, and `asWoTSource()` (adapter for `@nostr-wot/wot`).
- Optional `./react` entrypoint: `WotGraphProvider`, `useWotGraph`, `useDistance`, `useCrawl`.
- Pure `calculateScore` + `DEFAULT_SCORING`. In-memory fallback when IndexedDB is unavailable (Node).

Ported from the browser extension's proven engine (BFS, scoring, delta-encoded storage), with the raw-WebSocket transport rewritten onto `RelayPool`.
