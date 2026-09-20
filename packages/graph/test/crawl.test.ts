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

it('batches 250 authors into four total requests and stops at the hop boundary', async () => {
  const authors = Array.from({ length: 250 }, (_, i) => `author${i}`);
  const data = Object.fromEntries(authors.map(a => [a, [makeEvent(1, [`leaf-${a}`])]]));
  data.root = [makeEvent(1, authors)];
  const pool = makeMockPool(data);
  const storage = await freshStorage();
  const crawler = new GraphCrawler({ pool, storage, relays, baseDelayMs: 0 });
  const result = await crawler.crawl('root', { maxHops: 2 });
  expect(result.fetched).toBe(251);
  expect(pool.requests.map(r => r.length)).toEqual([1, 100, 100, 50]);
  expect(pool.calls.some(a => a.startsWith('leaf-'))).toBe(false);
  expect(storage.stats().edges).toBe(500);
});

it('uses persisted event versions and deterministic equal-timestamp ids', async () => {
  const storage = await freshStorage();
  const pool = makeMockPool({ root: [{ ...makeEvent(0, ['winner']), id: 'a' }, { ...makeEvent(0, ['loser']), id: 'z' }] });
  await new GraphCrawler({ pool, storage, relays, baseDelayMs: 0 }).crawl('root', { maxHops: 1 });
  expect(storage.getFollows('root')).toEqual(['winner']);
  storage.close();
  const reopened = new GraphStorage(storage.namespace);
  await reopened.open();
  await new GraphCrawler({ pool: makeMockPool({ root: [{ ...makeEvent(0, ['stale']), id: 'b' }] }), storage: reopened, relays, baseDelayMs: 0 }).crawl('root', { maxHops: 1 });
  expect(reopened.getFollows('root')).toEqual(['winner']);
});

it('cancels a silent relay immediately and closes its subscription', async () => {
  let closed = false;
  const storage = await freshStorage();
  const crawler = new GraphCrawler({ pool: { subscribe: () => ({ close: () => { closed = true; } }) }, storage, relays, baseDelayMs: 0, requestTimeoutMs: 60_000 });
  const run = crawler.crawl('root');
  crawler.stop();
  expect((await run).stoppedEarly).toBe(true);
  expect(closed).toBe(true);
});

it('a zero-hop crawl makes no requests and rejects invalid bounds', async () => {
  const pool = makeMockPool({});
  const crawler = new GraphCrawler({ pool, storage: await freshStorage(), relays, baseDelayMs: 0 });
  expect((await crawler.crawl('root', { maxHops: 0 })).fetched).toBe(0);
  expect(pool.requests).toHaveLength(0);
  await expect(crawler.crawl('root', { maxHops: NaN })).rejects.toThrow(RangeError);
});

it('drains concurrent lanes before propagating a transport error', async () => {
  let closed = 0;
  const storage = await freshStorage();
  const pool = {
    subscribe(filter: { authors?: string[] }, handlers: { onEvent: (e: ReturnType<typeof makeEvent>) => void; onEose?: () => void }) {
      const author = filter.authors![0];
      if (author === 'bad') throw new Error('transport failed');
      if (author === 'root') queueMicrotask(() => { handlers.onEvent({ ...makeEvent(1, ['slow', 'bad']), pubkey: 'root' }); handlers.onEose?.(); });
      return { close() { closed++; } };
    },
  };
  const crawler = new GraphCrawler({ pool, storage, relays, batchSize: 1, maxConcurrent: 2, baseDelayMs: 0 });
  await expect(crawler.crawl('root')).rejects.toThrow('transport failed');
  expect(closed).toBe(2);
  expect(storage.stats().nodes).toBe(1);
});
