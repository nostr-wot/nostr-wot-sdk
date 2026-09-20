// Run after building: npm run benchmark -w @nostr-wot/graph
import { GraphStorage, LocalGraph, GraphCrawler, encodeFollows, encodeCompactFollows } from '../dist/index.js';
import { performance } from 'node:perf_hooks';
const storage = new GraphStorage('benchmark-memory');
await storage.open();
const count = 20_000, degree = 20;
let started = performance.now();
for (let i = 0; i < count; i++) storage.saveFollows(`n${i}`, Array.from({ length: degree }, (_, j) => `n${(i + j + 1) % count}`));
const constructionMs = performance.now() - started;
const graph = new LocalGraph(storage);
started = performance.now();
graph.getDistance('n0', `n${count - 1}`, count);
const coldTraversalMs = performance.now() - started;
started = performance.now();
for (let i = 0; i < 100_000; i++) graph.getDistance('n0', `n${i % count}`, count);
const warm100kQueriesMs = performance.now() - started;
// Dense IDs have delta 1: the persisted delta-varint format uses one byte/edge.
// The regression suite verifies actual encoder output and the legacy migration.
const denseIds = Array.from({ length: 1000 }, (_, i) => i + 1);
let requests = 0;
const crawlStorage = new GraphStorage('crawl-benchmark-memory');
await crawlStorage.open();
const authors = Array.from({ length: 250 }, (_, i) => `author${i}`);
const crawler = new GraphCrawler({ storage: crawlStorage, relays: ['wss://fixture'], baseDelayMs: 0,
  pool: { subscribe(filter, handlers) {
    requests++;
    queueMicrotask(() => {
      for (const pubkey of filter.authors) handlers.onEvent({ pubkey, kind: 3, id: 'a', created_at: 1,
        tags: (pubkey === 'root' ? authors : []).map(key => ['p', key]) });
      handlers.onEose();
    });
    return { close() {} };
  } }
});
const crawled = await crawler.crawl('root', { maxHops: 2 });
console.log(JSON.stringify({ nodes: count, edges: storage.stats().edges, constructionMs, coldTraversalMs, warm100kQueriesMs,
  dense1000Edges: { legacyBytes: encodeFollows(denseIds).byteLength, deltaVarintBytes: encodeCompactFollows(denseIds).byteLength },
  crawl251Authors: { priorRequests: crawled.fetched, batchedRequests: requests } }, null, 2));
