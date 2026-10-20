import {
  finalizeEvent,
  getPublicKey,
  nip04,
  nip44,
  type EventTemplate,
} from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils";
import {
  decryptPq,
  encryptPq,
  fromBase64,
  isPqEnvelope,
  type PqKeyPair,
} from "@nostr-wot/pq";
import type { NostrSigner } from "../types";

export interface PrivateKeySignerOptions {
  /**
   * This account's ML-KEM-1024 keypair, enabling post-quantum sealing
   * (`nip44Encrypt(..., { scheme: 'pq', ... })`) and auto-routed decryption of
   * post-quantum payloads. Derive it with `@nostr-wot/pq`'s `derivePqKeys` from
   * the account's BIP-39 seed — deliberately NOT from `sk` itself: deriving
   * post-quantum keys from the secp256k1 key would be circular (see
   * `@nostr-wot/pq`'s module doc). Without this, `nip44Encrypt` with a `pq` scheme
   * and `nip44Decrypt` of a post-quantum payload both throw.
   */
  pqKem?: PqKeyPair;
}

/**
 * Sign with a private key held in memory. Useful for tests, CLIs, and
 * any non-interactive context. Never expose the secret across UI
 * boundaries — for browser apps, prefer NIP-07 / NIP-46 / NIP-55.
 *
 * Accepts either a 32-byte Uint8Array or a 64-char hex string.
 */
export class PrivateKeySigner implements NostrSigner {
  readonly #sk: Uint8Array;
  readonly #pk: string;
  readonly #pqKem?: PqKeyPair;

  constructor(sk: Uint8Array | string, options: PrivateKeySignerOptions = {}) {
    this.#sk = typeof sk === "string" ? hexToBytes(sk) : sk;
    if (this.#sk.length !== 32) {
      throw new Error("Private key must be 32 bytes");
    }
    this.#pk = getPublicKey(this.#sk);
    this.#pqKem = options.pqKem;
  }

  async getPublicKey(): Promise<string> {
    return this.#pk;
  }

  async signEvent(template: EventTemplate) {
    return finalizeEvent(template, this.#sk);
  }

  async nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return nip04.encrypt(this.#sk, recipientPubkey, plaintext);
  }

  async nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    return nip04.decrypt(this.#sk, senderPubkey, ciphertext);
  }

  async nip44Encrypt(
    recipientPubkey: string,
    plaintext: string,
    opts?: { scheme: "pq"; recipientKemKey: string },
  ): Promise<string> {
    // Same conversation key either way — post-quantum mode feeds it into the
    // hybrid KDF instead of using it directly, exactly the layering
    // `@nostr-wot/pq`'s envelope was designed around.
    const conv = nip44.v2.utils.getConversationKey(this.#sk, recipientPubkey);
    if (opts?.scheme === "pq") {
      return encryptPq(plaintext, fromBase64(opts.recipientKemKey), conv, {
        sender: this.#pk,
        recipient: recipientPubkey,
      });
    }
    return nip44.v2.encrypt(plaintext, conv);
  }

  async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    const conv = nip44.v2.utils.getConversationKey(this.#sk, senderPubkey);
    if (isPqEnvelope(ciphertext)) {
      if (!this.#pqKem) {
        throw new Error(
          "PrivateKeySigner has no ML-KEM keypair configured; cannot decrypt a post-quantum payload",
        );
      }
      return decryptPq(ciphertext, this.#pqKem.secretKey, conv, {
        sender: senderPubkey,
        recipient: this.#pk,
      });
    }
    return nip44.v2.decrypt(ciphertext, conv);
  }
}
