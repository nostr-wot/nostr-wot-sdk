import { fastNewest } from "../internal/sub";
import { getDefaultRelays } from "../pool";
import { parseRelayList, type RelayListEntry } from "../parsers/kind10002";

/**
 * Fetch a user's NIP-65 (kind 10002) relay-list metadata. Returns null
 * if no kind-10002 event exists for this pubkey on the queried relays.
 */
export async function fetchRelayList(
  pubkey: string,
  relays: string[] = getDefaultRelays(),
): Promise<RelayListEntry | null> {
  const event = await fastNewest(relays, { kinds: [10002], authors: [pubkey] });
  return event ? parseRelayList(event) : null;
}
