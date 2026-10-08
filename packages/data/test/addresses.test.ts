import { describe, expect, it } from "vitest";
import { nip19 } from "nostr-tools";
import { npubToHex } from "../src/addresses";

describe("npubToHex", () => {
  const hex = "ab".repeat(32);
  it("decodes pasted hex, npub and nprofile identifiers", () => {
    expect(npubToHex(` ${hex.toUpperCase()} `)).toBe(hex);
    expect(npubToHex(nip19.npubEncode(hex))).toBe(hex);
    expect(npubToHex(nip19.nprofileEncode({ pubkey: hex }))).toBe(hex);
  });
  it("rejects names, invalid encodings and secret keys", () => {
    expect(npubToHex("bob")).toBeNull();
    expect(npubToHex("npub1broken")).toBeNull();
    expect(npubToHex(nip19.nsecEncode(new Uint8Array(32).fill(1)))).toBeNull();
  });
});
