import { describe, it, expect } from 'vitest';
import { GraphCrawler, CrawlError } from '../src/crawl';
import { GraphStorage } from '../src/storage';
import { makeMockPool, makeEvent } from './mock-pool';
import type { CrawlProgress } from '../src/types';

let ns = 0;
async function freshStorage() {
  const s = new GraphStorage(`crawl-test-${ns++}`);
  await s.open();
  return s;
}

const relays = ['wss://mock'];

describe('GraphCrawler', () => {
  it('BFS respects maxDepth', async () => {
    const data = {
      root: [makeEvent(1, ['a', 'b'])],
      a: [makeEvent(1, ['c'])],
      b: [makeEvent(1, ['d'])],
      c: [makeEvent(1, ['e'])],
      d: [makeEvent(1, [])],
    };
    const pool = makeMockPool(data);
    const storage = await freshStorage();
    const crawler = new GraphCrawler({ pool, storage, relays, baseDelayMs: 0 });

    const result = await crawler.crawl('root', { maxDepth: 1 });

    // depth 0: root, depth 1: a, b — c/d/e not fetched at maxDepth 1
    expect(result.fetched).toBe(3);
    expect(new Set(pool.calls)).toEqual(new Set(['root', 'a', 'b']));
    expect(new Set(storage.getFollows('root'))).toEqual(new Set(['a', 'b']));
    expect(storage.getFollows('a')).toEqual(['c']);
    expect(result.stoppedEarly).toBe(false);
    expect(result.depth).toBe(1);
  });

  it('fetches deeper levels when maxDepth is higher', async () => {
    const data = {
      root: [makeEvent(1, ['a', 'b'])],
      a: [makeEvent(1, ['c'])],
      b: [makeEvent(1, ['d'])],
      c: [makeEvent(1, ['e'])],
      d: [makeEvent(1, [])],
    };
    const pool = makeMockPool(data);
    const storage = await freshStorage();
    const crawler = new GraphCrawler({ pool, storage, relays, baseDelayMs: 0 });

    const result = await crawler.crawl('root', { maxDepth: 2 });
    // root, a, b, c, d — e is one hop too far
    expect(new Set(pool.calls)).toEqual(new Set(['root', 'a', 'b', 'c', 'd']));
    expect(result.fetched).toBe(5);
    expect(result.depth).toBe(2);
  });

  it('selects the newest event per author', async () => {
    const data = {
      root: [makeEvent(10, ['a'])],
      a: [makeEvent(100, ['x']), makeEvent(200, ['y', 'z']), makeEvent(50, ['old'])],
    };
    const pool = makeMockPool(data);
    const storage = await freshStorage();
    const crawler = new GraphCrawler({ pool, storage, relays, baseDelayMs: 0 });

    await crawler.crawl('root', { maxDepth: 1 });
    // newest (created_at 200) wins
    expect(new Set(storage.getFollows('a'))).toEqual(new Set(['y', 'z']));
  });

  it('emits progress callbacks', async () => {
    const data = {
      root: [makeEvent(1, ['a', 'b'])],
      a: [makeEvent(1, [])],
      b: [makeEvent(1, [])],
    };
    const pool = makeMockPool(data);
    const storage = await freshStorage();
    const crawler = new GraphCrawler({ pool, storage, relays, baseDelayMs: 0 });

    const progress: CrawlProgress[] = [];
    await crawler.crawl('root', { maxDepth: 2, onProgress: (p) => progress.push(p) });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => typeof p.depth === 'number')).toBe(true);
    expect(progress.some((p) => p.fetched > 0)).toBe(true);
  });

  it('aborts mid-crawl and leaves partial data usable', async () => {
    const data: Record<string, ReturnType<typeof makeEvent>[]> = {
      root: [makeEvent(1, ['a', 'b'])],
      a: [makeEvent(1, ['deep1'])],
      b: [makeEvent(1, ['deep2'])],
    };
    const pool = makeMockPool(data);
    const storage = await freshStorage();
    const crawler = new GraphCrawler({ pool, storage, relays, baseDelayMs: 0 });

    const controller = new AbortController();
    const result = await crawler.crawl('root', {
      maxDepth: 5,
      signal: controller.signal,
      onProgress: () => controller.abort(), // abort as soon as anything happens
    });

    expect(result.stoppedEarly).toBe(true);
    // root was fetched before the abort took effect
    expect(storage.getFollows('root').length).toBeGreaterThan(0);
    // deeper follows were never scheduled
    expect(pool.calls).not.toContain('deep1');
  });

  it('throws CrawlError when zero relays are configured', async () => {
    const pool = makeMockPool({});
    const storage = await freshStorage();
    const crawler = new GraphCrawler({ pool, storage, relays: [], baseDelayMs: 0 });
    await expect(crawler.crawl('root')).rejects.toThrow(CrawlError);
    await expect(crawler.crawl('root')).rejects.toThrow('no relays connected');
  });

  it('can be stopped via stop()', async () => {
    const data = {
      root: [makeEvent(1, ['a', 'b'])],
      a: [makeEvent(1, ['deep'])],
      b: [makeEvent(1, ['deep2'])],
    };
    const pool = makeMockPool(data);
    const storage = await freshStorage();
    const crawler = new GraphCrawler({ pool, storage, relays, baseDelayMs: 0 });

    const result = await crawler.crawl('root', {
      maxDepth: 5,
      onProgress: () => crawler.stop(),
    });
    expect(result.stoppedEarly).toBe(true);
  });
});
