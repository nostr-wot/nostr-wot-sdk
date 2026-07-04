import type { CrawlEvent, CrawlPool } from '../src/crawl';

export function makeEvent(created_at: number, follows: string[]): CrawlEvent {
  return {
    id: `${created_at}-${follows.join(',')}`,
    pubkey: 'author',
    created_at,
    kind: 3,
    content: '',
    sig: '',
    tags: follows.map((f) => ['p', f]),
  };
}

/**
 * Mock RelayPool: `subscribe` looks up the requested author in `data` and
 * asynchronously replays its events (possibly several, to test newest-per-
 * author selection) followed by an EOSE.
 */
export function makeMockPool(
  data: Record<string, CrawlEvent[]>,
  opts: { connected?: number } = {},
): CrawlPool & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getConnectedCount() {
      return opts.connected ?? 1;
    },
    subscribe(filter, handlers) {
      const author = (filter.authors && filter.authors[0]) || '';
      calls.push(author);
      const events = data[author] ?? [];
      let closed = false;
      queueMicrotask(() => {
        if (closed) return;
        for (const e of events) handlers.onEvent(e);
        handlers.onEose?.();
      });
      return {
        close() {
          closed = true;
        },
      };
    },
  };
}
