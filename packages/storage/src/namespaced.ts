import type { KeyValueStore } from './types.js';

/**
 * Views one {@link KeyValueStore} as a private sub-store.
 *
 * Every key is written as `${prefix}:${key}` in the underlying store, and `keys()` reports
 * unprefixed keys, filtering out everything belonging to another namespace or to no
 * namespace at all. `subscribe` does the same: a listener hears about its own keys, by
 * their unprefixed names, and never about a neighbour's.
 *
 * The point is that two subsystems sharing one physical store — a signer and a relay
 * cache, say — cannot read or clobber each other by picking the same key name.
 *
 * Nesting composes: `namespaced(namespaced(store, 'a'), 'b')` writes `a:b:key`.
 */
export function namespaced(store: KeyValueStore, prefix: string): KeyValueStore {
  const full = `${prefix}:`;
  const scoped = (key: string) => full + key;

  /** The unprefixed key, or `undefined` when `key` is not ours. */
  const unscoped = (key: string): string | undefined =>
    key.startsWith(full) ? key.slice(full.length) : undefined;

  const view: KeyValueStore = {
    get: <T>(key: string) => store.get<T>(scoped(key)),
    set: <T>(key: string, value: T) => store.set<T>(scoped(key), value),
    remove: (key: string) => store.remove(scoped(key)),
    keys: async () => {
      const all = await store.keys();
      const mine: string[] = [];
      for (const key of all) {
        const own = unscoped(key);
        if (own !== undefined) mine.push(own);
      }
      return mine;
    },
  };

  // Only expose `subscribe` when the underlying store actually has one, so callers that
  // check for it get a truthful answer instead of a listener that never fires.
  const underlying = store.subscribe;
  if (underlying) {
    view.subscribe = (listener) =>
      underlying.call(store, (key) => {
        const own = unscoped(key);
        if (own !== undefined) listener(own);
      });
  }

  return view;
}
