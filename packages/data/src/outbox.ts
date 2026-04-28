import { getDefaultRelays } from "./pool";
import { fetchRelayList } from "./fetchers/relay-list";

/**
 * Outbox-model relay union for `pubkey`. Returns the union of (1) the
 * caller's default relays and (2) the relays where this pubkey publishes
 * (their NIP-65 write[]). Falls back to defaults if NIP-65 isn't
 * published or fetch fails.
 *
 * Use this any time you query for events authored by a specific pubkey
 * — it gives you the best chance of finding their content even if it
 * doesn't make it to the popular relays.
 *
 * Cost: one extra relay query (kind 10002) the first time you ask about
 * an author. Use the cache layer (`nostr-wot-sdk/data/cache`) to
 * memoize across calls.
 */
export async function relaysForAuthor(
  pubkey: string,
  defaults: string[] = getDefaultRelays(),
): Promise<string[]> {
  try {
    const list = await fetchRelayList(pubkey, defaults);
    if (!list || list.write.length === 0) return defaults;
    return [...new Set([...list.write, ...defaults])];
  } catch {
    return defaults;
  }
}

/**
 * Read-side variant: where to subscribe to FIND events sent TO `pubkey`
 * (e.g. DMs, mentions). Uses the user's NIP-65 read[] relays + defaults.
 */
export async function readRelaysForAuthor(
  pubkey: string,
  defaults: string[] = getDefaultRelays(),
): Promise<string[]> {
  try {
    const list = await fetchRelayList(pubkey, defaults);
    if (!list || list.read.length === 0) return defaults;
    return [...new Set([...list.read, ...defaults])];
  } catch {
    return defaults;
  }
}
