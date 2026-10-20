import type { KeyValueStore } from './types.js';

/** What separates an escaped prefix from the key that follows it. */
const SEPARATOR = ':';

/**
 * Escapes a namespace prefix so it cannot contain the separator.
 *
 * Without this, the mapping from `(prefix, key)` to storage key is not injective and two
 * differently-constructed views collide: `namespaced(s, 'a').set('b:c', …)` and
 * `namespaced(s, 'a:b').set('c', …)` would both write `a:b:c`, so each would silently read
 * and clobber the other's value. That is precisely the guarantee this module exists to
 * provide, so the separator has to be unambiguous.
 *
 * Percent-escaping `%` first and then `:` is injective on its own (the only `%` left in the
 * output starts an escape sequence we wrote), so distinct prefixes always produce distinct
 * escapes: `'a'` → `a`, `'a:b'` → `a%3Ab`, `'a%3Ab'` → `a%253Ab`. Because the escaped prefix
 * then contains no raw separator, the first separator in a storage key always marks the end
 * of the prefix, whatever the key itself contains.
 */
function escapePrefix(prefix: string): string {
  return prefix.replaceAll('%', '%25').replaceAll(SEPARATOR, '%3A');
}

/**
 * Views one {@link KeyValueStore} as a private sub-store.
 *
 * Every key is written as `${prefix}:${key}` in the underlying store, and `keys()` reports
 * unprefixed keys, filtering out everything belonging to another namespace or to no
 * namespace at all. `subscribe` does the same: a listener hears about its own keys, by
 * their unprefixed names, and never about a neighbour's.
 *
 * The point is that two subsystems sharing one physical store — a signer and a relay
 * cache, say — cannot read or clobber each other by picking the same key name. Keys are
 * free-form and may contain the `:` separator; the prefix is escaped so that they can, with
 * no view ever able to reach into another's keyspace.
 *
 * Nesting composes: `namespaced(namespaced(store, 'a'), 'b')` writes `a:b:key`.
 */
export function namespaced(store: KeyValueStore, prefix: string): KeyValueStore {
  const full = escapePrefix(prefix) + SEPARATOR;
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
