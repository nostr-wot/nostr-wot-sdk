/**
 * Collapse events received from multiple relays by ID, keeping the last
 * occurrence, then order newest first. Equal timestamps retain the order
 * in which their IDs first appeared. The input is never mutated.
 */
export function dedupeEventsNewestFirst<T extends { readonly id: string; readonly created_at: number }>(events: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const event of events) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => b.created_at - a.created_at);
}

/**
 * Rank `t` tags by the number of notes containing them, case-insensitively.
 * Repeated tags within one note count once; ties sort alphabetically.
 * Event verification and repeated-event removal belong to the caller.
 */
export function topHashtags(notes: readonly { readonly tags: readonly (readonly string[])[] }[], limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const note of notes) {
    const seen = new Set<string>();
    for (const tag of note.tags) {
      if (tag[0] !== "t" || !tag[1]) continue;
      const value = tag[1].toLowerCase();
      if (seen.has(value)) continue;
      seen.add(value);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag]) => tag);
}
