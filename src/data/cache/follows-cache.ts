import { createKeyedObservable } from "./keyed-observable";
import { singleFlight } from "./inflight";
import { readPersisted, writePersisted } from "./persistence";
import { fetchFollows, type FollowsEntry } from "../fetchers/follows";
import { getRelayList, relaysForAuthorSync } from "./relay-list-cache";

const BUCKET = "follows";
const store = createKeyedObservable<string, FollowsEntry>();

export function _followsStore() {
  return store;
}

export async function getFollows(pubkey: string): Promise<FollowsEntry | null> {
  const slot = store.get(pubkey);
  if (slot.value) return slot.value;

  const persisted = readPersisted<FollowsEntry>(BUCKET, pubkey);
  if (persisted) {
    store.set(pubkey, persisted);
    void singleFlight(`${BUCKET}:${pubkey}`, async () => {
      void getRelayList(pubkey).catch(() => null);
      const fresh = await fetchFollows(pubkey, relaysForAuthorSync(pubkey));
      if (fresh) {
        store.set(pubkey, fresh);
        writePersisted(BUCKET, pubkey, fresh);
      }
      return fresh;
    });
    return persisted;
  }

  store.setStatus(pubkey, "loading");
  return singleFlight(`${BUCKET}:${pubkey}`, async () => {
    void getRelayList(pubkey).catch(() => null);
    const fresh = await fetchFollows(pubkey, relaysForAuthorSync(pubkey));
    if (fresh) {
      store.set(pubkey, fresh);
      writePersisted(BUCKET, pubkey, fresh);
    } else {
      store.setStatus(pubkey, "error");
    }
    return fresh;
  });
}
