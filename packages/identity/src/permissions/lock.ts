/**
 * A promise-chain mutex.
 *
 * Every read-modify-write in this package runs inside one, because the store has no
 * compare-and-swap: two writers that both read, both edit their own copy and both write
 * back leave only the second one's edit, and the user's first decision silently vanishes.
 * Serializing them is the whole fix.
 */
export class AsyncLock {
  #chain: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#chain;
    let release!: () => void;
    this.#chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
