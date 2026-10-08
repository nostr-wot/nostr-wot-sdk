import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from "nostr-tools";
import type { NostrSigner } from "@nostr-wot/signers";
import { sealAndGiftWrap, sealAndGiftWrapForSelf, unwrapGiftWrapForSelf } from "../src/index";

function identity(): { pubkey: string; signer: NostrSigner } {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return {
    pubkey,
    signer: {
      getPublicKey: async () => pubkey,
      signEvent: async (template) => finalizeEvent(template, secret),
      nip44Encrypt: async (recipient, plaintext) => nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(secret, recipient)),
      nip44Decrypt: async (sender, ciphertext) => nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(secret, sender)),
    },
  };
}

describe("self-addressed gift wraps", () => {
  it("round-trips private state while preserving its timestamp and randomizing the outer author", async () => {
    const { signer, pubkey } = identity();
    const template = { kind: 30078, content: '{"v":1}', created_at: 1234, tags: [["d", "private-state"]] };
    const wrapped = await sealAndGiftWrapForSelf(signer, template);
    expect(wrapped.kind).toBe(1059);
    expect(wrapped.tags).toEqual([["p", pubkey]]);
    expect(wrapped.pubkey).not.toBe(pubkey);
    expect(await unwrapGiftWrapForSelf(signer, wrapped)).toMatchObject({ ...template, pubkey });
  });

  it("supplies omitted tags and time without making caller policy decisions", async () => {
    const { signer } = identity();
    const before = Math.floor(Date.now() / 1000);
    const wrapped = await sealAndGiftWrapForSelf(signer, { kind: 30078, content: "state" });
    const rumor = await unwrapGiftWrapForSelf(signer, wrapped);
    expect(rumor?.tags).toEqual([]);
    expect(rumor?.created_at).toBeGreaterThanOrEqual(before);
  });

  it("ignores valid messages from another author in the same inbox", async () => {
    const alice = identity();
    const bob = identity();
    const wrapped = await sealAndGiftWrap(bob.signer, alice.pubkey, {
      pubkey: bob.pubkey, kind: 30078, content: "other author's state", created_at: 0, tags: [],
    });
    expect(await unwrapGiftWrapForSelf(alice.signer, wrapped)).toBeNull();
  });

  it("rejects authenticated seals containing a mismatched rumor author", async () => {
    const alice = identity();
    const bob = identity();
    const wrapped = await sealAndGiftWrap(alice.signer, alice.pubkey, {
      pubkey: bob.pubkey, kind: 30078, content: "false author", created_at: 0, tags: [],
    });
    expect(await unwrapGiftWrapForSelf(alice.signer, wrapped)).toBeNull();
  });

  it("returns null for another recipient and malformed envelopes", async () => {
    const alice = identity();
    const bob = identity();
    const wrapped = await sealAndGiftWrapForSelf(alice.signer, { kind: 30078, content: "private" });
    expect(await unwrapGiftWrapForSelf(bob.signer, wrapped)).toBeNull();
    expect(await unwrapGiftWrapForSelf(alice.signer, { ...wrapped, content: "bad ciphertext" })).toBeNull();
    expect(await unwrapGiftWrapForSelf(alice.signer, { ...wrapped, kind: 1 })).toBeNull();
  });
});
