import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, nip44 } from "nostr-tools";
import { derivePqKeys, decryptPq, isPqEnvelope, toBase64 } from "@nostr-wot/pq";
import { PrivateKeySigner } from "../src/index.js";

function identity() {
  const sk = generateSecretKey();
  return {
    sk,
    pk: getPublicKey(sk),
    pqKem: derivePqKeys(crypto.getRandomValues(new Uint8Array(64)), 0).kem,
  };
}

describe("PrivateKeySigner — classic NIP-44 (regression)", () => {
  it("round-trips plain NIP-44 ciphertext with no opts", async () => {
    const alice = identity();
    const bob = identity();
    const aliceSigner = new PrivateKeySigner(alice.sk);
    const bobSigner = new PrivateKeySigner(bob.sk);

    const ciphertext = await aliceSigner.nip44Encrypt(bob.pk, "hello bob");
    expect(isPqEnvelope(ciphertext)).toBe(false);

    const plaintext = await bobSigner.nip44Decrypt(alice.pk, ciphertext);
    expect(plaintext).toBe("hello bob");
  });
});

describe("PrivateKeySigner — post-quantum sealing", () => {
  it("encrypts with scheme 'pq' and the same signer auto-routes decryption", async () => {
    const alice = identity();
    const bob = identity();
    const aliceSigner = new PrivateKeySigner(alice.sk);
    const bobSigner = new PrivateKeySigner(bob.sk, { pqKem: bob.pqKem });

    const ciphertext = await aliceSigner.nip44Encrypt(bob.pk, "hello, post-quantum bob", {
      scheme: "pq",
      recipientKemKey: toBase64(bob.pqKem.publicKey),
    });
    expect(isPqEnvelope(ciphertext)).toBe(true);

    // No flag on decrypt — nip44Decrypt auto-detects the envelope.
    const plaintext = await bobSigner.nip44Decrypt(alice.pk, ciphertext);
    expect(plaintext).toBe("hello, post-quantum bob");
  });

  it("produces the exact envelope @nostr-wot/pq's decryptPq expects (byte compatibility)", async () => {
    const alice = identity();
    const bob = identity();
    const aliceSigner = new PrivateKeySigner(alice.sk);

    const ciphertext = await aliceSigner.nip44Encrypt(bob.pk, "cross-package check", {
      scheme: "pq",
      recipientKemKey: toBase64(bob.pqKem.publicKey),
    });

    const conversationKey = nip44.v2.utils.getConversationKey(bob.sk, alice.pk);
    const plaintext = decryptPq(ciphertext, bob.pqKem.secretKey, conversationKey, {
      sender: alice.pk,
      recipient: bob.pk,
    });
    expect(plaintext).toBe("cross-package check");
  });

  it("nip44Decrypt throws on a post-quantum payload when no pqKem was configured", async () => {
    const alice = identity();
    const bob = identity();
    const aliceSigner = new PrivateKeySigner(alice.sk);
    // Bob's signer is missing the pqKem option this time.
    const bobSignerNoKem = new PrivateKeySigner(bob.sk);

    const ciphertext = await aliceSigner.nip44Encrypt(bob.pk, "needs bob's KEM key", {
      scheme: "pq",
      recipientKemKey: toBase64(bob.pqKem.publicKey),
    });

    await expect(bobSignerNoKem.nip44Decrypt(alice.pk, ciphertext)).rejects.toThrow();
  });

  it("a mixed conversation (one classic, one post-quantum) decrypts correctly with no per-call flag", async () => {
    const alice = identity();
    const bob = identity();
    const aliceSigner = new PrivateKeySigner(alice.sk);
    const bobSigner = new PrivateKeySigner(bob.sk, { pqKem: bob.pqKem });

    const classicCt = await aliceSigner.nip44Encrypt(bob.pk, "classic message");
    const pqCt = await aliceSigner.nip44Encrypt(bob.pk, "pq message", {
      scheme: "pq",
      recipientKemKey: toBase64(bob.pqKem.publicKey),
    });

    expect(await bobSigner.nip44Decrypt(alice.pk, classicCt)).toBe("classic message");
    expect(await bobSigner.nip44Decrypt(alice.pk, pqCt)).toBe("pq message");
  });
});
