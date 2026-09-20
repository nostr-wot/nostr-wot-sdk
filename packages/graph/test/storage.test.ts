import { describe, it, expect } from 'vitest';
import { GraphStorage, encodeFollows, decodeFollows, encodeCompactFollows, decodeCompactFollows } from '../src/storage';

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

it('single-flights hydration and preserves version guards after reopening', async () => {
  const s = new GraphStorage(nextNs());
  await Promise.all([s.open(), s.open(), s.open()]);
  s.saveFollows('root', ['a', 'a'], { createdAt: 10, id: 'a' });
  await s.flush();
  s.close();
  const reopened = new GraphStorage(s.namespace);
  await reopened.open();
  expect(reopened.saveFollows('root', ['bad'], { createdAt: 9, id: '0' })).toBe(false);
  expect(reopened.stats().edges).toBe(1);
  expect(reopened.getFollows('root')).toEqual(['a']);
});

it('retains pending rows after an aborted transaction and retries them', async () => {
  const s = new GraphStorage(nextNs());
  await s.open();
  s.saveFollows('root', ['a']);
  const db = (s as unknown as { db: IDBDatabase }).db;
  const transaction = db.transaction.bind(db);
  let fail = true;
  db.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => {
    const tx = transaction(...args);
    if (fail) { fail = false; queueMicrotask(() => tx.abort()); }
    return tx;
  }) as IDBDatabase['transaction'];
  await expect(s.flush()).rejects.toBeTruthy();
  await s.flush();
  s.close();
  const reopened = new GraphStorage(s.namespace);
  await reopened.open();
  expect(reopened.getFollows('root')).toEqual(['a']);
});

it('serializes concurrent flushes without losing intervening writes', async () => {
  const s = new GraphStorage(nextNs());
  await s.open();
  s.saveFollows('root', ['a']);
  const first = s.flush();
  await Promise.resolve();
  s.saveFollows('root', ['b']);
  await Promise.all([first, s.flush()]);
  s.close();
  const reopened = new GraphStorage(s.namespace);
  await reopened.open();
  expect(reopened.getFollows('root')).toEqual(['b']);
});


it('stores dense follows in one byte per edge and decodes large uint32 deltas', () => {
  const dense = Array.from({ length: 1000 }, (_, i) => i + 1);
  expect(encodeCompactFollows(dense).byteLength).toBe(1000);
  expect(encodeFollows(dense).byteLength).toBe(4000);
  const ids = [1, 127, 128, 16384, 0xffffffff];
  expect(Array.from(decodeCompactFollows(encodeCompactFollows(ids)))).toEqual(ids);
  expect(() => decodeCompactFollows(Uint8Array.from([128]).buffer)).toThrow('Truncated');
});

it('reads legacy fixed-width rows and deduplicates legacy follows', async () => {
  const s = new GraphStorage(nextNs());
  await s.open();
  s.saveFollows('root', ['a']);
  await s.flush();
  const root = s.getId('root')!, a = s.getId('a')!;
  const db = (s as unknown as { db: IDBDatabase }).db;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('follows', 'readwrite');
    tx.objectStore('follows').put({ id: root, follows: encodeFollows([a, a]) });
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  s.close();
  const reopened = new GraphStorage(s.namespace);
  await reopened.open();
  expect(reopened.getFollows('root')).toEqual(['a']);
  expect(reopened.stats().edges).toBe(1);
});

it('upgrades a real version-1 database without rewriting its legacy rows', async () => {
  const namespace = nextNs();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(`nostr-wot-graph:${namespace}`, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('pubkeys', { keyPath: 'id' });
      db.createObjectStore('follows', { keyPath: 'id' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['pubkeys', 'follows'], 'readwrite');
      tx.objectStore('pubkeys').put({ id: 1, pubkey: 'root' });
      tx.objectStore('pubkeys').put({ id: 2, pubkey: 'a' });
      tx.objectStore('follows').put({ id: 1, follows: encodeFollows([2]) });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
  const s = new GraphStorage(namespace);
  await s.open();
  expect(s.getFollows('root')).toEqual(['a']);
  expect((s as unknown as { db: IDBDatabase }).db.version).toBe(2);
  s.saveFollows('a', ['root']);
  await s.flush();
  s.close();
  const reopened = new GraphStorage(namespace);
  await reopened.open();
  expect(reopened.getFollows('root')).toEqual(['a']);
  expect(reopened.getFollows('a')).toEqual(['root']);
});


it('rejects invalid compact IDs rather than overflowing or looping forever', () => {
  for (const id of [Infinity, NaN, -1, 1.5, 0x100000000]) {
    expect(() => encodeCompactFollows([id])).toThrow(RangeError);
  }
});
