import { createKeyedObservable } from "./keyed-observable";
import { singleFlight } from "./inflight";
import { fetchThread } from "../fetchers/thread";
import { _putNote } from "./note-cache";
import { fetchEngagementBatch } from "./engagement-cache";

export type ThreadEntry = {
  rootId: string;
  replyIds: string[];
  fetchedAt: number;
};

const store = createKeyedObservable<string, ThreadEntry>();

export function _threadStore() {
  return store;
}

export async function getThread(rootId: string): Promise<ThreadEntry> {
  const cached = store.get(rootId).value;
  if (cached) return cached;

  store.setStatus(rootId, "loading");
  return singleFlight(`thread:${rootId}`, async () => {
    const replies = await fetchThread(rootId);
    for (const r of replies) _putNote(r);
    const entry: ThreadEntry = {
      rootId,
      replyIds: replies.map((r) => r.id),
      fetchedAt: Date.now(),
    };
    store.set(rootId, entry);
    if (replies.length > 0) {
      void fetchEngagementBatch(replies.map((r) => r.id));
    }
    return entry;
  });
}
