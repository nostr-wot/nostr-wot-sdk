import type { KeyValueStore } from './types.js';

/**
 * Deep copy, so nothing stored can be reached by a reference the caller kept.
 *
 * `structuredClone` is the platform-neutral one: a plain global on every runtime we
 * target (Node 17+, current web engines, Hermes), and unlike a JSON round trip it
 * preserves `Map`, `Set`, `Date`, `Uint8Array` and cyclic references — which matters,
 * because keys and ciphertext travel through this store as byte arrays.
 */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * An in-memory {@link KeyValueStore}, for tests and for anything that should not outlive
 * the process.
 *
 * Values are deep cloned on the way in and on the way out, so a caller cannot mutate
 * stored state through a reference it retained, and two `get` calls hand back independent
 * objects. That makes `MemoryStore` behave like a store that serializes, rather than one
 * that happens to share objects — a test that passes against it passes against the real
 * backends too.
 */
export class MemoryStore implements KeyValueStore {
  readonly #entries = new Map<string, unknown>();
  readonly #listeners = new Set<(key: string) => void>();

  constructor(seed?: Record<string, unknown>) {
    if (seed) {
      for (const [key, value] of Object.entries(seed)) {
        this.#entries.set(key, clone(value));
      }
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.#entries.has(key)) return undefined;
    return clone(this.#entries.get(key) as T);
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.#entries.set(key, clone(value));
    this.#notify(key);
  }

  async remove(key: string): Promise<void> {
    // Only a removal that changed something is a change worth reporting.
    if (this.#entries.delete(key)) this.#notify(key);
  }

  async keys(): Promise<string[]> {
    return [...this.#entries.keys()];
  }

  subscribe(listener: (key: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(key: string): void {
    // Iterate a copy: a listener may unsubscribe itself while being notified.
    for (const listener of [...this.#listeners]) listener(key);
  }
}
