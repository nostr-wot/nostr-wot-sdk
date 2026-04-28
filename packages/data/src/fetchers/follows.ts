import { fastNewest } from "../internal/sub";
import { relaysForAuthor } from "../outbox";

export type FollowsEntry = {
  pubkey: string;
  follows: string[];
  fetchedAt: number;
};

/**
 * Fetch a user's follow list (kind 3). Returns null if the user has no
 * published kind-3 yet. The list is deduplicated.
 */
export async function fetchFollows(
  pubkey: string,
  relays?: string[],
): Promise<FollowsEntry | null> {
  const targetRelays = relays ?? (await relaysForAuthor(pubkey).catch(() => undefined));
  if (!targetRelays || targetRelays.length === 0) return null;
  const event = await fastNewest(targetRelays, { kinds: [3], authors: [pubkey] });
  if (!event) return null;
  const follows: string[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== "p") continue;
    const pk = tag[1];
    if (typeof pk !== "string" || pk.length === 0 || seen.has(pk)) continue;
    seen.add(pk);
    follows.push(pk);
  }
  return { pubkey: event.pubkey, follows, fetchedAt: Date.now() };
}
