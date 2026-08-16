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
  derivePqKeys,
  createPqDirectMessage,
  openPqDirectMessage,
  encryptPq,
  toBase64,
} from "@nostr-wot/pq";
import {
  buildChatMessage,
  sealAndGiftWrap,
  unwrapGiftWrap,
  KIND_SEALED,
  KIND_GIFT_WRAP,
} from "../src/index.js";

/** A full identity: secp256k1 key + post-quantum-aware signer + raw pq keys. */
function identity() {
  const sk = generateSecretKey();
  const pqKem = derivePqKeys(crypto.getRandomValues(new Uint8Array(64)), 0).kem;
  return {
    sk,
    pk: getPublicKey(sk),
    pqKem,
    // Configured with our own ML-KEM keypair so this signer can also *receive*
    // post-quantum messages (nip44Decrypt auto-routes); sending never needs it.
    signer: new PrivateKeySigner(sk, { pqKem }),
  };
}

describe("post-quantum sealing in @nostr-wot/dm", () => {
  it("round-trips a post-quantum message end to end through dm's own functions", async () => {
    const alice = identity();
    const bob = identity();

    const chatMessage = buildChatMessage(alice.pk, bob.pk, "hello, post-quantum bob");
    const wrap = await sealAndGiftWrap(alice.signer, bob.pk, chatMessage, {
      pq: { scheme: "pq", recipientKemKey: toBase64(bob.pqKem.publicKey) },
    });

    // No pq option here — unwrapGiftWrap takes none; the signer auto-routes.
    const { message, senderPubkey } = await unwrapGiftWrap(bob.signer, wrap);

    expect(senderPubkey).toBe(alice.pk);
    expect(message.content).toBe("hello, post-quantum bob");
    expect(message.tags).toContainEqual(["p", bob.pk]);
  });

  it("cross-compat: sealed with @nostr-wot/dm, opened with @nostr-wot/pq", async () => {
    const alice = identity();
    const bob = identity();

    const chatMessage = buildChatMessage(alice.pk, bob.pk, "opened by the other package");
    const wrap = await sealAndGiftWrap(alice.signer, bob.pk, chatMessage, {
      pq: { scheme: "pq", recipientKemKey: toBase64(bob.pqKem.publicKey) },
    });

    const opened = openPqDirectMessage({
      wrap,
      recipientSecretKey: bob.sk,
      recipientKemSecretKey: bob.pqKem.secretKey,
    });

    expect(opened).not.toBeNull();
    expect(opened!.sender).toBe(alice.pk);
    expect(opened!.content).toBe("opened by the other package");
  });

  it("cross-compat: sealed with @nostr-wot/pq, opened with @nostr-wot/dm", async () => {
    const alice = identity();
    const bob = identity();

    const wrap = createPqDirectMessage({
      content: "sealed by the other package",
      senderSecretKey: alice.sk,
      recipientPubkey: bob.pk,
      recipientKemKey: bob.pqKem.publicKey,
    });

    const { message, senderPubkey } = await unwrapGiftWrap(bob.signer, wrap);

    expect(senderPubkey).toBe(alice.pk);
    expect(message.content).toBe("sealed by the other package");
  });

  it("unwraps a conversation mixing one classic and one post-quantum message, no caller flag", async () => {
    const alice = identity();
    const bob = identity();

    const classicWrap = await sealAndGiftWrap(
      alice.signer,
      bob.pk,
      buildChatMessage(alice.pk, bob.pk, "classic message"),
    );
    const pqWrap = await sealAndGiftWrap(
      alice.signer,
      bob.pk,
      buildChatMessage(alice.pk, bob.pk, "post-quantum message"),
      { pq: { scheme: "pq", recipientKemKey: toBase64(bob.pqKem.publicKey) } },
    );

    // Same signer, same call shape — unwrapGiftWrap takes no option that could
    // distinguish these.
    const opened1 = await unwrapGiftWrap(bob.signer, classicWrap);
    const opened2 = await unwrapGiftWrap(bob.signer, pqWrap);

    expect(opened1.message.content).toBe("classic message");
    expect(opened1.senderPubkey).toBe(alice.pk);
    expect(opened2.message.content).toBe("post-quantum message");
    expect(opened2.senderPubkey).toBe(alice.pk);
  });

  it("rejects a post-quantum seal with a corrupted signature", async () => {
    const alice = identity();
    const bob = identity();

    const wrap = await sealAndGiftWrap(
      alice.signer,
      bob.pk,
      buildChatMessage(alice.pk, bob.pk, "hello bob"),
      { pq: { scheme: "pq", recipientKemKey: toBase64(bob.pqKem.publicKey) } },
    );

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

  it("rejects a post-quantum rumor whose pubkey does not match the seal's signer", async () => {
    // Mallory honestly seals to bob with her own key, but the rumor inside claims
    // to be from alice. Only the authorship cross-check catches this.
    const alice = identity();
    const bob = identity();
    const mallory = identity();

    const rumor = buildChatMessage(alice.pk, bob.pk, "trust me, this is from alice");
    const conv = nip44.v2.utils.getConversationKey(mallory.sk, bob.pk);
    const payload = encryptPq(JSON.stringify(rumor), bob.pqKem.publicKey, conv, {
      sender: mallory.pk,
      recipient: bob.pk,
    });
    const seal = finalizeEvent(
      { kind: KIND_SEALED, created_at: Math.floor(Date.now() / 1000), tags: [], content: payload },
      mallory.sk,
    );
    const eph = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: KIND_GIFT_WRAP,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", bob.pk]],
        content: nip44.v2.encrypt(JSON.stringify(seal), nip44.v2.utils.getConversationKey(eph, bob.pk)),
      },
      eph,
    );

    await expect(unwrapGiftWrap(bob.signer, wrap)).rejects.toThrow();
  });

  it("fails closed when a post-quantum seal arrives but the signer has no ML-KEM key configured", async () => {
    const alice = identity();
    const bob = identity();
    const bobSignerNoKem = new PrivateKeySigner(bob.sk); // no pqKem option

    const wrap = await sealAndGiftWrap(
      alice.signer,
      bob.pk,
      buildChatMessage(alice.pk, bob.pk, "needs bob's KEM key to open"),
      { pq: { scheme: "pq", recipientKemKey: toBase64(bob.pqKem.publicKey) } },
    );

    await expect(unwrapGiftWrap(bobSignerNoKem, wrap)).rejects.toThrow();
  });
});
