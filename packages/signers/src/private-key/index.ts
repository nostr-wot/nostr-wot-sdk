import {
  finalizeEvent,
  getPublicKey,
  nip04,
  nip44,
  type EventTemplate,
} from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils";
import type { NostrSigner } from "../types";

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

  constructor(sk: Uint8Array | string) {
    this.#sk = typeof sk === "string" ? hexToBytes(sk) : sk;
    if (this.#sk.length !== 32) {
      throw new Error("Private key must be 32 bytes");
    }
    this.#pk = getPublicKey(this.#sk);
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

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    const conv = nip44.v2.utils.getConversationKey(this.#sk, recipientPubkey);
    return nip44.v2.encrypt(plaintext, conv);
  }

  async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    const conv = nip44.v2.utils.getConversationKey(this.#sk, senderPubkey);
    return nip44.v2.decrypt(ciphertext, conv);
  }
}
