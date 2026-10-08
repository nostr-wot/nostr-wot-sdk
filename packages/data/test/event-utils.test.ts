import { describe, expect, it } from "vitest";
import { dedupeEventsNewestFirst, topHashtags } from "../src/event-utils";

describe("dedupeEventsNewestFirst", () => {
  it("merges relay duplicates, preserves extra fields and leaves inputs unchanged", () => {
    const first = { id: "a", created_at: 1, content: "first" };
    const newer = { id: "b", created_at: 3, content: "newer" };
    const replacement = { id: "a", created_at: 1, content: "last" };
    const input = Object.freeze([first, newer, replacement]);
    const result = dedupeEventsNewestFirst(input);
    expect(result).toEqual([newer, replacement]);
    expect(result[1]).toBe(replacement);
    expect(input).toEqual([first, newer, replacement]);
  });

  it("preserves first ID encounter order for equal timestamps", () => {
    const first = { id: "a", created_at: 2 };
    const second = { id: "b", created_at: 2 };
    expect(dedupeEventsNewestFirst([first, second, first])).toEqual([first, second]);
    expect(dedupeEventsNewestFirst([])).toEqual([]);
  });
});

describe("topHashtags", () => {
  it("counts a case-folded tag once per note and ignores unrelated or empty tags", () => {
    const notes = [
      { tags: [["t", "Nostr"], ["t", "nostr"], ["t", "art"], ["p", "other"], ["t"], ["t", ""]] },
      { tags: [["t", "NOSTR"], ["t", "zaps"]] },
    ];
    expect(topHashtags(notes)).toEqual(["nostr", "art", "zaps"]);
    expect(topHashtags(notes, 1)).toEqual(["nostr"]);
    expect(topHashtags(notes, 0)).toEqual([]);
  });

  it("accepts immutable tags and defaults to at most eight results", () => {
    expect(topHashtags([{ tags: [["t", "Nostr"]] }] as const)).toEqual(["nostr"]);
    expect(topHashtags([{ tags: Array.from({ length: 10 }, (_, n) => ["t", `tag${n}`]) }])).toHaveLength(8);
    expect(topHashtags([])).toEqual([]);
  });
});
