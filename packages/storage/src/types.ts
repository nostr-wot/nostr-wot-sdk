/**
 * The storage port.
 *
 * Every `@nostr-wot` package that needs to persist something talks to this interface and
 * nothing else, so the same code runs unchanged on every host we target: an extension, a
 * mobile app, a Node process, a test. The host supplies the implementation — extension
 * storage, an encrypted keychain, a file — and none of that vocabulary leaks in here.
 *
 * Implementations are expected to behave as a value store, not a reference store: what
 * comes back out of `get` must be unaffected by later mutation of what went into `set`,
 * and vice versa. `MemoryStore` achieves that by deep cloning; a store that serializes
 * to disk gets it for free.
 */
export interface KeyValueStore {
  /** The value stored under `key`, or `undefined` when there is none. */
  get<T>(key: string): Promise<T | undefined>;
  /** Stores `value` under `key`, replacing whatever was there. */
  set<T>(key: string, value: T): Promise<void>;
  /** Removes `key`. Removing a key that is not present is not an error. */
  remove(key: string): Promise<void>;
  /** Every key currently held, in no guaranteed order. */
  keys(): Promise<string[]>;
  /**
   * Observes writes and removals, if this store can. Optional: a store backed by
   * something that cannot report changes simply omits it, so callers must check.
   * Returns a function that stops the subscription.
   */
  subscribe?(listener: (key: string) => void): () => void;
}
