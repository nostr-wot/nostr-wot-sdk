import { createKeyedObservable } from "./keyed-observable";
import { singleFlight } from "./inflight";
import { fetchNotesByAuthor } from "../fetchers/notes-by-author";
import { _putNote } from "./note-cache";
import type { NoteEntry } from "../fetchers/note";
import { getRelayList, relaysForAuthorSync } from "./relay-list-cache";

export type AuthorNotesEntry = {
  pubkey: string;
  noteIds: string[];
  oldestCreatedAt: number | null;
  fetchedAt: number;
};

const PAGE_SIZE = 20;
const store = createKeyedObservable<string, AuthorNotesEntry>();

export function _authorNotesStore() {
  return store;
}

/**
 * Build the entry from the in-memory `collected` map. Hoisted so both the
 * incremental flush (called per-event) and the final flush (after EOSE)
 * use identical logic.
 */
function buildEntry(pubkey: string, collected: Map<string, NoteEntry>, limit: number): AuthorNotesEntry {
  const sorted = [...collected.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  return {
    pubkey,
    noteIds: sorted.map((n) => n.id),
    oldestCreatedAt: sorted.length > 0 ? sorted[sorted.length - 1]!.createdAt : null,
    fetchedAt: Date.now(),
  };
}

export async function getAuthorNotes(pubkey: string, limit = PAGE_SIZE): Promise<AuthorNotesEntry> {
  const cached = store.get(pubkey).value;
  if (cached && cached.noteIds.length >= limit) return cached;

  // Kick NIP-65 lookup so subsequent pagination uses the author's outbox
  void getRelayList(pubkey).catch(() => null);

  store.setStatus(pubkey, "loading");
  return singleFlight(`author-notes:${pubkey}:${limit}`, async () => {
    // Incrementally update the entry as each note arrives, so subscribers
    // see rows fill in instead of waiting for EOSE-from-all.
    const collected = new Map<string, NoteEntry>();
    await fetchNotesByAuthor(pubkey, {
      limit,
      relays: relaysForAuthorSync(pubkey),
      onEvent: (n) => {
        if (collected.has(n.id)) return;
        collected.set(n.id, n);
        _putNote(n);
        store.set(pubkey, buildEntry(pubkey, collected, limit));
      },
    });
    // Final flush after EOSE in case the last batch arrived in flight
    const final = buildEntry(pubkey, collected, limit);
    store.set(pubkey, final);
    return final;
  });
}

export async function loadMoreAuthorNotes(pubkey: string, count = PAGE_SIZE): Promise<AuthorNotesEntry> {
  const current = store.get(pubkey).value;
  if (!current || current.oldestCreatedAt === null) return getAuthorNotes(pubkey, count);

  return singleFlight(`author-notes-more:${pubkey}:${current.oldestCreatedAt}`, async () => {
    // Stream new ids onto the existing entry as they arrive
    const merged = new Set(current.noteIds);
    let oldest = current.oldestCreatedAt!;
    await fetchNotesByAuthor(pubkey, {
      limit: count,
      until: current.oldestCreatedAt! - 1,
      relays: relaysForAuthorSync(pubkey),
      onEvent: (n) => {
        if (merged.has(n.id)) return;
        merged.add(n.id);
        _putNote(n);
        if (n.createdAt < oldest) oldest = n.createdAt;
        store.set(pubkey, {
          pubkey,
          noteIds: [...merged],
          oldestCreatedAt: oldest,
          fetchedAt: Date.now(),
        });
      },
    });
    return store.get(pubkey).value!;
  });
}
