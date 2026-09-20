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
): CrawlPool & { calls: string[]; requests: string[][] } {
  const calls: string[] = [];
  const requests: string[][] = [];
  return {
    calls, requests,
    getConnectedCount() {
      return opts.connected ?? 1;
    },
    subscribe(filter, handlers) {
      const authors = filter.authors ?? [];
      requests.push(authors);
      calls.push(...authors);
      const events = authors.flatMap(author => (data[author] ?? []).map(event => ({ ...event, pubkey: author })));
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
