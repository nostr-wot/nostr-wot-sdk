import { createKeyedObservable } from "./keyed-observable";
import { singleFlight } from "./inflight";
import { readPersisted, writePersisted } from "./persistence";
import { streamProfile } from "../fetchers/profile";
import type { ProfileEntry } from "../parsers/kind0";

const BUCKET = "profile";

const store = createKeyedObservable<string, ProfileEntry>({
  equal: (a, b) =>
    a.pubkey === b.pubkey &&
    a.displayName === b.displayName &&
    a.name === b.name &&
    a.picture === b.picture &&
    a.banner === b.banner &&
    a.about === b.about &&
    a.nip05 === b.nip05 &&
    a.lud16 === b.lud16,
});

export function _profileStore() {
  return store;
}

export async function getProfile(pubkey: string): Promise<ProfileEntry | null> {
  const slot = store.get(pubkey);
  if (slot.value) return slot.value;

  const persisted = readPersisted<ProfileEntry>(BUCKET, pubkey);
  if (persisted) {
    store.set(pubkey, persisted);
    // refresh in background
    void singleFlight(`${BUCKET}:${pubkey}`, () => refreshProfile(pubkey));
    return persisted;
  }

  store.setStatus(pubkey, "loading");
  return singleFlight(`${BUCKET}:${pubkey}`, () => refreshProfile(pubkey));
}

function refreshProfile(pubkey: string): Promise<ProfileEntry | null> {
  return new Promise((resolve) => {
    let last: ProfileEntry | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const teardown = streamProfile(pubkey, (entry) => {
      last = entry;
      store.set(pubkey, entry);
      writePersisted(BUCKET, pubkey, entry);
      if (timer) clearTimeout(timer);
      // Wait briefly for additional newer events from slower relays before
      // resolving — gives us the freshest copy.
      timer = setTimeout(() => {
        teardown();
        resolve(last);
      }, 800);
    });
    // Hard ceiling
    setTimeout(() => {
      teardown();
      if (!last) store.setStatus(pubkey, "error");
      resolve(last);
    }, 6000);
  });
}
