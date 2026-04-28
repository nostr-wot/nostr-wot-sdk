import type { Event } from "nostr-tools";

/**
 * NIP-65 relay-list metadata.
 * read[] = relays where the user fetches; write[] = where they publish.
 * Markerless tags ("r" with no third element) count as both.
 */
export type RelayListEntry = {
  pubkey: string;
  read: string[];
  write: string[];
  fetchedAt: number;
};

export function parseRelayList(event: Event): RelayListEntry {
  const read = new Set<string>();
  const write = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== "r" || !tag[1]?.startsWith("ws")) continue;
    const url = tag[1];
    const marker = tag[2];
    if (!marker) {
      read.add(url);
      write.add(url);
    } else if (marker === "read") {
      read.add(url);
    } else if (marker === "write") {
      write.add(url);
    }
  }
  return {
    pubkey: event.pubkey,
    read: [...read],
    write: [...write],
    fetchedAt: Date.now(),
  };
}
