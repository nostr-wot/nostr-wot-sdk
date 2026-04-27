import { createKeyedObservable } from "./keyed-observable";
import { singleFlight } from "./inflight";
import { fetchEngagement, type Engagement } from "../fetchers/engagement";

const store = createKeyedObservable<string, Engagement>({
  equal: (a, b) =>
    a.reactionCount === b.reactionCount &&
    a.repostCount === b.repostCount &&
    a.zapTotalSats === b.zapTotalSats,
});

export function _engagementStore() {
  return store;
}

const empty = (): Engagement => ({ reactionCount: 0, repostCount: 0, zapTotalSats: 0 });

export function getEngagement(noteId: string): Engagement {
  return store.get(noteId).value ?? empty();
}

/**
 * Fetch engagement for a batch of note ids and stream incremental
 * updates into the store. Coalesces concurrent requests for the exact
 * same id set; for partial overlap, the second batch will hit relays
 * separately. (Optimisation: a smarter coalescer could deduplicate
 * overlapping ids — left for v0.7.)
 */
export function fetchEngagementBatch(noteIds: string[]): Promise<void> {
  if (noteIds.length === 0) return Promise.resolve();
  const key = `engagement:${noteIds.slice().sort().join(",")}`;
  return singleFlight(key, async () => {
    // Initialize empty slots so consumers see "0" instead of "loading"
    for (const id of noteIds) {
      if (!store.get(id).value) store.set(id, empty());
    }
    const result = await fetchEngagement(noteIds);
    for (const [id, eng] of result) store.set(id, eng);
  });
}
