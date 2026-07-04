import { describe, it, expect } from 'vitest';
import { GraphStorage, encodeFollows, decodeFollows } from '../src/storage';

let ns = 0;
const nextNs = () => `storage-test-${ns++}`;

describe('interning', () => {
  it('round-trips pubkey <-> id', async () => {
    const s = new GraphStorage(nextNs());
    await s.open();
    const idA = s.getOrCreateId('a');
    const idB = s.getOrCreateId('b');
    expect(idA).not.toBe(idB);
    expect(s.getOrCreateId('a')).toBe(idA); // stable
    expect(s.getHex(idA)).toBe('a');
    expect(s.getHex(idB)).toBe('b');
    expect(s.getId('a')).toBe(idA);
    expect(s.getId('missing')).toBeNull();
    expect(s.getMaxId()).toBe(idB);
  });
});

describe('delta encode/decode', () => {
  it('round-trips a sorted follow list', () => {
    const ids = [1, 5, 9, 100, 101];
    const buf = encodeFollows(ids);
    expect(Array.from(decodeFollows(buf))).toEqual(ids);
  });

  it('sorts before encoding', () => {
    const buf = encodeFollows([100, 1, 50, 2]);
    expect(Array.from(decodeFollows(buf))).toEqual([1, 2, 50, 100]);
  });

  it('handles empty lists', () => {
    expect(encodeFollows([]).byteLength).toBe(0);
    expect(Array.from(decodeFollows(new ArrayBuffer(0)))).toEqual([]);
    expect(Array.from(decodeFollows(null))).toEqual([]);
  });
});

describe('save / load follows', () => {
  it('persists follows across storage instances', async () => {
    const namespace = nextNs();
    const s1 = new GraphStorage(namespace);
    await s1.open();
    s1.saveFollows('alice', ['bob', 'carol']);
    s1.saveFollows('bob', ['carol']);
    await s1.flush();
    s1.close();

    const s2 = new GraphStorage(namespace);
    await s2.open();
    expect(new Set(s2.getFollows('alice'))).toEqual(new Set(['bob', 'carol']));
    expect(s2.getFollows('bob')).toEqual(['carol']);
    expect(s2.getFollows('carol')).toEqual([]);
  });
});

describe('meta', () => {
  it('stores and reads structured graph meta', async () => {
    const s = new GraphStorage(nextNs());
    await s.open();
    await s.setMeta('root', 'rootpk');
    await s.setMeta('lastCrawl', 12345);
    await s.setMeta('maxDepth', 2);
    await s.setMeta('version', 1);
    expect(s.getMeta('root')).toBe('rootpk');
    expect(s.getGraphMeta()).toEqual({
      root: 'rootpk',
      lastCrawl: 12345,
      maxDepth: 2,
      version: 1,
    });
  });

  it('persists meta across instances', async () => {
    const namespace = nextNs();
    const s1 = new GraphStorage(namespace);
    await s1.open();
    await s1.setMeta('root', 'abc');
    s1.close();

    const s2 = new GraphStorage(namespace);
    await s2.open();
    expect(s2.getMeta('root')).toBe('abc');
  });
});

describe('stats and clear', () => {
  it('reports nodes / edges / uniquePubkeys', async () => {
    const s = new GraphStorage(nextNs());
    await s.open();
    s.saveFollows('a', ['b', 'c']);
    s.saveFollows('b', ['c']);
    const stats = s.stats();
    expect(stats.nodes).toBe(2); // a, b have follow lists
    expect(stats.edges).toBe(3); // a->b, a->c, b->c
    expect(stats.uniquePubkeys).toBe(3); // a, b, c
  });

  it('clears everything', async () => {
    const namespace = nextNs();
    const s = new GraphStorage(namespace);
    await s.open();
    s.saveFollows('a', ['b']);
    await s.flush();
    await s.clear();
    expect(s.stats()).toEqual({ nodes: 0, edges: 0, uniquePubkeys: 0 });
    expect(s.getFollows('a')).toEqual([]);

    // and it stays cleared after reopening
    s.close();
    const s2 = new GraphStorage(namespace);
    await s2.open();
    expect(s2.stats().nodes).toBe(0);
  });
});
