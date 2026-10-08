import { isPublicWssUrl } from "@nostr-wot/relay";
export { isPublicWssUrl } from "@nostr-wot/relay";
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

export type RelayListFilter = "all" | "public" | ((url: string) => boolean);

function shouldKeep(url: string, filter: RelayListFilter): boolean {
  if (filter === "all") return url.startsWith("ws");
  if (filter === "public") return isPublicWssUrl(url);
  return filter(url);
}

/**
 * Parse a kind-10002 (NIP-65) relay-list metadata event.
 *
 * @param event   The kind-10002 event.
 * @param filter  How to filter relay URLs:
 *                  - `"all"` (default): keep any `ws:`/`wss:` URL — same
 *                    behavior as previous SDK versions.
 *                  - `"public"`: drop URLs that can't be safely opened from
 *                    a browser page (non-`wss:`, loopback, RFC-1918, etc.).
 *                    Useful when feeding URLs to `new WebSocket(url)` under
 *                    a strict Content Security Policy.
 *                  - `(url) => boolean`: custom predicate.
 */
export function parseRelayList(event: Event, filter: RelayListFilter = "all"): RelayListEntry {
  const read = new Set<string>();
  const write = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== "r" || typeof tag[1] !== "string") continue;
    const url = tag[1];
    if (!shouldKeep(url, filter)) continue;
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
