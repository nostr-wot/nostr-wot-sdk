import { createKeyedObservable } from "./keyed-observable";
import { singleFlight } from "./inflight";
import { fetchNotesByAuthor } from "../fetchers/notes-by-author";
import { _putNote } from "./note-cache";
import { getRelayList } from "./relay-list-cache";
import { relaysForAuthorSync } from "./relay-list-cache";

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

export async function getAuthorNotes(pubkey: string, limit = PAGE_SIZE): Promise<AuthorNotesEntry> {
  const cached = store.get(pubkey).value;
  if (cached && cached.noteIds.length >= limit) return cached;

  // Kick NIP-65 lookup so subsequent pagination uses the author's outbox
  void getRelayList(pubkey).catch(() => null);

  store.setStatus(pubkey, "loading");
  return singleFlight(`author-notes:${pubkey}:${limit}`, async () => {
    const notes = await fetchNotesByAuthor(pubkey, {
      limit,
      relays: relaysForAuthorSync(pubkey),
      onEvent: _putNote,
    });
    const entry: AuthorNotesEntry = {
      pubkey,
      noteIds: notes.map((n) => n.id),
      oldestCreatedAt: notes.length > 0 ? notes[notes.length - 1]!.createdAt : null,
      fetchedAt: Date.now(),
    };
    store.set(pubkey, entry);
    return entry;
  });
}

export async function loadMoreAuthorNotes(pubkey: string, count = PAGE_SIZE): Promise<AuthorNotesEntry> {
  const current = store.get(pubkey).value;
  if (!current || current.oldestCreatedAt === null) return getAuthorNotes(pubkey, count);

  return singleFlight(`author-notes-more:${pubkey}:${current.oldestCreatedAt}`, async () => {
    const more = await fetchNotesByAuthor(pubkey, {
      limit: count,
      until: current.oldestCreatedAt! - 1,
      relays: relaysForAuthorSync(pubkey),
      onEvent: _putNote,
    });
    const merged = [...new Set([...current.noteIds, ...more.map((n) => n.id)])];
    const entry: AuthorNotesEntry = {
      pubkey,
      noteIds: merged,
      oldestCreatedAt: more.length > 0 ? more[more.length - 1]!.createdAt : current.oldestCreatedAt,
      fetchedAt: Date.now(),
    };
    store.set(pubkey, entry);
    return entry;
  });
}
