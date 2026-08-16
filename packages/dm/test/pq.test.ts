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
} from "@nostr-wot/pq";
import {
  buildChatMessage,
  sealAndGiftWrap,
  unwrapGiftWrap,
  KIND_SEALED,
  KIND_GIFT_WRAP,
  type PqSealOptions,
  type PqUnwrapOptions,
} from "../src/index.js";

/** A full identity: secp256k1 key + signer + post-quantum keys. */
function identity() {
  const sk = generateSecretKey();
  return {
    sk,
    pk: getPublicKey(sk),
    signer: new PrivateKeySigner(sk),
    pq: derivePqKeys(crypto.getRandomValues(new Uint8Array(64)), 0),
  };
}

/** Build the `pq` seal option for `sealAndGiftWrap`/`sendDM` from raw identities. */
function sealOptionsFor(sender: ReturnType<typeof identity>, recipientPk: string, recipientKem: Uint8Array): PqSealOptions {
  return {
    kemPublicKey: recipientKem,
    conversationKey: nip44.v2.utils.getConversationKey(sender.sk, recipientPk),
  };
}

/** Build the `pq` unwrap option for `unwrapGiftWrap` from a raw recipient identity. */
function unwrapOptionsFor(recipient: ReturnType<typeof identity>): PqUnwrapOptions {
  return {
    kemSecretKey: recipient.pq.kem.secretKey,
    conversationKey: (counterparty) =>
      nip44.v2.utils.getConversationKey(recipient.sk, counterparty),
  };
}

describe("post-quantum sealing in @nostr-wot/dm", () => {
  it("round-trips a post-quantum message end to end through dm's own functions", async () => {
    const alice = identity();
    const bob = identity();

    const chatMessage = buildChatMessage(alice.pk, bob.pk, "hello, post-quantum bob");
    const wrap = await sealAndGiftWrap(alice.signer, bob.pk, chatMessage, {
      pq: sealOptionsFor(alice, bob.pk, bob.pq.kem.publicKey),
    });

    const { message, senderPubkey } = await unwrapGiftWrap(bob.signer, wrap, {
      pq: unwrapOptionsFor(bob),
    });

    expect(senderPubkey).toBe(alice.pk);
    expect(message.content).toBe("hello, post-quantum bob");
    expect(message.tags).toContainEqual(["p", bob.pk]);
  });

  it("cross-compat: sealed with @nostr-wot/dm, opened with @nostr-wot/pq", async () => {
    const alice = identity();
    const bob = identity();

    const chatMessage = buildChatMessage(alice.pk, bob.pk, "opened by the other package");
    const wrap = await sealAndGiftWrap(alice.signer, bob.pk, chatMessage, {
      pq: sealOptionsFor(alice, bob.pk, bob.pq.kem.publicKey),
    });

    const opened = openPqDirectMessage({
      wrap,
      recipientSecretKey: bob.sk,
      recipientKemSecretKey: bob.pq.kem.secretKey,
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
      recipientKemKey: bob.pq.kem.publicKey,
    });

    const { message, senderPubkey } = await unwrapGiftWrap(bob.signer, wrap, {
      pq: unwrapOptionsFor(bob),
    });

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
      { pq: sealOptionsFor(alice, bob.pk, bob.pq.kem.publicKey) },
    );

    // Same options object, no per-call flag distinguishing which is which.
    const bobOptions = { pq: unwrapOptionsFor(bob) };
    const opened1 = await unwrapGiftWrap(bob.signer, classicWrap, bobOptions);
    const opened2 = await unwrapGiftWrap(bob.signer, pqWrap, bobOptions);

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
      { pq: sealOptionsFor(alice, bob.pk, bob.pq.kem.publicKey) },
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

    await expect(
      unwrapGiftWrap(bob.signer, retamperedWrap, { pq: unwrapOptionsFor(bob) }),
    ).rejects.toThrow();
  });

  it("rejects a post-quantum rumor whose pubkey does not match the seal's signer", async () => {
    // Mallory honestly seals to bob with her own key, but the rumor inside claims
    // to be from alice. Only the authorship cross-check catches this.
    const alice = identity();
    const bob = identity();
    const mallory = identity();

    const rumor = buildChatMessage(alice.pk, bob.pk, "trust me, this is from alice");
    const conv = nip44.v2.utils.getConversationKey(mallory.sk, bob.pk);
    const payload = encryptPq(JSON.stringify(rumor), bob.pq.kem.publicKey, conv, {
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

    await expect(
      unwrapGiftWrap(bob.signer, wrap, { pq: unwrapOptionsFor(bob) }),
    ).rejects.toThrow();
  });

  it("fails closed when a post-quantum seal arrives but no pq options were supplied", async () => {
    const alice = identity();
    const bob = identity();

    const wrap = await sealAndGiftWrap(
      alice.signer,
      bob.pk,
      buildChatMessage(alice.pk, bob.pk, "needs pq options to open"),
      { pq: sealOptionsFor(alice, bob.pk, bob.pq.kem.publicKey) },
    );

    await expect(unwrapGiftWrap(bob.signer, wrap)).rejects.toThrow();
  });
});
