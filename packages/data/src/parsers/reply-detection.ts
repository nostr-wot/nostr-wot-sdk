/**
 * NIP-10 reply detection. Returns the parent event id if `tags` indicates
 * a reply (preferring the `reply` marker, falling back to `root`, and
 * finally to the last `e` tag for events that predate NIP-10 markers).
 */
export function findReplyParentId(tags: string[][]): string | null {
  const eTags = tags.filter((t) => t[0] === "e");
  if (eTags.length === 0) return null;
  const reply = eTags.find((t) => t[3] === "reply");
  const root = eTags.find((t) => t[3] === "root");
  return (reply ?? root ?? eTags[eTags.length - 1])?.[1] ?? null;
}

/**
 * Returns the root event id (top of the thread) if present, else null.
 * For non-replies, returns null. For root-only replies, the root id is
 * the immediate parent.
 */
export function findRootEventId(tags: string[][]): string | null {
  const eTags = tags.filter((t) => t[0] === "e");
  if (eTags.length === 0) return null;
  const root = eTags.find((t) => t[3] === "root");
  return root?.[1] ?? null;
}
