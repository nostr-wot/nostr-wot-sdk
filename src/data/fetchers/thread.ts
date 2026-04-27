import { fastCollect } from "../internal/sub";
import { DEFAULT_RELAYS } from "../pool";
import type { NoteEntry } from "./note";

/**
 * Fetch all kind-1 events that reference `rootId` in their `e` tags
 * (i.e. all replies to that note). Sorted oldest-first.
 *
 * For larger threads this is a heavy query. Consider passing a wider
 * relay set and a longer timeout. Discovery via NIP-65 outbox doesn't
 * help here because replies come from arbitrary authors — the wider
 * the relay set, the better the recall.
 */
export async function fetchThread(
  rootId: string,
  options: { relays?: string[]; timeoutMs?: number } = {},
): Promise<NoteEntry[]> {
  const relays = options.relays ?? DEFAULT_RELAYS;
  const events = await fastCollect(relays, { kinds: [1], "#e": [rootId] }, {
    timeoutMs: options.timeoutMs ?? 5000,
  });
  return events
    .map((e) => ({
      id: e.id, pubkey: e.pubkey, content: e.content,
      createdAt: e.created_at, tags: e.tags,
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}
