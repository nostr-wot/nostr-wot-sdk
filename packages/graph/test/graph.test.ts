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
