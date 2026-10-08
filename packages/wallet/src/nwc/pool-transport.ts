import type { SimplePool } from 'nostr-tools';
import type { NwcTransport } from './client';

/** Adapter for callers that already use nostr-tools; the pool retains socket ownership. */
export function createPoolNwcTransport(pool: SimplePool, relays: readonly string[]): NwcTransport {
  return {
    subscribe: (filter, handlers) => pool.subscribeMany([...relays], filter, {
      onevent: handlers.onEvent,
      oneose: handlers.onReady,
    }),
    async publish(event) {
      // A rejected acknowledgement does not prove the wallet did not receive
      // the request. Keep waiting for its signed answer or an unknown timeout.
      await Promise.allSettled(pool.publish([...relays], event));
      return true;
    },
    query: (filter, maxWaitMs) => pool.querySync([...relays], filter, { maxWait: maxWaitMs }),
  };
}
