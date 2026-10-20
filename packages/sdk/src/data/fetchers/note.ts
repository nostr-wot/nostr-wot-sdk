import { fastSingle } from "../internal/sub";
import { getDefaultRelays } from "../pool";

export type NoteEntry = {
  id: string;
  pubkey: string;
  content: string;
  createdAt: number;
  tags: string[][];
};

/**
 * Fetch a single Nostr event by id. Resolves on the first relay response
 * (event id is content-addressed, so any relay is correct). Returns null
 * if no relay had it within the timeout.
 *
 * `hintRelays` is taken from a NIP-19 `nevent`'s relay hint and queried
 * alongside defaults — the hint is often where the event was originally
 * published, especially for short-lived ephemeral kinds.
 */
export async function fetchNote(
  id: string,
  hintRelays: string[] = [],
): Promise<NoteEntry | null> {
  const relays = hintRelays.length > 0
    ? [...new Set([...hintRelays, ...getDefaultRelays()])]
    : getDefaultRelays();
  const event = await fastSingle(relays, { ids: [id] });
  if (!event) return null;
  return {
    id: event.id,
    pubkey: event.pubkey,
    content: event.content,
    createdAt: event.created_at,
    tags: event.tags,
  };
}
