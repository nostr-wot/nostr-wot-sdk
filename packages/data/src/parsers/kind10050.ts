import type { Event } from "nostr-tools";
import { isPublicWssUrl, type RelayListFilter } from "./kind10002";

function shouldKeep(url: string, filter: RelayListFilter): boolean {
  if (filter === "all") return url.startsWith("ws");
  if (filter === "public") return isPublicWssUrl(url);
  return filter(url);
}

/**
 * Parse a kind-10050 (NIP-17 DM-inbox relays) event into a deduped URL list.
 *
 * Accepts both `relay` and `r` tag names for compatibility with clients
 * that publish either form. Same `filter` parameter as `parseRelayList`:
 *   - `"all"` (default): keep any `ws:`/`wss:` URL.
 *   - `"public"`: drop loopback / RFC-1918 / non-`wss:` URLs that a strict
 *     browser CSP would reject.
 *   - `(url) => boolean`: custom predicate.
 */
export function parseInboxRelayList(event: Event, filter: RelayListFilter = "all"): string[] {
  const out = new Set<string>();
  for (const tag of event.tags) {
    if ((tag[0] === "relay" || tag[0] === "r") && typeof tag[1] === "string") {
      if (shouldKeep(tag[1], filter)) out.add(tag[1]);
    }
  }
  return [...out];
}
