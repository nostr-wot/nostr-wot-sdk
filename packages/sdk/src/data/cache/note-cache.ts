import { createKeyedObservable } from "./keyed-observable";
import { singleFlight } from "./inflight";
import { readPersisted, writePersisted } from "./persistence";
import { fetchNote, type NoteEntry } from "../fetchers/note";

const BUCKET = "note";

const store = createKeyedObservable<string, NoteEntry>();

export function _noteStore() {
  return store;
}

export async function getNote(id: string, hintRelays: string[] = []): Promise<NoteEntry | null> {
  const slot = store.get(id);
  if (slot.value) return slot.value;

  const persisted = readPersisted<NoteEntry>(BUCKET, id);
  if (persisted) {
    store.set(id, persisted);
    return persisted;
  }

  store.setStatus(id, "loading");
  return singleFlight(`${BUCKET}:${id}`, async () => {
    const fresh = await fetchNote(id, hintRelays);
    if (fresh) {
      store.set(id, fresh);
      writePersisted(BUCKET, id, fresh);
    } else {
      store.setStatus(id, "error");
    }
    return fresh;
  });
}

/** Allows other caches (notes-by-author, thread) to push events into the
 *  per-id store as they receive them, so /notes/{id} pages share data. */
export function _putNote(entry: NoteEntry): void {
  store.set(entry.id, entry);
}
