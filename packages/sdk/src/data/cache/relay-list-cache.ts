import { createKeyedObservable } from "./keyed-observable";
import { singleFlight } from "./inflight";
import { readPersisted, writePersisted } from "./persistence";
import { fetchRelayList } from "../fetchers/relay-list";
import type { RelayListEntry } from "../parsers/kind10002";
import { getDefaultRelays } from "../pool";

const BUCKET = "relay-list";
const store = createKeyedObservable<string, RelayListEntry>();

export function _relayListStore() {
  return store;
}

export async function getRelayList(pubkey: string): Promise<RelayListEntry | null> {
  const slot = store.get(pubkey);
  if (slot.value) return slot.value;

  const persisted = readPersisted<RelayListEntry>(BUCKET, pubkey);
  if (persisted) {
    store.set(pubkey, persisted);
    void singleFlight(`${BUCKET}:${pubkey}`, async () => {
      const fresh = await fetchRelayList(pubkey);
      if (fresh) {
        store.set(pubkey, fresh);
        writePersisted(BUCKET, pubkey, fresh);
      }
      return fresh;
    });
    return persisted;
  }

  store.setStatus(pubkey, "loading");
  const fresh = await singleFlight(`${BUCKET}:${pubkey}`, () => fetchRelayList(pubkey));
  if (fresh) {
    store.set(pubkey, fresh);
    writePersisted(BUCKET, pubkey, fresh);
  } else {
    store.setStatus(pubkey, "error");
  }
  return fresh;
}

/** Sync read of cached relays for an author — defaults if not yet cached. */
export function relaysForAuthorSync(pubkey: string): string[] {
  const slot = store.get(pubkey);
  if (slot.value && slot.value.write.length > 0) {
    return [...new Set([...slot.value.write, ...getDefaultRelays()])];
  }
  return getDefaultRelays();
}
