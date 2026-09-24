import { describe, test, expect } from 'vitest';
import { MemoryStore, namespaced } from '../src/index.js';

describe('MemoryStore', () => {
  test('round trips a value', async () => {
    const store = new MemoryStore();
    await store.set('a', { n: 1 });
    expect(await store.get('a')).toEqual({ n: 1 });
  });

  test('a namespaced store cannot see or clobber another namespace', async () => {
    const base = new MemoryStore();
    const one = namespaced(base, 'one');
    const two = namespaced(base, 'two');
    await one.set('k', 'from-one');
    await two.set('k', 'from-two');
    expect(await one.get('k')).toBe('from-one');
    expect(await one.keys()).toEqual(['k']);
  });

  test('subscribe fires on write and stops after unsubscribe', async () => {
    const store = new MemoryStore();
    const seen: string[] = [];
    const off = store.subscribe!((key) => seen.push(key));
    await store.set('a', 1);
    off();
    await store.set('b', 2);
    expect(seen).toEqual(['a']);
  });
});

describe('MemoryStore — isolation by deep clone', () => {
  test('mutating the object passed to set does not change stored state', async () => {
    const store = new MemoryStore();
    const value = { nested: { n: 1 }, list: [1, 2] };
    await store.set('a', value);
    value.nested.n = 999;
    value.list.push(3);
    expect(await store.get('a')).toEqual({ nested: { n: 1 }, list: [1, 2] });
  });

  test('mutating the object returned by get does not change stored state', async () => {
    const store = new MemoryStore();
    await store.set('a', { nested: { n: 1 } });
    const first = (await store.get<{ nested: { n: number } }>('a'))!;
    first.nested.n = 999;
    expect(await store.get('a')).toEqual({ nested: { n: 1 } });
  });

  test('two reads return independent objects', async () => {
    const store = new MemoryStore();
    await store.set('a', { n: 1 });
    const first = await store.get('a');
    const second = await store.get('a');
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  test('mutating the seed after construction does not change stored state', async () => {
    const seed = { a: { n: 1 } };
    const store = new MemoryStore(seed);
    seed.a.n = 999;
    expect(await store.get('a')).toEqual({ n: 1 });
  });

  test('seeds initial values and lists their keys', async () => {
    const store = new MemoryStore({ a: 1, b: 2 });
    expect(await store.get('b')).toBe(2);
    expect((await store.keys()).sort()).toEqual(['a', 'b']);
  });

  test('remove deletes the value and notifies subscribers', async () => {
    const store = new MemoryStore({ a: 1 });
    const seen: string[] = [];
    store.subscribe!((key) => seen.push(key));
    await store.remove('a');
    expect(await store.get('a')).toBeUndefined();
    expect(await store.keys()).toEqual([]);
    expect(seen).toEqual(['a']);
  });

  test('removing an absent key is a no-op and notifies nobody', async () => {
    const store = new MemoryStore();
    const seen: string[] = [];
    store.subscribe!((key) => seen.push(key));
    await store.remove('nope');
    expect(seen).toEqual([]);
  });
});

describe('namespaced', () => {
  test('writes land under the prefix in the underlying store', async () => {
    const base = new MemoryStore();
    const one = namespaced(base, 'one');
    await one.set('k', 'v');
    expect(await base.keys()).toEqual(['one:k']);
    expect(await base.get('one:k')).toBe('v');
  });

  test('keys() excludes other namespaces and unprefixed keys', async () => {
    const base = new MemoryStore();
    const one = namespaced(base, 'one');
    await base.set('bare', 1);
    await base.set('onething:k', 2);
    await namespaced(base, 'two').set('k', 3);
    await one.set('a', 4);
    await one.set('b', 5);
    expect((await one.keys()).sort()).toEqual(['a', 'b']);
  });

  test('remove only touches its own namespace', async () => {
    const base = new MemoryStore();
    const one = namespaced(base, 'one');
    const two = namespaced(base, 'two');
    await one.set('k', 'from-one');
    await two.set('k', 'from-two');
    await one.remove('k');
    expect(await one.get('k')).toBeUndefined();
    expect(await two.get('k')).toBe('from-two');
  });

  test('subscribe strips the prefix and filters out other namespaces', async () => {
    const base = new MemoryStore();
    const one = namespaced(base, 'one');
    const two = namespaced(base, 'two');
    const seen: string[] = [];
    const off = one.subscribe!((key) => seen.push(key));
    await one.set('a', 1);
    await two.set('b', 2);
    await base.set('bare', 3);
    await one.remove('a');
    off();
    await one.set('c', 4);
    expect(seen).toEqual(['a', 'a']);
  });

  test('omits subscribe when the underlying store has none', async () => {
    const base = new MemoryStore();
    const bare = {
      get: base.get.bind(base),
      set: base.set.bind(base),
      remove: base.remove.bind(base),
      keys: base.keys.bind(base),
    };
    expect(namespaced(bare, 'one').subscribe).toBeUndefined();
  });

  test('nests, composing prefixes', async () => {
    const base = new MemoryStore();
    const inner = namespaced(namespaced(base, 'one'), 'two');
    await inner.set('k', 'v');
    expect(await base.get('one:two:k')).toBe('v');
    expect(await inner.keys()).toEqual(['k']);
  });
});
