import { describe, it, expect } from 'vitest';
import { WotGraph } from '../src/wot-graph';
import { makeMockPool, makeEvent } from './mock-pool';

let ns = 0;
const nextNs = () => `wot-graph-test-${ns++}`;

// Diamond: root -> a, b ; a -> c ; b -> c
function diamondPool() {
  return makeMockPool({
    root: [makeEvent(1, ['a', 'b'])],
    a: [makeEvent(1, ['c'])],
    b: [makeEvent(1, ['c'])],
    c: [makeEvent(1, [])],
  });
}

function makeGraph(pool = diamondPool()) {
  return new WotGraph({ namespace: nextNs(), relays: ['wss://mock'], pool });
}

describe('WotGraph facade', () => {
  it('load -> crawl -> query', async () => {
    const wg = makeGraph();
    await wg.load();
    const result = await wg.crawl('root', { maxDepth: 2 });

    expect(result.fetched).toBeGreaterThan(0);
    expect(wg.getDistance('root')).toEqual({ hops: 0, paths: 1 });
    expect(wg.getDistance('a')).toEqual({ hops: 1, paths: 1 });
    expect(wg.getDistance('c')).toEqual({ hops: 2, paths: 2 });
    expect(wg.getDistance('nobody')).toBeNull();

    expect(wg.getScore('root')).toBe(1);
    expect(wg.getScore('a')).toBe(1); // 1 hop
    expect(wg.getScore('nobody')).toBe(0);

    expect(wg.isInWoT('a', 1)).toBe(true);
    expect(wg.isInWoT('c', 1)).toBe(false);
    expect(wg.isInWoT('c', 2)).toBe(true);

    expect(new Set(wg.getFollows('root'))).toEqual(new Set(['a', 'b']));
  });

  it('reports stats', async () => {
    const wg = makeGraph();
    await wg.load();
    await wg.crawl('root', { maxDepth: 2 });
    const stats = wg.stats();
    expect(stats.root).toBe('root');
    expect(stats.maxDepth).toBe(2);
    expect(stats.nodes).toBeGreaterThan(0);
    expect(typeof stats.lastCrawl).toBe('number');
  });

  it('tracks staleness', async () => {
    const wg = makeGraph();
    await wg.load();
    expect(wg.isStale(1000)).toBe(true); // never crawled
    await wg.crawl('root', { maxDepth: 2 });
    expect(wg.isStale(60_000)).toBe(false); // just crawled
    expect(wg.isStale(-1)).toBe(true); // any positive age exceeds a negative ttl
  });

  it('filterByWoT returns the trusted subset sorted by score desc', async () => {
    const wg = makeGraph();
    await wg.load();
    await wg.crawl('root', { maxDepth: 2 });

    const filtered = wg.filterByWoT(['c', 'a', 'root', 'nobody'], { maxHops: 2 });
    // 'nobody' is dropped; 'c' (2 hops, score .65) sorts last
    expect(filtered).not.toContain('nobody');
    expect(filtered[filtered.length - 1]).toBe('c');
    expect(new Set(filtered.slice(0, 2))).toEqual(new Set(['root', 'a']));
  });

  it('exposes an asWoTSource() adapter of the right shape', async () => {
    const wg = makeGraph();
    await wg.load();
    await wg.crawl('root', { maxDepth: 2 });

    const src = wg.asWoTSource();
    expect(typeof src.getDistance).toBe('function');
    expect(typeof src.isInMyWoT).toBe('function');
    expect(typeof src.filterByWoT).toBe('function');

    expect(src.getDistance('a')).toBe(1); // hops
    expect(src.getDistance('nobody')).toBeNull();
    expect(src.isInMyWoT('a', 1)).toBe(true);
    expect(src.isInMyWoT('c', 1)).toBe(false);
    expect(src.filterByWoT(['a', 'c'], { maxHops: 2 })).toContain('a');
  });

  it('single-flights concurrent crawls', async () => {
    const pool = diamondPool();
    const wg = new WotGraph({ namespace: nextNs(), relays: ['wss://mock'], pool });
    await wg.load();
    const p1 = wg.crawl('root', { maxDepth: 2 });
    const p2 = wg.crawl('root', { maxDepth: 2 });
    expect(p1).toBe(p2); // same in-flight promise
    await p1;
  });
});
