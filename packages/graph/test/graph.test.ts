import { describe, it, expect, beforeEach } from 'vitest';
import { GraphStorage } from '../src/storage';
import { LocalGraph } from '../src/graph';

let ns = 0;

async function buildGraph(map: Record<string, string[]>): Promise<{ storage: GraphStorage; graph: LocalGraph }> {
  const storage = new GraphStorage(`graph-test-${ns++}`);
  await storage.open();
  for (const [author, follows] of Object.entries(map)) {
    storage.saveFollows(author, follows);
  }
  return { storage, graph: new LocalGraph(storage) };
}

describe('LocalGraph BFS', () => {
  it('reports self as { hops: 0, paths: 1 }', async () => {
    const { graph } = await buildGraph({ root: [] });
    expect(graph.getDistance('root', 'root')).toEqual({ hops: 0, paths: 1 });
  });

  it('returns null for unknown / unreached pubkeys (root-only graph)', async () => {
    const { graph } = await buildGraph({ root: [] });
    expect(graph.getDistance('root', 'stranger')).toBeNull();
  });

  it('computes direct-follow distance', async () => {
    const { graph } = await buildGraph({ root: ['a', 'b'] });
    expect(graph.getDistance('root', 'a')).toEqual({ hops: 1, paths: 1 });
    expect(graph.getDistance('root', 'b')).toEqual({ hops: 1, paths: 1 });
  });

  it('counts shortest paths across a diamond', async () => {
    // root -> a, root -> b, a -> c, b -> c  => c is 2 hops via 2 paths
    const { graph } = await buildGraph({
      root: ['a', 'b'],
      a: ['c'],
      b: ['c'],
    });
    expect(graph.getDistance('root', 'a')).toEqual({ hops: 1, paths: 1 });
    expect(graph.getDistance('root', 'c')).toEqual({ hops: 2, paths: 2 });
  });

  it('handles cycles without infinite loops and keeps shortest hop', async () => {
    // root -> a -> b -> root (cycle) and a -> c
    const { graph } = await buildGraph({
      root: ['a'],
      a: ['b', 'c'],
      b: ['root'],
    });
    expect(graph.getDistance('root', 'a')).toEqual({ hops: 1, paths: 1 });
    expect(graph.getDistance('root', 'b')).toEqual({ hops: 2, paths: 1 });
    expect(graph.getDistance('root', 'c')).toEqual({ hops: 2, paths: 1 });
    // root stays at distance 0 despite the back-edge
    expect(graph.getDistance('root', 'root')).toEqual({ hops: 0, paths: 1 });
  });

  it('returns null for disconnected nodes', async () => {
    // 'island' is followed by 'lonely', neither reachable from root
    const { graph } = await buildGraph({
      root: ['a'],
      a: [],
      lonely: ['island'],
    });
    expect(graph.getDistance('root', 'island')).toBeNull();
    expect(graph.getDistance('root', 'lonely')).toBeNull();
  });

  it('accumulates paths at deeper levels', async () => {
    // root -> a,b ; a -> c ; b -> c ; c -> d  => d is 3 hops, 2 paths (through c)
    const { graph } = await buildGraph({
      root: ['a', 'b'],
      a: ['c'],
      b: ['c'],
      c: ['d'],
    });
    expect(graph.getDistance('root', 'd')).toEqual({ hops: 3, paths: 2 });
  });

  it('exposes follows via getFollows', async () => {
    const { graph } = await buildGraph({ root: ['a', 'b'] });
    expect(new Set(graph.getFollows('root'))).toEqual(new Set(['a', 'b']));
    expect(graph.getFollows('unknown')).toEqual([]);
  });
});

beforeEach(() => {
  // nothing shared; each buildGraph uses a fresh namespace
});

it('keys traversal reuse by depth and graph revision, without duplicate paths', async () => {
  const { graph, storage } = await buildGraph({ root: ['a', 'a'], a: ['b'] });
  expect(graph.getDistance('root', 'b', 1)).toBeNull();
  expect(graph.getDistance('root', 'b', 2)).toEqual({ hops: 2, paths: 1 });
  expect(graph.getDistance('root', 'b', 1)).toBeNull();
  storage.saveFollows('root', ['b']);
  expect(graph.getDistance('root', 'b', 1)).toEqual({ hops: 1, paths: 1 });
  expect(storage.stats().edges).toBe(2);
});

it('does not wrap path counts at uint32 or distances at uint8 limits', async () => {
  const map: Record<string, string[]> = { root: ['a0', 'b0'] };
  for (let i = 0; i < 55; i++) {
    map[`a${i}`] = [`a${i + 1}`, `b${i + 1}`];
    map[`b${i}`] = [`a${i + 1}`, `b${i + 1}`];
  }
  const { graph } = await buildGraph(map);
  expect(graph.getDistance('root', 'a32', 60)?.paths).toBe(2 ** 32);
  expect(graph.getDistance('root', 'a55', 60)?.paths).toBe(Number.MAX_SAFE_INTEGER);
  const chain = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`n${i}`, [`n${i + 1}`]]));
  const long = await buildGraph(chain);
  expect(long.graph.getDistance('n0', 'n300', 300)).toEqual({ hops: 300, paths: 1 });
});

it('reuses a single traversal for repeated queries until a real edge change', async () => {
  const { graph, storage } = await buildGraph({ root: ['a'], a: ['b'] });
  let reads = 0;
  const read = storage.getFollowIdsSync.bind(storage);
  storage.getFollowIdsSync = id => { reads++; return read(id); };
  for (let i = 0; i < 1000; i++) graph.getDistance('root', 'b');
  expect(reads).toBe(3);
  graph.getDistance('root', 'b', 2);
  graph.getDistance('root', 'b', 6);
  expect(reads).toBe(3);
  storage.saveFollows('root', ['a']);
  graph.getDistance('root', 'b');
  expect(reads).toBe(3);
});
