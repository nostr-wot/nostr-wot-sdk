import { fastCollect } from "../internal/sub";
import { relaysForAuthor } from "../outbox";
import type { NoteEntry } from "./note";

/**
 * Fetch up to `limit` recent kind-1 notes for `pubkey`. Routes through
 * the outbox model — queries the union of defaults + the author's NIP-65
 * write relays. Pass `until` (Unix seconds) to paginate older.
 *
 * `onEvent` fires for each note as it arrives so callers can stream into
 * a UI / cache. The returned Promise resolves with the full collected
 * list once EOSE arrives from all relays or the timeout expires.
 */
export async function fetchNotesByAuthor(
  pubkey: string,
  options: { limit?: number; until?: number; relays?: string[]; onEvent?: (n: NoteEntry) => void } = {},
): Promise<NoteEntry[]> {
  const limit = options.limit ?? 20;
  const relays = options.relays ?? (await relaysForAuthor(pubkey).catch(() => undefined)) ?? [];
  if (relays.length === 0) return [];
  const filter = {
    kinds: [1],
    authors: [pubkey],
    limit,
    ...(options.until !== undefined ? { until: options.until } : {}),
  };
  const events = await fastCollect(relays, filter, {
    onEvent: options.onEvent
      ? (e) =>
          options.onEvent!({
            id: e.id, pubkey: e.pubkey, content: e.content,
            createdAt: e.created_at, tags: e.tags,
          })
      : undefined,
  });
  return events
    .map((e) => ({
      id: e.id, pubkey: e.pubkey, content: e.content,
      createdAt: e.created_at, tags: e.tags,
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}
