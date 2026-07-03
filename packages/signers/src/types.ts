import type { Event, EventTemplate } from "nostr-tools";

/**
 * Common interface every signer implements. Designed to be a thin layer
 * over nostr-tools — `signEvent` returns a fully-formed signed Event,
 * matching `nostr-tools/finalizeEvent` output shape.
 */
export interface NostrSigner {
  /** Returns the signer's hex pubkey. */
  getPublicKey(): Promise<string>;

  /** Sign an event template, returning a finalized Event. */
  signEvent(template: EventTemplate): Promise<Event>;

  /** NIP-04 encrypt to `recipientPubkey`. Optional — not all signers
   *  support this. Throws if unsupported. */
  nip04Encrypt?(recipientPubkey: string, plaintext: string): Promise<string>;
  nip04Decrypt?(senderPubkey: string, ciphertext: string): Promise<string>;

  /** NIP-44 v2 encryption. Optional — modern preferred path. */
  nip44Encrypt?(recipientPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt?(senderPubkey: string, ciphertext: string): Promise<string>;

  /** Optional disposal hook — for signers that hold a connection
   *  (NIP-46) or extension permission. */
  close?(): Promise<void> | void;
}
