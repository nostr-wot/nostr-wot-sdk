import type { Event } from "nostr-tools";
import { fastNewest } from "../internal/sub";
import { DEFAULT_RELAYS, PROFILE_AGGREGATORS } from "../pool";
import { parseKind0, type ProfileEntry } from "../parsers/kind0";
import { relaysForAuthor } from "../outbox";

/**
 * Fetch a user's profile (kind 0). By default queries the union of:
 *   - PROFILE_AGGREGATORS (purplepag.es)
 *   - DEFAULT_RELAYS
 *   - the user's NIP-65 write relays (outbox)
 *
 * Pass `relays` to override; outbox lookup is skipped if you do.
 *
 * Returns null if no kind-0 event is found within the timeout.
 */
export async function fetchProfile(
  pubkey: string,
  relays?: string[],
): Promise<ProfileEntry | null> {
  const targetRelays = relays
    ? relays
    : [...new Set([
        ...PROFILE_AGGREGATORS,
        ...DEFAULT_RELAYS,
        ...(await relaysForAuthor(pubkey).catch(() => DEFAULT_RELAYS)),
      ])];
  const event = await fastNewest(targetRelays, { kinds: [0], authors: [pubkey] });
  return event ? parseKind0(event) : null;
}

/**
 * Streaming variant: subscribes to relays and calls `onUpdate` every
 * time a newer kind-0 event is received. Useful for SWR-style UIs that
 * want to refresh in place as fresher data arrives without waiting for
 * EOSE. Returns a teardown function.
 */
export function streamProfile(
  pubkey: string,
  onUpdate: (entry: ProfileEntry) => void,
  relays?: string[],
): () => void {
  let teardown = () => {};
  let cancelled = false;
  void (async () => {
    const targetRelays = relays
      ? relays
      : [...new Set([
          ...PROFILE_AGGREGATORS,
          ...DEFAULT_RELAYS,
          ...(await relaysForAuthor(pubkey).catch(() => DEFAULT_RELAYS)),
        ])];
    if (cancelled) return;

    let newest: Event | null = null;
    const { getPool } = await import("../pool");
    const sub = getPool().subscribeMany(targetRelays, { kinds: [0], authors: [pubkey] }, {
      onevent(event) {
        if (!newest || event.created_at > newest.created_at) {
          newest = event;
          onUpdate(parseKind0(event));
        }
      },
      oneose: () => undefined,
    });
    teardown = () => { try { sub.close(); } catch { /* noop */ } };
  })();
  return () => {
    cancelled = true;
    teardown();
  };
}
