import type { Event } from "nostr-tools";
import { fastCollect } from "../internal/sub";
import { getDefaultRelays } from "../pool";
import { parseZapMsats } from "../parsers/kind9735";

export type Engagement = {
  reactionCount: number;
  repostCount: number;
  zapTotalSats: number;
};

const empty = (): Engagement => ({ reactionCount: 0, repostCount: 0, zapTotalSats: 0 });

/**
 * Fetch reactions (kind 7), reposts (kind 6), and zap-receipt totals
 * (kind 9735) for a batch of note ids in three parallel relay subs.
 *
 * Returns Map<noteId, Engagement>. Notes with no engagement get a zero
 * entry. Reactions with content "-" (downvotes) are ignored.
 */
export async function fetchEngagement(
  noteIds: string[],
  relays: string[] = getDefaultRelays(),
): Promise<Map<string, Engagement>> {
  const out = new Map<string, Engagement>();
  for (const id of noteIds) out.set(id, empty());
  if (noteIds.length === 0) return out;

  const bump = (id: string, key: keyof Engagement, by: number) => {
    const cur = out.get(id) ?? empty();
    out.set(id, { ...cur, [key]: cur[key] + by });
  };

  await Promise.all([
    fastCollect(relays, { kinds: [7], "#e": noteIds }, {
      onEvent(e: Event) {
        if (e.content === "-") return;
        const tag = e.tags.find((t) => t[0] === "e" && t[1] && noteIds.includes(t[1]));
        if (tag?.[1]) bump(tag[1], "reactionCount", 1);
      },
    }),
    fastCollect(relays, { kinds: [6], "#e": noteIds }, {
      onEvent(e: Event) {
        const tag = e.tags.find((t) => t[0] === "e" && t[1] && noteIds.includes(t[1]));
        if (tag?.[1]) bump(tag[1], "repostCount", 1);
      },
    }),
    fastCollect(relays, { kinds: [9735], "#e": noteIds }, {
      onEvent(e: Event) {
        const tag = e.tags.find((t) => t[0] === "e" && t[1] && noteIds.includes(t[1]));
        if (!tag?.[1]) return;
        const msats = parseZapMsats(e);
        if (msats > 0) bump(tag[1], "zapTotalSats", Math.floor(msats / 1000));
      },
    }),
  ]);

  return out;
}
