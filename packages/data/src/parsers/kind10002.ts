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

/**
 * Drop relay URLs that browser pages can't safely connect to:
 *   - non-`wss:` schemes (CSP `connect-src` typically only allows `wss:`)
 *   - localhost / .local / .localhost hostnames
 *   - RFC-1918 / loopback / link-local IPv4 ranges
 *   - `0.0.0.0`, IPv6 loopback / link-local
 *
 * Useful when a parser feeds URLs into `new WebSocket(url)` from a page
 * with a strict Content Security Policy: a single bad URL would otherwise
 * trigger a CSP violation per page load and (worse) a noisy "WebSocket
 * connection failed" in DevTools.
 */
export function isPublicWssUrl(url: string): boolean {
  let p: URL;
  try {
    p = new URL(url);
  } catch {
    return false;
  }
  if (p.protocol !== "wss:") return false;
  const host = p.hostname.toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return false;
  if (host === "0.0.0.0" || host === "::1" || host.startsWith("fe80:")) return false;
  return true;
}

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
