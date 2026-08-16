import { describe, it, expect } from "vitest";
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip44,
  type Event,
} from "nostr-tools";
import { PrivateKeySigner } from "@nostr-wot/signers";
import {
  buildChatMessage,
  sealAndGiftWrap,
  unwrapGiftWrap,
  KIND_SEALED,
  KIND_GIFT_WRAP,
} from "../src/index.js";

function identity() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), signer: new PrivateKeySigner(sk) };
}

describe("unwrapGiftWrap", () => {
  it("round-trips a sealed message and returns the correct senderPubkey", async () => {
    const alice = identity();
    const bob = identity();

    const chatMessage = buildChatMessage(alice.pk, bob.pk, "hello bob");
    const wrap = await sealAndGiftWrap(alice.signer, bob.pk, chatMessage);

    const { message, senderPubkey } = await unwrapGiftWrap(bob.signer, wrap);

    expect(senderPubkey).toBe(alice.pk);
    // Shape consumed by cache/inbox.ts and cache/backfill.ts: id, content,
    // created_at, tags must all survive the round trip untouched.
    expect(message.id).toBeTruthy();
    expect(message.content).toBe("hello bob");
    expect(message.created_at).toBe(chatMessage.created_at);
    expect(message.tags).toContainEqual(["p", bob.pk]);
  });

  it("rejects a rumor whose pubkey does not match the seal's signer", async () => {
    // Alice honestly seals with her own key, but the rumor inside claims to be
    // authored by mallory. Only the authorship cross-check catches this — the
    // NIP-44 conversation-key binding alone does not.
    const alice = identity();
    const bob = identity();
    const mallory = identity();

    const rumor = {
      ...buildChatMessage(mallory.pk, bob.pk, "trust me, this is from mallory"),
    };

    const sealPlaintext = JSON.stringify({
      ...rumor,
      id: "0".repeat(64),
    });
    const sealContent = await alice.signer.nip44Encrypt!(bob.pk, sealPlaintext);
    const seal = await alice.signer.signEvent({
      kind: KIND_SEALED,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: sealContent,
    });

    const eph = generateSecretKey();
    const conv = nip44.v2.utils.getConversationKey(eph, bob.pk);
    const wrap = finalizeEvent(
      {
        kind: KIND_GIFT_WRAP,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", bob.pk]],
        content: nip44.v2.encrypt(JSON.stringify(seal), conv),
      },
      eph,
    );

    await expect(unwrapGiftWrap(bob.signer, wrap)).rejects.toThrow();
  });

  it("rejects a seal with a corrupted signature", async () => {
    const alice = identity();
    const bob = identity();

    const chatMessage = buildChatMessage(alice.pk, bob.pk, "hello bob");
    const wrap = await sealAndGiftWrap(alice.signer, bob.pk, chatMessage);

    // Decrypt the wrap ourselves, corrupt the seal's signature, and re-wrap it under
    // a fresh ephemeral key — simulating a relay or attacker tampering with the seal
    // in transit.
    const wrapPlaintext = await bob.signer.nip44Decrypt!(wrap.pubkey, wrap.content);
    const seal = JSON.parse(wrapPlaintext) as Event;
    const corruptedSeal: Event = {
      ...seal,
      sig: seal.sig.slice(0, -2) + (seal.sig.endsWith("00") ? "11" : "00"),
    };

    const eph = generateSecretKey();
    const conv = nip44.v2.utils.getConversationKey(eph, bob.pk);
    const retamperedWrap = finalizeEvent(
      {
        kind: KIND_GIFT_WRAP,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", bob.pk]],
        content: nip44.v2.encrypt(JSON.stringify(corruptedSeal), conv),
      },
      eph,
    );

    await expect(unwrapGiftWrap(bob.signer, retamperedWrap)).rejects.toThrow();
  });
});
